import path from "node:path";
import { eligibilityRegistrySnapshot, loadEligibilityRegistry } from "./eligibility_evidence_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
const config = await loadProjectConfig({ projectRoot, configPath: argumentValue(process.argv, "--config", ".job-search.local.json") });
const registryPath = path.resolve(argumentValue(process.argv, "--registry", config.eligibilityEvidencePath));
const asOf = argumentValue(process.argv, "--as-of", new Date().toISOString().slice(0, 10));
let missing = false;
let registry;
try {
  registry = await loadEligibilityRegistry(registryPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  missing = true;
  registry = { version: 1, entries: [] };
}
const snapshot = eligibilityRegistrySnapshot(registry, { asOf });
console.log(JSON.stringify({
  registry_path: path.relative(config.projectRoot, registryPath) || path.basename(registryPath),
  missing,
  ...snapshot,
  warnings: [
    ...(missing ? ["Eligibility evidence registry is missing; no registry evidence may be used for this run."] : []),
    ...snapshot.warnings,
  ],
}, null, 2));
