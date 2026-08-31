import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES,
  validateNotificationConnectorCapabilityCatalog,
} from "./notification_connector_discovery.mjs";
import { buildNotificationConnectorProfilePlan } from "./notification_connector_profile_plan.mjs";
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
    throw new Error("Connector profile plan state directory must be a regular private directory");
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("Connector profile plan catalog directory must be a regular private directory");
  }
  const [realState, realTarget] = await Promise.all([fs.realpath(state), fs.realpath(target)]);
  if (!contained(realTarget, realState)) throw new Error("Connector profile plan catalog directory cannot escape private state");
  return target;
}

async function readCatalog(filePath, directory) {
  const absolute = path.resolve(filePath);
  if (!contained(absolute, directory)) throw new Error("Connector profile plan catalog must remain under private discovery state");
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES) {
    throw new Error(`Connector profile plan catalog must be a regular file no larger than ${MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES} bytes`);
  }
  const [realFile, realDirectory] = await Promise.all([fs.realpath(absolute), fs.realpath(directory)]);
  if (!contained(realFile, realDirectory)) throw new Error("Connector profile plan catalog cannot escape private state through a symbolic link");
  const value = JSON.parse(await fs.readFile(absolute, "utf8"));
  validateNotificationConnectorCapabilityCatalog(value);
  if (path.basename(absolute) !== `${value.catalog_id}.catalog.json`) {
    throw new Error("Connector profile plan catalog filename does not match catalog_id");
  }
  return value;
}

export async function runNotificationConnectorProfilePlan({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  catalogPath,
  targetId,
  destinationId,
  renderer,
} = {}) {
  if (!catalogPath || !targetId || !destinationId || !renderer) {
    throw new Error("Connector profile plan requires --catalog, --target, --destination, and --renderer");
  }
  const config = await loadProjectConfig({ projectRoot, configPath });
  const directory = await requireCatalogDirectory(
    path.join(config.stateDirectory, "notifications", "discovery"),
    config.stateDirectory,
  );
  const catalog = await readCatalog(catalogPath, directory);
  const destination = config.notifications.destinations.find((entry) => entry.id === destinationId);
  if (!destination) throw new Error("Connector profile plan requires an exact configured notification destination");
  return buildNotificationConnectorProfilePlan({ catalog, destination, targetId, renderer });
}

async function main() {
  const result = await runNotificationConnectorProfilePlan({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    catalogPath: argumentValue(process.argv, "--catalog"),
    targetId: argumentValue(process.argv, "--target"),
    destinationId: argumentValue(process.argv, "--destination"),
    renderer: argumentValue(process.argv, "--renderer"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({
      schema_version: 1,
      planned: false,
      state_written: false,
      profile_written: false,
      credential_environment_read: false,
      network_accessed: false,
      external_delivery_performed: false,
      approval_id_issued: false,
      send_authorization_granted: false,
      error: "Notification connector profile planning failed",
    }, null, 2));
    process.exitCode = 1;
  });
}
