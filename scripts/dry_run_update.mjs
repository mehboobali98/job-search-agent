import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { resolveXlsxWorkbookPath } from "./workbook_io.mjs";

async function fileChecksum(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function compactResult(result) {
  const outcomeCounts = {};
  for (const item of result.outcomes ?? []) outcomeCounts[item.outcome] = (outcomeCounts[item.outcome] ?? 0) + 1;
  return {
    run_id: result.run_id,
    outcome_counts: outcomeCounts,
    affected_lead_ids: [...new Set((result.outcomes ?? []).map((item) => item.lead_id).filter(Boolean))],
    review_count: (result.reviews ?? []).length,
    alert_lead_ids: (result.alerts ?? []).map((item) => item.lead_id).filter(Boolean),
    action_count: Number(result.actions?.total ?? result.actions?.actions?.length ?? 0),
    diagnostics: result.diagnostics ?? null,
    replay: result.replay ?? null,
  };
}

function parseTrailingJson(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.lastIndexOf("\n{");
  return JSON.parse(start >= 0 ? text.slice(start + 1) : text);
}

export async function dryRunUpdate({ workbookPath, inputPath, eligibilityRegistryPath = null } = {}) {
  const sourceWorkbook = resolveXlsxWorkbookPath(workbookPath, "--workbook");
  const sourceInput = path.resolve(inputPath);
  const sourceChecksum = await fileChecksum(sourceWorkbook);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "job-search-dry-run-"));
  const temporaryWorkbook = path.join(temporaryDirectory, "Tracker.xlsx");
  const temporaryState = path.join(temporaryDirectory, "state");
  await fs.copyFile(sourceWorkbook, temporaryWorkbook);
  let child;
  try {
    const updater = path.join(path.dirname(fileURLToPath(import.meta.url)), "update_tracker.mjs");
    const args = [updater, "--workbook", temporaryWorkbook, "--input", sourceInput, "--state-dir", temporaryState];
    if (eligibilityRegistryPath) args.push("--eligibility-registry", path.resolve(eligibilityRegistryPath));
    child = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const unchanged = (await fileChecksum(sourceWorkbook)) === sourceChecksum;
    if (!unchanged) throw new Error("The source workbook changed during dry-run execution");
    let proposedResult = null;
    if (child.status === 0) proposedResult = compactResult(parseTrailingJson(child.stdout));
    return {
      schema_version: 1,
      dry_run: true,
      valid: child.status === 0,
      workbook_unchanged: unchanged,
      source_workbook_checksum_sha256: sourceChecksum,
      proposed_result: proposedResult,
      validation_error: child.status === 0 ? null : String(child.stderr || child.error || "Dry-run updater failed").split(/\r?\n/, 1)[0].slice(0, 500),
      persistent_state_written: false,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const explicitWorkbook = argumentValue(process.argv, "--workbook");
  const inputPath = argumentValue(process.argv, "--input");
  if (!inputPath) throw new Error("Usage: node scripts/dry_run_update.mjs --input <run.json> [--workbook <xlsx>] [--eligibility-registry <json>]");
  const config = explicitWorkbook ? null : await loadProjectConfig();
  const result = await dryRunUpdate({
    workbookPath: explicitWorkbook ?? config.trackerPath,
    inputPath,
    eligibilityRegistryPath: argumentValue(process.argv, "--eligibility-registry", config?.eligibilityEvidencePath),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
