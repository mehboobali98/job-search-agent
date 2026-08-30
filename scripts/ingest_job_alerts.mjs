import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { candidateIdentityKeys } from "./job_tracker_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { assertSanitizedJobAlertProposal, ingestJobAlertBatch, MAX_JOB_ALERT_BATCH_BYTES } from "./job_alert_ingestion_lib.mjs";
import { removeWorkbookInspection } from "./workbook_io.mjs";

function safeId(value) {
  const text = String(value ?? "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!text) throw new Error("Proposal ID cannot be converted to a safe filename");
  return text;
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicReplace(filePath, text) {
  const temporaryPath = filePath + `.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, text, { flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadTrackerIdentityKeys(workbookPath) {
  const keys = new Set();
  try {
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
    const table = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable");
    for (const row of table.getDataRows()) {
      if (!row[0]) continue;
      for (const key of candidateIdentityKeys({
        company: row[3], title: row[4], location: row[5], canonical_url: row[8], job_id: row[9],
      })) keys.add(key);
      if (row[28]) keys.add(String(row[28]));
    }
    return keys;
  } finally {
    await removeWorkbookInspection(workbookPath).catch(() => {});
  }
}

export async function applyJobAlertProposal({
  proposal,
  stateDirectory,
  beforePromote = async () => {},
} = {}) {
  assertSanitizedJobAlertProposal(proposal);
  const absoluteState = path.resolve(stateDirectory);
  const proposalId = safeId(proposal.proposal_id);
  const ingestionDirectory = path.join(absoluteState, "job-alert-ingestion");
  const targetPath = path.join(ingestionDirectory, `${proposalId}.proposal.json`);
  const pendingPath = path.join(absoluteState, `pending-job-alert-${proposalId}.json`);
  const contents = JSON.stringify(proposal, null, 2) + "\n";
  await fs.mkdir(ingestionDirectory, { recursive: true });
  if (await fileExists(targetPath)) {
    const existing = await fs.readFile(targetPath, "utf8");
    if (existing !== contents) throw new Error("A different sanitized proposal already exists for this proposal ID");
    await fs.rm(pendingPath, { force: true });
    return { applied: true, already_applied: true, proposal_path: targetPath, pending_marker: null };
  }

  const stagedPath = targetPath + `.staged-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(stagedPath, contents, { flag: "wx" });
    await beforePromote({ stagedPath, targetPath });
    await fs.rename(stagedPath, targetPath);
    await fs.rm(pendingPath, { force: true });
    return { applied: true, already_applied: false, proposal_path: targetPath, pending_marker: null };
  } catch (error) {
    await fs.rm(stagedPath, { force: true });
    const marker = {
      schema_version: 1,
      workflow: "job_alert_ingestion",
      created_at: new Date().toISOString(),
      proposal,
      error: String(error?.stack ?? error),
    };
    const markerText = JSON.stringify(marker, null, 2) + "\n";
    await fs.mkdir(absoluteState, { recursive: true });
    await atomicReplace(pendingPath, markerText);
    error.pending_marker = pendingPath;
    throw error;
  }
}

export async function recoverJobAlertProposal({ markerPath, stateDirectory = null } = {}) {
  const absoluteMarker = path.resolve(markerPath);
  const marker = JSON.parse(await fs.readFile(absoluteMarker, "utf8"));
  if (marker.workflow !== "job_alert_ingestion" || !marker.proposal) throw new Error("Recovery marker is not a job-alert ingestion marker");
  const result = await applyJobAlertProposal({
    proposal: assertSanitizedJobAlertProposal(marker.proposal),
    stateDirectory: stateDirectory ?? path.dirname(absoluteMarker),
  });
  await fs.rm(absoluteMarker, { force: true });
  return { ...result, recovered: true };
}

export async function runJobAlertIngestion({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  inputPath = null,
  apply = false,
  recoverPath = null,
  now = null,
} = {}) {
  const config = await loadProjectConfig({ projectRoot, configPath });
  if (!config.gmailJobAlerts.enabled) {
    return {
      schema_version: 1,
      mode: apply ? "apply" : "preview",
      enabled: false,
      applied: false,
      persistent_state_written: false,
      message: "Gmail job-alert ingestion is disabled in local configuration.",
    };
  }
  if (recoverPath) {
    if (!apply) throw new Error("Job-alert recovery requires --apply");
    return {
      schema_version: 1,
      mode: "apply",
      enabled: config.gmailJobAlerts.enabled,
      recovery: await recoverJobAlertProposal({ markerPath: recoverPath, stateDirectory: config.stateDirectory }),
    };
  }
  if (!inputPath) throw new Error("Enabled job-alert ingestion requires --input <private-batch.json>");
  const absoluteInput = path.resolve(inputPath);
  if ((await fs.stat(absoluteInput)).size > MAX_JOB_ALERT_BATCH_BYTES) {
    throw new Error(`Private job-alert batch exceeds the ${MAX_JOB_ALERT_BATCH_BYTES}-byte input limit`);
  }
  const batch = JSON.parse(await fs.readFile(absoluteInput, "utf8"));
  const existingIdentityKeys = await loadTrackerIdentityKeys(config.trackerPath);
  const proposal = ingestJobAlertBatch(batch, { config: config.gmailJobAlerts, existingIdentityKeys, now });
  const persistence = apply
    ? await applyJobAlertProposal({ proposal, stateDirectory: config.stateDirectory })
    : { applied: false, already_applied: false, proposal_path: null, pending_marker: null };
  return {
    schema_version: 1,
    mode: apply ? "apply" : "preview",
    enabled: true,
    persistent_state_written: apply,
    proposal,
    persistence,
  };
}

async function main() {
  const result = await runJobAlertIngestion({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    inputPath: argumentValue(process.argv, "--input"),
    recoverPath: argumentValue(process.argv, "--recover"),
    apply: process.argv.includes("--apply"),
    now: argumentValue(process.argv, "--now"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ schema_version: 1, applied: false, error: String(error?.message ?? error), pending_marker: error?.pending_marker ?? null }, null, 2));
    process.exitCode = 1;
  });
}
