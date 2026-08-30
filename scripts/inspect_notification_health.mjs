import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNotificationDeliveryHealthReport,
  MAX_NOTIFICATION_HEALTH_ARTIFACT_BYTES,
  MAX_NOTIFICATION_HEALTH_ARTIFACTS,
  notificationHealthArtifactIssue,
} from "./notification_delivery_health_lib.mjs";
import {
  validateNotificationConnectorReceipt,
  validateNotificationConnectorRecoveryMarker,
} from "./notification_connector_runtime.mjs";
import {
  validateNotificationStatusObservation,
  validateNotificationStatusRecoveryMarker,
} from "./notification_status_runtime.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

async function directoryEntries(directory, matcher) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Notification health artifact directory must be a regular directory");
    }
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => matcher(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function requireRegularDirectoryIfPresent(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Notification health artifact directory must be a regular directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readArtifact({ directory, entry, artifactType, validator, expectedFileName }) {
  const sourceReference = `${artifactType}:${entry.name}`;
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return { issue: notificationHealthArtifactIssue(artifactType, "not_regular_file", sourceReference) };
  }
  const filePath = path.join(directory, entry.name);
  const stat = await fs.lstat(filePath);
  if (stat.size > MAX_NOTIFICATION_HEALTH_ARTIFACT_BYTES) {
    return { issue: notificationHealthArtifactIssue(artifactType, "oversized", sourceReference) };
  }
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return { issue: notificationHealthArtifactIssue(artifactType, "invalid_json", sourceReference) };
  }
  try {
    validator(value);
  } catch {
    return { issue: notificationHealthArtifactIssue(artifactType, "invalid_contract", sourceReference) };
  }
  if (expectedFileName(value) !== entry.name) {
    return { issue: notificationHealthArtifactIssue(artifactType, "filename_mismatch", sourceReference) };
  }
  if (artifactType === "request" && value.destination.adapter !== "connector") {
    return { issue: notificationHealthArtifactIssue(artifactType, "unsupported_adapter", sourceReference) };
  }
  return { value };
}

async function scanNotificationArtifacts(stateDirectory) {
  const state = path.resolve(stateDirectory);
  const notifications = path.join(state, "notifications");
  const outbox = path.join(notifications, "outbox");
  const receipts = path.join(notifications, "receipts");
  const statusObservationsDirectory = path.join(notifications, "status-observations");
  await requireRegularDirectoryIfPresent(notifications);
  const [requestEntries, receiptEntries, markerEntries, statusObservationEntries, statusMarkerEntries] = await Promise.all([
    directoryEntries(outbox, (name) => name.endsWith(".request.json")),
    directoryEntries(receipts, (name) => name.endsWith(".receipt.json")),
    directoryEntries(state, (name) => /^pending-notification-connector-.*\.json$/i.test(name)),
    directoryEntries(statusObservationsDirectory, (name) => name.endsWith(".observation.json")),
    directoryEntries(state, (name) => /^pending-notification-status-.*\.json$/i.test(name)),
  ]);
  const total = requestEntries.length + receiptEntries.length + markerEntries.length
    + statusObservationEntries.length + statusMarkerEntries.length;
  if (total > MAX_NOTIFICATION_HEALTH_ARTIFACTS) {
    throw new Error(`Notification health inspection supports at most ${MAX_NOTIFICATION_HEALTH_ARTIFACTS} artifacts`);
  }
  const requests = [];
  const sanitizedReceipts = [];
  const recoveryMarkers = [];
  const statusObservations = [];
  const statusRecoveryMarkers = [];
  const artifactIssues = [];
  const groups = [
    {
      directory: outbox, entries: requestEntries, artifactType: "request", validator: validateNotificationDeliveryRequest,
      expectedFileName: (value) => `${value.request_id}.request.json`, destination: requests,
    },
    {
      directory: receipts, entries: receiptEntries, artifactType: "receipt", validator: validateNotificationConnectorReceipt,
      expectedFileName: (value) => `${value.request_id}.receipt.json`, destination: sanitizedReceipts,
    },
    {
      directory: state, entries: markerEntries, artifactType: "recovery_marker",
      validator: validateNotificationConnectorRecoveryMarker,
      expectedFileName: (value) => `pending-notification-connector-${value.request_id}.json`, destination: recoveryMarkers,
    },
    {
      directory: statusObservationsDirectory, entries: statusObservationEntries, artifactType: "status_observation",
      validator: validateNotificationStatusObservation,
      expectedFileName: (value) => `${value.request_id}.${value.observation_id}.observation.json`,
      destination: statusObservations,
    },
    {
      directory: state, entries: statusMarkerEntries, artifactType: "status_recovery_marker",
      validator: validateNotificationStatusRecoveryMarker,
      expectedFileName: (value) => `pending-notification-status-${value.request_id}.json`,
      destination: statusRecoveryMarkers,
    },
  ];
  for (const group of groups) {
    for (const entry of group.entries) {
      const result = await readArtifact({ ...group, entry });
      if (result.issue) artifactIssues.push(result.issue);
      else group.destination.push(result.value);
    }
  }
  return {
    requests,
    receipts: sanitizedReceipts,
    recoveryMarkers,
    statusObservations,
    statusRecoveryMarkers,
    artifactIssues,
  };
}

export async function inspectNotificationDeliveryHealth({
  stateDirectory, asOf = new Date().toISOString(), staleAfterHours = 24,
} = {}) {
  if (!stateDirectory) throw new Error("Notification health inspection requires a private state directory");
  const state = path.resolve(stateDirectory);
  const stat = await fs.lstat(state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Notification health state directory must be a regular directory");
  }
  const artifacts = await scanNotificationArtifacts(state);
  return buildNotificationDeliveryHealthReport({ ...artifacts, asOf, staleAfterHours });
}

export async function runNotificationDeliveryHealth({
  projectRoot = process.cwd(), configPath = ".job-search.local.json", stateDirectory = null,
  asOf = new Date().toISOString(), staleAfterHours = 24,
} = {}) {
  const config = stateDirectory ? null : await loadProjectConfig({ projectRoot, configPath });
  return inspectNotificationDeliveryHealth({
    stateDirectory: stateDirectory ?? config.stateDirectory,
    asOf,
    staleAfterHours,
  });
}

async function main() {
  const result = await runNotificationDeliveryHealth({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    stateDirectory: argumentValue(process.argv, "--state-dir"),
    asOf: argumentValue(process.argv, "--as-of", new Date().toISOString()),
    staleAfterHours: Number(argumentValue(process.argv, "--stale-after-hours", 24)),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({
      schema_version: 2,
      inspected: false,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      error: "Notification delivery health inspection failed",
    }, null, 2));
    process.exitCode = 1;
  });
}
