import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeNotificationStatusRequest,
  buildNotificationStatusObservation,
  buildNotificationStatusProbePlan,
  MAX_NOTIFICATION_STATUS_BINDING_BYTES,
  MAX_NOTIFICATION_STATUS_PROFILE_BYTES,
  MAX_NOTIFICATION_STATUS_REQUEST_BYTES,
  notificationStatusApprovalId,
  notificationStatusRequestHash,
  validateNotificationConnectorStatusProfile,
  validateNotificationStatusBinding,
  validateNotificationStatusObservation,
  validateNotificationStatusProviderResponse,
  validateNotificationStatusRecoveryMarker,
} from "./notification_status_runtime.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function contained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function requirePrivateFile(filePath, directory, label, stateDirectory = directory) {
  const absolute = path.resolve(filePath);
  if (!contained(absolute, directory)) throw new Error(`${label} must remain under the configured private state directory`);
  const [realFile, realDirectory, realState] = await Promise.all([
    fs.realpath(absolute), fs.realpath(directory), fs.realpath(stateDirectory),
  ]);
  if (!contained(realFile, realDirectory)
    || (path.resolve(directory) !== path.resolve(stateDirectory) && !contained(realDirectory, realState))) {
    throw new Error(`${label} cannot escape private state through a symbolic link`);
  }
  return absolute;
}

async function ensureRegularPrivateDirectory(directory, stateDirectory, label) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular private directory`);
  const [realDirectory, realState] = await Promise.all([fs.realpath(directory), fs.realpath(stateDirectory)]);
  if (!contained(realDirectory, realState)) throw new Error(`${label} cannot escape the configured private state directory`);
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedJson(filePath, maximum, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new Error(`${label} must be a regular file no larger than ${maximum} bytes`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function atomicReplace(filePath, contents) {
  const temporary = filePath + `.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function pendingPath(stateDirectory, requestId) {
  return path.join(stateDirectory, `pending-notification-status-${requestId}.json`);
}

function observationPath(stateDirectory, observation) {
  validateNotificationStatusObservation(observation);
  return path.join(
    stateDirectory,
    "notifications",
    "status-observations",
    `${observation.request_id}.${observation.observation_id}.observation.json`,
  );
}

function lockPath(stateDirectory, requestId) {
  return path.join(stateDirectory, "notifications", "locks", `${requestId}.status.lock`);
}

function readBearerCredential(profile, environment) {
  const value = environment[profile.authentication.environment_variable];
  if (typeof value !== "string" || value.length < 16 || value.length > 8_192 || /[\r\n\0]/.test(value)) {
    throw new Error("Notification status credential is unavailable or invalid in the configured environment variable");
  }
  return value;
}

function markerBase({ request, profile, binding, createdAt }) {
  return {
    schema_version: 1,
    workflow: "notification_connector_status_probe",
    created_at: new Date(createdAt).toISOString(),
    request_id: request.request_id,
    approval_id: notificationStatusApprovalId(request, binding),
    binding_id: binding.binding_id,
    profile_id: profile.profile_id,
    connection_ref: profile.connection_ref,
    request_sha256: notificationStatusRequestHash(request),
    profile_sha256: binding.profile_sha256,
    probe_state: "attempting",
    network_attempts: 0,
    last_failure: null,
    confirmed_observation: null,
    error: null,
    safety: {
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      request_items_included: false,
      automatic_retry_performed: false,
      external_delivery_performed: false,
    },
  };
}

async function readBoundedResponseJson(response, maximum) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    const error = new Error("Notification status response exceeds the configured byte limit");
    error.category = "response_limit";
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) {
    const error = new Error("Notification status response exceeds the configured byte limit");
    error.category = "response_limit";
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const error = new Error("Notification status response did not match the strict JSON contract");
    error.category = "invalid_response";
    throw error;
  }
}

