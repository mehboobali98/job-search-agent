import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteFilesWithRollback } from "./file_transaction.mjs";
import {
  buildNotificationConnectorDiscoveryRecoveryMarker,
  buildSanitizedNotificationConnectorCapabilityCatalog,
  MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES,
  validateNotificationConnectorCapabilityCatalog,
  validateNotificationConnectorDiscoveryRecoveryMarker,
} from "./notification_connector_discovery.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function contained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireRegularFile(filePath, maximum, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new Error(`${label} must be a regular file no larger than ${maximum} bytes`);
  }
  return stat;
}

async function ensurePrivateDirectory(directory, stateDirectory, { create = false, label } = {}) {
  const state = path.resolve(stateDirectory);
  const target = path.resolve(directory);
  const relative = path.relative(state, target);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain under the configured private state directory`);
  }
  const stateStat = await fs.lstat(state);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Connector discovery state directory must be a regular private directory");
  }
  let current = state;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular private directory`);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      await fs.mkdir(current);
    }
  }
  const [realTarget, realState] = await Promise.all([fs.realpath(target), fs.realpath(state)]);
  if (realTarget !== realState && !contained(realTarget, realState)) {
    throw new Error(`${label} cannot escape private state through a symbolic link`);
  }
  return target;
}

async function atomicReplace(filePath, contents) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function notificationConnectorCapabilityCatalogPath(stateDirectory, catalog) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  return path.join(
    path.resolve(stateDirectory), "notifications", "discovery", `${catalog.catalog_id}.catalog.json`,
  );
}

export function notificationConnectorDiscoveryPendingPath(stateDirectory, catalog) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  return path.join(path.resolve(stateDirectory), `pending-notification-discovery-${catalog.catalog_id}.json`);
}

export async function applyNotificationConnectorCapabilityCatalog({
  catalog,
  approvalId,
  stateDirectory,
  recoverPath = null,
  now = new Date().toISOString(),
  beforeCatalogCommit = async () => {},
} = {}) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  if (approvalId !== catalog.approval_id) {
    throw new Error("Connector capability catalog import requires the exact preview approval ID");
  }
  const catalogDirectory = await ensurePrivateDirectory(
    path.join(stateDirectory, "notifications", "discovery"), stateDirectory,
    { create: true, label: "Connector capability catalog directory" },
  );
  const target = notificationConnectorCapabilityCatalogPath(stateDirectory, catalog);
  const pending = notificationConnectorDiscoveryPendingPath(stateDirectory, catalog);
  const contents = JSON.stringify(catalog, null, 2) + "\n";

  if (recoverPath) {
    const absoluteRecovery = path.resolve(recoverPath);
    if (absoluteRecovery !== path.resolve(pending)) {
      throw new Error("Connector discovery recovery marker must use its deterministic private path");
    }
    await requireRegularFile(absoluteRecovery, MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES, "Connector discovery recovery marker");
    const marker = validateNotificationConnectorDiscoveryRecoveryMarker(
      JSON.parse(await fs.readFile(absoluteRecovery, "utf8")), { catalog },
    );
    if (marker.approval_id !== approvalId) throw new Error("Connector discovery recovery requires the unchanged exact approval ID");
  } else if (await fileExists(pending)) {
    throw new Error("A pending connector discovery recovery marker exists; inspect it before another apply");
  }

  if (await fileExists(target)) {
    await requireRegularFile(target, MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES, "Existing connector capability catalog");
    if (await fs.readFile(target, "utf8") !== contents) {
      throw new Error("A different connector capability catalog already exists for this catalog ID");
    }
    if (recoverPath) await fs.rm(path.resolve(recoverPath), { force: true });
    return {
      applied: true, already_applied: true, recovered: Boolean(recoverPath),
      persistent_files_written: 0, catalog_file: path.basename(target), pending_marker: null,
    };
  }

  const staged = path.join(catalogDirectory, `.${catalog.catalog_id}.staged-${process.pid}-${Date.now()}`);
  await fs.writeFile(staged, contents, { flag: "wx" });
  try {
    await beforeCatalogCommit(catalog);
    await promoteFilesWithRollback([{ staged, target }], async () => {});
    if (recoverPath) await fs.rm(path.resolve(recoverPath), { force: true });
    return {
      applied: true, already_applied: false, recovered: Boolean(recoverPath),
      persistent_files_written: 1, catalog_file: path.basename(target), pending_marker: null,
    };
  } catch (error) {
    await fs.rm(staged, { force: true });
    const marker = buildNotificationConnectorDiscoveryRecoveryMarker(catalog, {
      createdAt: now,
      error: "Sanitized connector capability catalog commit failed",
    });
    await atomicReplace(pending, JSON.stringify(marker, null, 2) + "\n");
    const importError = new Error("Connector capability catalog could not be committed; use exact private recovery");
    importError.pending_marker = pending;
    throw importError;
  }
}

