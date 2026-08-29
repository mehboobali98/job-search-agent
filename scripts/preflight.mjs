import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eligibilityRegistrySnapshot, validateEligibilityRegistry } from "./eligibility_evidence_lib.mjs";
import { inspectCandidateProfile, inspectResumeInventory, summarizePreflight } from "./preflight_lib.mjs";
import { argumentValue, CURRENT_CONFIG_VERSION, loadProjectConfig } from "./project_config.mjs";
import { validateSearchTerms } from "./search_query_lib.mjs";
import { inspectTrackerContract } from "./tracker_contract.mjs";
import { removeWorkbookInspection } from "./workbook_io.mjs";

function check(id, status, message, remediation = null) {
  return { id, status, message, remediation };
}

async function directoryEntries(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    isFile: entry.isFile(),
    size: entry.isFile() ? (await fs.stat(path.join(directory, entry.name))).size : 0,
  })));
}

export async function runPreflight({ projectRoot = process.cwd(), configPath = ".job-search.local.json" } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(nodeMajor >= 20
    ? check("node-runtime", "Passed", `Node ${process.versions.node} is supported.`)
    : check("node-runtime", "Failed", `Node ${process.versions.node} is unsupported.`, "Install Node 20 or newer."));

  let artifact = null;
  try {
    artifact = await import("@oai/artifact-tool");
    checks.push(check("artifact-tool", "Passed", "Workbook dependency is available."));
  } catch {
    checks.push(check("artifact-tool", "Failed", "Workbook dependency is unavailable.", "Run this project in Codex with the bundled workspace dependencies available."));
  }

  let config;
  try {
    config = await loadProjectConfig({ projectRoot, configPath });
    checks.push(config.raw.version === CURRENT_CONFIG_VERSION
      ? check("local-config", "Passed", `Local configuration is current at version ${CURRENT_CONFIG_VERSION}.`)
      : check("local-config", "Warning", `Local configuration version ${config.raw.version} is supported but not current.`, "Run `npm run upgrade-config` to preview, then add `-- --apply` to apply."));
  } catch (error) {
    checks.push(check("local-config", "Failed", "Local configuration could not be loaded.", error.message));
    return { schema_version: 1, checked_at: new Date().toISOString(), ...summarizePreflight(checks) };
  }

  if (artifact) {
    try {
      const workbook = await artifact.SpreadsheetFile.importXlsx(await artifact.FileBlob.load(config.trackerPath));
      const contract = inspectTrackerContract(workbook);
      checks.push(contract.valid
        ? check("tracker-schema", "Passed", `Tracker has all ${contract.core_sheet_count} core sheets, ${contract.detail_sheet_count} referenced detail sheet(s), and current table schemas.`)
        : check("tracker-schema", "Failed", "Tracker schema does not match this release.", "Run `npm run migrate-tracker` after backing up the workbook."));
    } catch (error) {
      checks.push(check("tracker-schema", "Failed", "Tracker workbook could not be validated.", error.message));
    } finally {
      await removeWorkbookInspection(config.trackerPath).catch(() => {});
    }
  } else {
    checks.push(check("tracker-schema", "Failed", "Tracker schema check was skipped because the workbook dependency is unavailable.", "Restore the workbook dependency and rerun preflight."));
  }

  let profileInspection = null;
  try {
    profileInspection = inspectCandidateProfile(await fs.readFile(config.candidateProfilePath, "utf8"));
    checks.push(profileInspection.valid
      ? check("candidate-profile", "Passed", `Candidate profile contains ${profileInspection.evidence_id_count} unique stable evidence IDs and no template placeholders.`)
      : check("candidate-profile", "Failed", "Candidate profile is incomplete or has unstable evidence identifiers.", "Replace every template placeholder and keep unique stable IDs for all required evidence sections."));
  } catch (error) {
    checks.push(check("candidate-profile", "Failed", "Candidate profile could not be validated.", error.message));
  }

  try {
    const inspection = inspectResumeInventory(profileInspection ?? { inventory: {} }, await directoryEntries(config.resumesDirectory));
    checks.push(inspection.valid
      ? check("resume-inventory", "Passed", `${inspection.supported_file_count} supported resume files cover all required resume variants.`)
      : check("resume-inventory", "Failed", "Resume inventory is incomplete or references missing/unsupported files.", "Add PDF or DOCX files for all five resume variants and list their exact filenames in the candidate profile."));
  } catch (error) {
    checks.push(check("resume-inventory", "Failed", "Resume directory could not be validated.", error.message));
  }

  try {
    validateSearchTerms(JSON.parse(await fs.readFile(config.searchTermsPath, "utf8")));
    checks.push(check("search-terms", "Passed", "Search terms and role-family coverage are valid."));
  } catch (error) {
    checks.push(check("search-terms", "Failed", "Search terms could not be validated.", error.message));
  }

  try {
    const raw = validateEligibilityRegistry(JSON.parse(await fs.readFile(config.eligibilityEvidencePath, "utf8")));
    const snapshot = eligibilityRegistrySnapshot(raw);
    checks.push(snapshot.warnings.length
      ? check("eligibility-evidence", "Warning", `Eligibility registry is valid with ${snapshot.warnings.length} expired or superseded entries.`, "Review stale entries before relying on them.")
      : check("eligibility-evidence", "Passed", "Eligibility evidence registry is valid and current."));
  } catch (error) {
    checks.push(check("eligibility-evidence", "Failed", "Eligibility evidence registry could not be validated.", error.message));
  }

  for (const [id, directory] of [["state-directory", config.stateDirectory], ["application-packages-directory", config.applicationPackagesDirectory]]) {
    try {
      await fs.access(directory, fs.constants.R_OK | fs.constants.W_OK);
      checks.push(check(id, "Passed", `${id === "state-directory" ? "State" : "Application packages"} directory is readable and writable.`));
    } catch (error) {
      checks.push(check(id, "Failed", `${id === "state-directory" ? "State" : "Application packages"} directory is unavailable.`, error.message));
    }
  }

  try {
    const pending = (await fs.readdir(config.stateDirectory)).filter((name) => /^pending(?:[.-].*)?\.json$/i.test(name));
    checks.push(pending.length
      ? check("pending-recovery", "Warning", `${pending.length} unresolved pending recovery marker(s) exist.`, "Run `npm run pending` to inspect recovery guidance before the next write.")
      : check("pending-recovery", "Passed", "No unresolved pending recovery markers exist."));
  } catch (error) {
    checks.push(check("pending-recovery", "Failed", "Pending recovery markers could not be inspected.", error.message));
  }

  return { schema_version: 1, checked_at: new Date().toISOString(), ...summarizePreflight(checks) };
}

async function main() {
  const result = await runPreflight({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ schema_version: 1, ready: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