async function performProbe({ profile, request, binding, bearer, fetchImpl }) {
  const plan = buildNotificationStatusProbePlan(request, profile, binding);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.request_policy.timeout_ms);
  try {
    const response = await fetchImpl(profile.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${bearer}`,
        "idempotency-key": plan.approval_id,
        "x-job-search-status-approval-id": plan.approval_id,
        "x-job-search-request-id": request.request_id,
      },
      body: JSON.stringify(plan.body),
    });
    const status = Number(response.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      const error = new Error("Notification status response HTTP status is invalid");
      error.category = "invalid_response";
      throw error;
    }
    if (status < 200 || status > 299) {
      const error = new Error(`Notification status endpoint rejected the probe with HTTP ${status}`);
      error.category = "http_status";
      error.http_status = status;
      throw error;
    }
    const value = await readBoundedResponseJson(response, profile.request_policy.max_response_bytes);
    try {
      return { httpStatus: status, providerResponse: validateNotificationStatusProviderResponse(value, request) };
    } catch {
      const error = new Error("Notification status response did not match the approved request contract");
      error.category = "invalid_response";
      error.http_status = status;
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function persistObservation(stateDirectory, observation) {
  const target = observationPath(stateDirectory, observation);
  const contents = JSON.stringify(observation, null, 2) + "\n";
  await ensureRegularPrivateDirectory(path.dirname(target), stateDirectory, "Notification status observation directory");
  if (await fileExists(target)) {
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("Existing notification status observation must be a regular private file");
    }
    const existing = validateNotificationStatusObservation(JSON.parse(await fs.readFile(target, "utf8")));
    if (JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new Error("A different notification status observation already exists for this observation ID");
    }
    return { observation: existing, already_recorded: true, persistent_files_written: 0 };
  }
  await atomicReplace(target, contents);
  return { observation, already_recorded: false, persistent_files_written: 1 };
}

export async function runNotificationStatusProbe({
  projectRoot = process.cwd(), configPath = ".job-search.local.json", requestPath, profilePath, bindingPath = null,
  recoverPath = null, probe = false, approvalId = null, now = new Date().toISOString(), environment = process.env,
  fetchImpl = globalThis.fetch, beforeObservationCommit = async () => {},
} = {}) {
  if (!requestPath || !profilePath) throw new Error("Notification status probe requires --request and --profile");
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Notification status probe timestamp is invalid");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const outboxDirectory = path.join(config.stateDirectory, "notifications", "outbox");
  const profileDirectory = path.join(config.stateDirectory, "notification-status-connectors");
  const bindingDirectory = path.join(config.stateDirectory, "notifications", "status-connectors");
  const stateStat = await fs.lstat(config.stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Notification status state directory must be a regular private directory");
  }
  const absoluteRequest = await requirePrivateFile(
    requestPath, outboxDirectory, "Notification status request", config.stateDirectory,
  );
  const absoluteProfile = await requirePrivateFile(
    profilePath, profileDirectory, "Notification status profile", config.stateDirectory,
  );
  const request = validateNotificationDeliveryRequest(await readBoundedJson(
    absoluteRequest, MAX_NOTIFICATION_STATUS_REQUEST_BYTES * 16, "Notification status request",
  ));
  const profile = validateNotificationConnectorStatusProfile(await readBoundedJson(
    absoluteProfile, MAX_NOTIFICATION_STATUS_PROFILE_BYTES, "Notification status profile",
  ));
  if (path.basename(absoluteProfile) !== `${profile.profile_id}.status-profile.json`) {
    throw new Error("Notification status profile filename must match profile_id as <profile_id>.status-profile.json");
  }
  const deterministicBinding = path.join(bindingDirectory, `${profile.profile_id}.binding.json`);
  const absoluteBinding = await requirePrivateFile(
    bindingPath ?? deterministicBinding, bindingDirectory, "Notification status binding", config.stateDirectory,
  );
  if (absoluteBinding !== path.resolve(deterministicBinding)) {
    throw new Error("Notification status binding must use its deterministic private path");
  }
  const binding = validateNotificationStatusBinding(await readBoundedJson(
    absoluteBinding, MAX_NOTIFICATION_STATUS_BINDING_BYTES, "Notification status binding",
  ));
  authorizeNotificationStatusRequest(request, profile, binding);
  const plan = buildNotificationStatusProbePlan(request, profile, binding);
  const preview = {
    ...plan,
    body: undefined,
    connector_enabled: profile.enabled,
  };
  delete preview.body;
  if (!probe) {
    return {
      schema_version: 1,
      mode: "preview",
      preview,
      probed: false,
      network_attempts: 0,
      persistent_state_written: false,
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      external_delivery_performed: false,
    };
  }
  if (approvalId !== plan.approval_id) throw new Error("Live notification status probe requires the exact preview approval ID");
  if (!profile.enabled) throw new Error("Notification status profile is disabled");
  if (typeof fetchImpl !== "function") throw new Error("No HTTPS notification status transport is available");

  const expectedPending = pendingPath(config.stateDirectory, request.request_id);
  let marker = markerBase({ request, profile, binding, createdAt: timestamp.toISOString() });
  if (recoverPath) {
    const absoluteRecovery = await requirePrivateFile(
      recoverPath, config.stateDirectory, "Notification status recovery marker", config.stateDirectory,
    );
    if (absoluteRecovery !== path.resolve(expectedPending)) {
      throw new Error("Notification status recovery marker must use its deterministic private path");
    }
    marker = validateNotificationStatusRecoveryMarker(await readBoundedJson(
      absoluteRecovery, MAX_NOTIFICATION_STATUS_REQUEST_BYTES, "Notification status recovery marker",
    ), { request, profile, binding });
    if (marker.probe_state === "confirmed") {
      const persisted = await persistObservation(config.stateDirectory, marker.confirmed_observation);
      await fs.rm(absoluteRecovery, { force: true });
      return {
        schema_version: 1,
        mode: "probe",
        preview,
        probed: true,
        recovered: true,
        already_recorded: persisted.already_recorded,
        network_attempts: 0,
        observation: persisted.observation,
        persistent_state_written: persisted.persistent_files_written > 0,
        endpoint_included: false,
        credential_included: false,
        response_body_included: false,
        external_delivery_performed: false,
      };
    }
  } else if (await fileExists(expectedPending)) {
    throw new Error("A pending notification status recovery marker exists; inspect it before another probe");
  }

  const bearer = readBearerCredential(profile, environment);
  const lock = lockPath(config.stateDirectory, request.request_id);
  await ensureRegularPrivateDirectory(path.dirname(lock), config.stateDirectory, "Notification status lock directory");
  const lockHandle = await fs.open(lock, "wx").catch((error) => {
    if (error?.code === "EEXIST") throw new Error("Notification status request is already being probed");
    throw error;
  });
  try {
    await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
    marker = { ...marker, network_attempts: 1 };
    await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
    let result;
    try {
      result = await performProbe({ profile, request, binding, bearer, fetchImpl });
    } catch (error) {
      marker = {
        ...marker,
        probe_state: "unknown",
        last_failure: { category: error?.category ?? "transport", http_status: error?.http_status ?? null },
        error: error?.category === "response_limit"
          ? "Notification status response exceeded its configured byte limit"
          : error?.category === "http_status"
            ? `Notification status endpoint returned HTTP ${error.http_status}`
            : error?.category === "invalid_response"
              ? "Notification status response failed strict validation"
              : "Notification status transport did not return a usable observation",
      };
      await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
      const probeError = new Error(marker.error);
      probeError.pending_marker = path.basename(expectedPending);
      probeError.network_accessed = true;
      throw probeError;
    }
    const observation = buildNotificationStatusObservation({
      request,
      binding,
      providerResponse: result.providerResponse,
      recordedAt: timestamp.toISOString(),
      httpStatus: result.httpStatus,
    });
    marker = {
      ...marker,
      probe_state: "confirmed",
      last_failure: null,
      confirmed_observation: observation,
      error: null,
    };
    await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
    try {
      await beforeObservationCommit(observation);
      const persisted = await persistObservation(config.stateDirectory, observation);
      await fs.rm(expectedPending, { force: true });
      return {
        schema_version: 1,
        mode: "probe",
        preview,
        probed: true,
        recovered: Boolean(recoverPath),
        already_recorded: persisted.already_recorded,
        network_attempts: 1,
        observation: persisted.observation,
        persistent_state_written: persisted.persistent_files_written > 0,
        endpoint_included: false,
        credential_included: false,
        response_body_included: false,
        external_delivery_performed: false,
      };
    } catch {
      marker = { ...marker, error: "Sanitized notification status observation commit failed after confirmed probe" };
      await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n").catch(() => {});
      const commitError = new Error("Notification status was confirmed but its sanitized observation could not be committed; use exact recovery");
      commitError.pending_marker = path.basename(expectedPending);
      commitError.network_accessed = true;
      throw commitError;
    }
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.rm(lock, { force: true });
  }
}

async function main() {
  const result = await runNotificationStatusProbe({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    requestPath: argumentValue(process.argv, "--request"),
    profilePath: argumentValue(process.argv, "--profile"),
    bindingPath: argumentValue(process.argv, "--binding"),
    recoverPath: argumentValue(process.argv, "--recover"),
    approvalId: argumentValue(process.argv, "--approve"),
    now: argumentValue(process.argv, "--as-of", new Date().toISOString()),
    probe: process.argv.includes("--probe"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schema_version: 1,
      probed: false,
      network_accessed: error?.network_accessed === true,
      external_delivery_performed: false,
      pending_marker: error?.pending_marker ?? null,
      error: String(error?.message ?? error),
    }, null, 2));
    process.exitCode = 1;
  });
}
