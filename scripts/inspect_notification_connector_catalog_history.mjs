import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES,
  validateNotificationConnectorCapabilityCatalog,
} from "./notification_connector_discovery.mjs";
import { buildNotificationConnectorCatalogHistoryReport } from "./notification_connector_catalog_history.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function contained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function requireCatalogDirectory(directory, stateDirectory) {
  const state = path.resolve(stateDirectory);
  const target = path.resolve(directory);
  const [stateStat, targetStat] = await Promise.all([fs.lstat(state), fs.lstat(target)]);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Connector catalog history state directory must be a regular private directory");
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("Connector catalog history directory must be a regular private directory");
  }
  const [realState, realTarget] = await Promise.all([fs.realpath(state), fs.realpath(target)]);
  if (!contained(realTarget, realState)) throw new Error("Connector catalog history directory cannot escape private state");
  return target;
}

async function readCatalog(filePath, directory, label) {
  const absolute = path.resolve(filePath);
  if (!contained(absolute, directory)) throw new Error(`${label} must remain under the configured private catalog directory`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES) {
    throw new Error(`${label} must be a regular file no larger than ${MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES} bytes`);
  }
  const [realFile, realDirectory] = await Promise.all([fs.realpath(absolute), fs.realpath(directory)]);
  if (!contained(realFile, realDirectory)) throw new Error(`${label} cannot escape private state through a symbolic link`);
  const value = JSON.parse(await fs.readFile(absolute, "utf8"));
  validateNotificationConnectorCapabilityCatalog(value);
  if (path.basename(absolute) !== `${value.catalog_id}.catalog.json`) {
    throw new Error(`${label} filename does not match catalog_id`);
  }
  return value;
}

export async function runNotificationConnectorCatalogHistory({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  beforePath,
  afterPath,
} = {}) {
  if (!beforePath || !afterPath) throw new Error("Connector catalog history requires --before and --after");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const directory = await requireCatalogDirectory(
    path.join(config.stateDirectory, "notifications", "discovery"),
    config.stateDirectory,
  );
  const [beforeCatalog, afterCatalog] = await Promise.all([
    readCatalog(beforePath, directory, "Before connector catalog"),
    readCatalog(afterPath, directory, "After connector catalog"),
  ]);
  return buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog });
}

async function main() {
  const result = await runNotificationConnectorCatalogHistory({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    beforePath: argumentValue(process.argv, "--before"),
    afterPath: argumentValue(process.argv, "--after"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({
      schema_version: 1,
      compared: false,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      raw_exports_read: false,
      profile_files_read: false,
      credential_environment_read: false,
      error: "Notification connector catalog history comparison failed",
    }, null, 2));
    process.exitCode = 1;
  });
}
