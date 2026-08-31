import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES,
  validateNotificationConnectorCapabilityCatalog,
} from "./notification_connector_discovery.mjs";
import { MAX_CONNECTOR_BINDING_BYTES, validateNotificationConnectorBinding } from "./notification_connector_runtime.mjs";
import { buildNotificationConnectorDriftReport } from "./notification_connector_drift.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function contained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function requirePrivateDirectory(directory, stateDirectory, label) {
  const state = path.resolve(stateDirectory);
  const target = path.resolve(directory);
  const [stateStat, targetStat] = await Promise.all([fs.lstat(state), fs.lstat(target)]);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Connector drift state directory must be a regular private directory");
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular private directory`);
  }
  const [realState, realTarget] = await Promise.all([fs.realpath(state), fs.realpath(target)]);
  if (!contained(realTarget, realState)) throw new Error(`${label} cannot escape private state`);
  return target;
}

async function readPrivateArtifact({ filePath, directory, maximumBytes, label, validator, expectedFileName }) {
  const absolute = path.resolve(filePath);
  if (!contained(absolute, directory)) throw new Error(`${label} must remain under its configured private directory`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
  }
  const [realFile, realDirectory] = await Promise.all([fs.realpath(absolute), fs.realpath(directory)]);
  if (!contained(realFile, realDirectory)) throw new Error(`${label} cannot escape private state through a symbolic link`);
  const value = JSON.parse(await fs.readFile(absolute, "utf8"));
  validator(value);
  if (path.basename(absolute) !== expectedFileName(value)) throw new Error(`${label} filename does not match its contract identity`);
  return value;
}

export async function runNotificationConnectorDriftInspection({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  catalogPath,
  bindingPath,
} = {}) {
  if (!catalogPath || !bindingPath) throw new Error("Connector drift inspection requires --catalog and --binding");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const catalogDirectory = await requirePrivateDirectory(
    path.join(config.stateDirectory, "notifications", "discovery"),
    config.stateDirectory,
    "Connector drift catalog directory",
  );
  const bindingDirectory = await requirePrivateDirectory(
    path.join(config.stateDirectory, "notifications", "connectors"),
    config.stateDirectory,
    "Connector drift binding directory",
  );
  const [catalog, binding] = await Promise.all([
    readPrivateArtifact({
      filePath: catalogPath,
      directory: catalogDirectory,
      maximumBytes: MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES,
      label: "Connector capability catalog",
      validator: validateNotificationConnectorCapabilityCatalog,
      expectedFileName: (value) => `${value.catalog_id}.catalog.json`,
    }),
    readPrivateArtifact({
      filePath: bindingPath,
      directory: bindingDirectory,
      maximumBytes: MAX_CONNECTOR_BINDING_BYTES,
      label: "Connector binding",
      validator: validateNotificationConnectorBinding,
      expectedFileName: (value) => `${value.profile_id}.binding.json`,
    }),
  ]);
  return buildNotificationConnectorDriftReport({ catalog, binding });
}

async function main() {
  const result = await runNotificationConnectorDriftInspection({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    catalogPath: argumentValue(process.argv, "--catalog"),
    bindingPath: argumentValue(process.argv, "--binding"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({
      schema_version: 1,
      inspected: false,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      profile_files_read: false,
      credential_environment_read: false,
      error: "Notification connector drift inspection failed",
    }, null, 2));
    process.exitCode = 1;
  });
}
