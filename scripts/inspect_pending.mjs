import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { pendingChecksum, pendingMarkerSummary } from "./pending_recovery_lib.mjs";

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export async function inspectPending({ stateDirectory, workbookPath = null, eligibilityRegistryPath = null, packagesDirectory = null, marker = null, extractPath = null, retentionDays = 30 } = {}) {
  const stateDir = path.resolve(stateDirectory);
  let names = (await fs.readdir(stateDir)).filter((name) => /^pending(?:[.-].*)?\.json$/i.test(name)).sort();
  if (marker) {
    const requested = path.basename(marker);
    names = names.filter((name) => name === requested);
    if (names.length !== 1) throw new Error("Pending marker was not found in the configured state directory: " + requested);
  }
  if (extractPath && names.length !== 1) throw new Error("--extract requires exactly one --marker");
  const markers = [];
  let extracted = null;
  for (const name of names) {
    const filePath = path.join(stateDir, name);
    const text = await fs.readFile(filePath, "utf8");
    const raw = JSON.parse(text);
    const stat = await fs.stat(filePath);
    const summary = pendingMarkerSummary({ filePath, text, raw, stat, stateDirectory: stateDir, workbookPath, eligibilityRegistryPath, packagesDirectory, retentionDays });
    markers.push(summary);
    if (extractPath) {
      const key = summary.recovery.extraction_key;
      if (!key || raw[key] === undefined) throw new Error("This pending marker does not contain an extractable replay payload");
      const output = path.resolve(extractPath);
      if (!inside(stateDir, output)) throw new Error("Extracted recovery payload must stay inside the configured state directory");
      await fs.mkdir(path.dirname(output), { recursive: true });
      const serialized = JSON.stringify(raw[key], null, 2) + "\n";
      await fs.writeFile(output, serialized, { flag: "wx" });
      extracted = { path: output, checksum_sha256: pendingChecksum(serialized), source_marker_checksum_sha256: summary.checksum_sha256 };
    }
  }
  return {
    schema_version: 1,
    inspected_at: new Date().toISOString(),
    state_directory: stateDir,
    marker_count: markers.length,
    markers,
    extracted,
    destructive_actions_taken: false,
  };
}

async function main() {
  const explicitState = argumentValue(process.argv, "--state-dir");
  const config = explicitState ? null : await loadProjectConfig();
  const result = await inspectPending({
    stateDirectory: explicitState ?? config.stateDirectory,
    workbookPath: argumentValue(process.argv, "--workbook", config?.trackerPath),
    eligibilityRegistryPath: argumentValue(process.argv, "--eligibility-registry", config?.eligibilityEvidencePath),
    packagesDirectory: argumentValue(process.argv, "--packages-dir", config?.applicationPackagesDirectory),
    marker: argumentValue(process.argv, "--marker"),
    extractPath: argumentValue(process.argv, "--extract"),
    retentionDays: Number(argumentValue(process.argv, "--retention-days", config?.reliability.pending_retention_days ?? 30)),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
