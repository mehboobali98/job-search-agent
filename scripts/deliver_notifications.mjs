import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteFilesWithRollback } from "./file_transaction.mjs";
import {
  assertNotificationSafe,
  buildJobDigest,
  MAX_NOTIFICATION_RESULT_BYTES,
  NOTIFICATION_CLASSIFICATIONS,
  notificationPreviewSummary,
  planNotificationDeliveries,
  validateNotificationDeliveryRequest,
} from "./notification_delivery_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function safeId(value) {
  const text = String(value ?? "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!text) throw new Error("Notification approval ID cannot be converted to a safe filename");
  return text;
}

function safeErrorSummary(error) {
  return String(error?.message ?? error ?? "Unknown notification write failure")
    .split(/\r?\n/, 1)[0]
    .replace(/\/(?:Users|home)\/[^/\s]+\//g, "/[redacted-home]/")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicReplace(filePath, contents) {
  const temporaryPath = filePath + `.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, contents, { flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function requestTarget(stateDirectory, request) {
  const subdirectory = request.destination.adapter === "private_file" ? "local" : "outbox";
  return path.join(stateDirectory, "notifications", subdirectory, `${safeId(request.request_id)}.request.json`);
}

export async function applyNotificationRequests({
  requests,
  approvalId,
  stateDirectory,
  beforeCommit = async () => {},
} = {}) {
  if (!Array.isArray(requests)) throw new Error("Notification requests must be an array");
  if (!/^NAPP-[A-F0-9]{24}$/.test(String(approvalId ?? ""))) throw new Error("Notification apply requires an approval ID");
  for (const request of requests) {
    validateNotificationDeliveryRequest(request);
    if (request.approval_id !== approvalId) throw new Error("Notification request approval IDs do not match");
  }
  const state = path.resolve(stateDirectory);
  const pendingPath = path.join(state, `pending-notification-${safeId(approvalId)}.json`);
  const replacements = [];
  const outputs = [];
  await fs.mkdir(state, { recursive: true });
  try {
    for (const request of requests) {
      const target = requestTarget(state, request);
      const contents = JSON.stringify(request, null, 2) + "\n";
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (await fileExists(target)) {
        if (await fs.readFile(target, "utf8") !== contents) {
          throw new Error("A different notification request already exists for this request ID");
        }
        outputs.push({
          request_id: request.request_id,
          adapter: request.destination.adapter,
          status: request.destination.adapter === "private_file" ? "available_locally" : "queued_for_connector",
          already_applied: true,
        });
        continue;
      }
      const staged = target + `.staged-${process.pid}-${Date.now()}-${replacements.length}`;
      await fs.writeFile(staged, contents, { flag: "wx" });
      replacements.push({ staged, target });
      outputs.push({
        request_id: request.request_id,
        adapter: request.destination.adapter,
        status: request.destination.adapter === "private_file" ? "available_locally" : "queued_for_connector",
        already_applied: false,
      });
    }
    if (replacements.length) {
      await promoteFilesWithRollback(replacements, async () => beforeCommit({ requests, replacements }));
    }
    await fs.rm(pendingPath, { force: true });
    return {
      applied: true,
      already_applied: outputs.length > 0 && outputs.every((output) => output.already_applied),
      persistent_files_written: replacements.length,
      outputs,
      external_delivery_performed: false,
      pending_marker: null,
    };
  } catch (error) {
    await Promise.allSettled(replacements.map(({ staged }) => fs.rm(staged, { force: true })));
    const marker = assertNotificationSafe({
      schema_version: 1,
      workflow: "notification_delivery",
      created_at: new Date().toISOString(),
      approval_id: approvalId,
      requests,
      error: safeErrorSummary(error),
    });
    await atomicReplace(pendingPath, JSON.stringify(marker, null, 2) + "\n");
    error.pending_marker = pendingPath;
    throw error;
  }
}

export async function recoverNotificationRequests({ markerPath, approvalId, stateDirectory = null } = {}) {
  const absoluteMarker = path.resolve(markerPath);
  const marker = JSON.parse(await fs.readFile(absoluteMarker, "utf8"));
  if (marker.workflow !== "notification_delivery" || !Array.isArray(marker.requests)) {
    throw new Error("Recovery marker is not a notification-delivery marker");
  }
  if (marker.approval_id !== approvalId) throw new Error("Notification recovery requires the marker's exact approval ID");
  const result = await applyNotificationRequests({
    requests: marker.requests,
    approvalId,
    stateDirectory: stateDirectory ?? path.dirname(absoluteMarker),
  });
  await fs.rm(absoluteMarker, { force: true });
  return { ...result, recovered: true };
}

export async function runNotificationDelivery({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  inputPath = null,
  apply = false,
  approvalId = null,
  recoverPath = null,
  asOf = null,
  beforeCommit = async () => {},
} = {}) {
  const config = await loadProjectConfig({ projectRoot, configPath });
  if (recoverPath) {
    if (!apply) throw new Error("Notification recovery requires --apply");
    if (!config.notifications.enabled) throw new Error("Notifications must remain enabled for recovery");
    return {
      schema_version: 1,
      mode: "apply",
      enabled: true,
      recovery: await recoverNotificationRequests({
        markerPath: recoverPath,
        approvalId,
        stateDirectory: config.stateDirectory,
      }),
      external_delivery_performed: false,
    };
  }
  const absoluteInput = path.resolve(inputPath ?? path.join(config.stateDirectory, "last-run.json"));
  const stat = await fs.stat(absoluteInput);
  if (stat.size > MAX_NOTIFICATION_RESULT_BYTES) {
    throw new Error(`Updater result exceeds the ${MAX_NOTIFICATION_RESULT_BYTES}-byte notification input limit`);
  }
  const source = JSON.parse(await fs.readFile(absoluteInput, "utf8"));
  const generatedAt = asOf ?? source.completed_at ?? stat.mtime.toISOString();
  const built = buildJobDigest(source, {
    generatedAt,
    timezone: config.raw.timezone,
    maxItems: config.notifications.max_items_per_digest,
  });
  const plan = planNotificationDeliveries(built.digest, config.notifications);
  if (built.omitted_count > 0) plan.classifications.push({
    code: NOTIFICATION_CLASSIFICATIONS.DIGEST_LIMIT_EXCEEDED,
    count: built.omitted_count,
  });
  const preview = notificationPreviewSummary({ digest: built.digest, plan });
  let persistence = {
    applied: false,
    already_applied: false,
    persistent_files_written: 0,
    outputs: [],
    external_delivery_performed: false,
    pending_marker: null,
  };
  if (apply) {
    if (!config.notifications.enabled) throw new Error("Notifications are disabled in local configuration");
    if (!plan.approval_id || approvalId !== plan.approval_id) {
      throw new Error("Notification apply requires the exact approval ID from preview");
    }
    persistence = await applyNotificationRequests({
      requests: plan.requests,
      approvalId,
      stateDirectory: config.stateDirectory,
      beforeCommit,
    });
  }
  return {
    schema_version: 1,
    mode: apply ? "apply" : "preview",
    enabled: config.notifications.enabled,
    persistent_state_written: persistence.persistent_files_written > 0,
    digest: built.digest,
    delivery_requests: plan.requests,
    preview,
    persistence,
    external_delivery_performed: false,
  };
}

async function main() {
  const result = await runNotificationDelivery({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    inputPath: argumentValue(process.argv, "--input"),
    recoverPath: argumentValue(process.argv, "--recover"),
    approvalId: argumentValue(process.argv, "--approve"),
    asOf: argumentValue(process.argv, "--as-of"),
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schema_version: 1,
      applied: false,
      external_delivery_performed: false,
      error: String(error?.message ?? error),
      pending_marker: error?.pending_marker ?? null,
    }, null, 2));
    process.exitCode = 1;
  });
}