export async function runNotificationConnectorDiscoveryImport({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  inputPath,
  apply = false,
  approvalId = null,
  recoverPath = null,
  now = new Date().toISOString(),
  beforeCatalogCommit = async () => {},
} = {}) {
  if (!inputPath) throw new Error("Connector capability discovery requires --input");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const exportDirectory = path.join(config.stateDirectory, "notification-connector-discovery", "exports");
  await ensurePrivateDirectory(exportDirectory, config.stateDirectory, {
    create: false, label: "Connector capability export directory",
  });
  const absoluteInput = path.resolve(inputPath);
  if (!contained(absoluteInput, exportDirectory)) {
    throw new Error("Connector capability export must remain under its configured private export directory");
  }
  await requireRegularFile(
    absoluteInput, MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES, "Connector capability export",
  );
  const [realInput, realExportDirectory] = await Promise.all([
    fs.realpath(absoluteInput), fs.realpath(exportDirectory),
  ]);
  if (!contained(realInput, realExportDirectory)) {
    throw new Error("Connector capability export cannot escape private state through a symbolic link");
  }
  const source = JSON.parse(await fs.readFile(absoluteInput, "utf8"));
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(source);
  if (path.basename(absoluteInput) !== `${catalog.source_export_id}.capabilities.json`) {
    throw new Error("Connector capability export filename must match export_id as <export_id>.capabilities.json");
  }
  const preview = {
    schema_version: 1,
    catalog,
    approval_id: catalog.approval_id,
    counts: catalog.counts,
    read_only_source: true,
    account_identifier_included: false,
    native_target_included: false,
    target_label_included: false,
    endpoint_included: false,
    credential_included: false,
    network_accessed: false,
    external_delivery_performed: false,
  };
  let persistence = {
    applied: false, already_applied: false, recovered: false,
    persistent_files_written: 0, catalog_file: null, pending_marker: null,
  };
  if (apply) {
    persistence = await applyNotificationConnectorCapabilityCatalog({
      catalog,
      approvalId,
      stateDirectory: config.stateDirectory,
      recoverPath,
      now,
      beforeCatalogCommit,
    });
  }
  return {
    schema_version: 1,
    mode: apply ? "apply" : "preview",
    preview,
    persistence,
    source_modified: false,
    account_identifier_included: false,
    native_target_included: false,
    target_label_included: false,
    endpoint_included: false,
    credential_included: false,
    network_accessed: false,
    external_delivery_performed: false,
  };
}

async function main() {
  const result = await runNotificationConnectorDiscoveryImport({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    inputPath: argumentValue(process.argv, "--input"),
    apply: process.argv.includes("--apply"),
    approvalId: argumentValue(process.argv, "--approve"),
    recoverPath: argumentValue(process.argv, "--recover"),
    now: argumentValue(process.argv, "--as-of", new Date().toISOString()),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schema_version: 1,
      applied: false,
      source_modified: false,
      account_identifier_included: false,
      native_target_included: false,
      target_label_included: false,
      endpoint_included: false,
      credential_included: false,
      network_accessed: false,
      external_delivery_performed: false,
      error: String(error?.message ?? error),
      pending_marker: error?.pending_marker ? path.basename(error.pending_marker) : null,
    }, null, 2));
    process.exitCode = 1;
  });
}
