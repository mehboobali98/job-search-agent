import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNotificationConnectorPlan } from "./notification_connector_contract.mjs";
import {
  authorizeNotificationConnectorRequest,
  buildNotificationConnectorReceipt,
  MAX_CONNECTOR_BINDING_BYTES,
  MAX_CONNECTOR_PROFILE_BYTES,
  MAX_CONNECTOR_REQUEST_BYTES,
  notificationConnectorRequestHash,
  validateNotificationConnectorBinding,
  validateNotificationConnectorProfile,
  validateNotificationConnectorReceipt,
} from "./notification_connector_runtime.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

const RETRYABLE_STATUS = new Set([408, 425, 429]);
const MARKER_FIELDS = new Set([
  "schema_version", "workflow", "created_at", "request_id", "approval_id", "binding_id", "profile_id",
  "connection_ref", "request_sha256", "profile_sha256", "idempotency_key", "delivery_state", "attempts",
  "last_failure", "confirmed_receipt", "error", "safety",
]);
const MARKER_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "response_body_included", "request_items_included",
]);
const MARKER_FAILURE_FIELDS = new Set(["category", "http_status", "retryable"]);

function exactFields(value, fields, label) {
  for (const field of Object.keys(value)) if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
}

function safeId(value, pattern, label) {
  const text = String(value ?? "");
  if (!pattern.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function isContained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function requirePrivatePath(filePath, directory, label) {
  const absolute = path.resolve(filePath);
  if (!isContained(absolute, directory)) throw new Error(`${label} must remain under the configured private state directory`);
  return absolute;
}

async function readBoundedJson(filePath, maximum, label) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maximum) throw new Error(`${label} must be a file no larger than ${maximum} bytes`);
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

function receiptPath(stateDirectory, requestId) {
  return path.join(stateDirectory, "notifications", "receipts", `${requestId}.receipt.json`);
}

function pendingPath(stateDirectory, requestId) {
  return path.join(stateDirectory, `pending-notification-connector-${requestId}.json`);
}

function lockPath(stateDirectory, requestId) {
  return path.join(stateDirectory, "notifications", "locks", `${requestId}.lock`);
}

async function acquireDispatchLock(lock, { request, profile, binding, recover, staleAfterMs }) {
  const contents = JSON.stringify({
    schema_version: 1,
    request_id: request.request_id,
    profile_id: profile.profile_id,
    binding_id: binding.binding_id,
    request_sha256: notificationConnectorRequestHash(request),
  }) + "\n";
  const open = async () => {
    const handle = await fs.open(lock, "wx");
    try {
      await handle.writeFile(contents);
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(lock, { force: true });
      throw error;
    }
  };
  try {
    return await open();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!recover) throw new Error("Connector request is already being dispatched");
    const stat = await fs.stat(lock);
    if (Date.now() - stat.mtimeMs <= staleAfterMs) throw new Error("Connector request still has an active dispatch lock");
    const existing = JSON.parse(await fs.readFile(lock, "utf8"));
    if (existing.request_id !== request.request_id || existing.profile_id !== profile.profile_id
      || existing.binding_id !== binding.binding_id || existing.request_sha256 !== notificationConnectorRequestHash(request)) {
      throw new Error("Stale connector lock does not match the exact recovery inputs");
    }
    await fs.rm(lock);
    return open();
  }
}

function markerBase({ request, profile, binding, now }) {
  return {
    schema_version: 1,
    workflow: "notification_connector_dispatch",
    created_at: new Date(now).toISOString(),
    request_id: request.request_id,
    approval_id: request.approval_id,
    binding_id: binding.binding_id,
    profile_id: profile.profile_id,
    connection_ref: profile.connection_ref,
    request_sha256: notificationConnectorRequestHash(request),
    profile_sha256: binding.profile_sha256,
    idempotency_key: request.request_id,
    delivery_state: "attempting",
    attempts: 0,
    last_failure: null,
    confirmed_receipt: null,
    error: null,
    safety: {
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      request_items_included: false,
    },
  };
}

function validateRecoveryMarker(marker, { request, profile, binding }) {
  if (!marker || marker.workflow !== "notification_connector_dispatch") {
    throw new Error("Recovery marker is not a notification-connector marker");
  }
  exactFields(marker, MARKER_FIELDS, "connector recovery marker");
  if (marker.schema_version !== 1 || !Number.isFinite(new Date(marker.created_at).getTime())) {
    throw new Error("Recovery marker version or timestamp is invalid");
  }
  const expected = {
    request_id: request.request_id,
    approval_id: request.approval_id,
    binding_id: binding.binding_id,
    profile_id: profile.profile_id,
    connection_ref: profile.connection_ref,
    request_sha256: notificationConnectorRequestHash(request),
    profile_sha256: binding.profile_sha256,
    idempotency_key: request.request_id,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (marker[key] !== value) throw new Error(`Recovery marker ${key} does not match the private connector inputs`);
  }
  if (!Number.isInteger(marker.attempts) || marker.attempts < 0 || marker.attempts > binding.request_policy.max_attempts) {
    throw new Error("Recovery marker attempt count is invalid");
  }
  if (!new Set(["attempting", "retryable_failure", "unknown", "rejected", "confirmed"]).has(marker.delivery_state)) {
    throw new Error("Recovery marker delivery_state is invalid");
  }
  if (!marker.safety || typeof marker.safety !== "object" || Array.isArray(marker.safety)) {
    throw new Error("Recovery marker safety must be an object");
  }
  exactFields(marker.safety, MARKER_SAFETY_FIELDS, "connector recovery marker safety");
  if (marker.safety.endpoint_included !== false || marker.safety.credential_included !== false
    || marker.safety?.response_body_included !== false || marker.safety?.request_items_included !== false) {
    throw new Error("Recovery marker safety flags are invalid");
  }
  if (marker.error !== null && (typeof marker.error !== "string" || !marker.error || marker.error.length > 240 || /[\r\n]/.test(marker.error))) {
    throw new Error("Recovery marker error summary is invalid");
  }
  if (marker.last_failure !== null) {
    if (!marker.last_failure || typeof marker.last_failure !== "object" || Array.isArray(marker.last_failure)) {
      throw new Error("Recovery marker last_failure is invalid");
    }
    exactFields(marker.last_failure, MARKER_FAILURE_FIELDS, "connector recovery marker last_failure");
    if (!new Set(["response_limit", "transport", "http_status"]).has(marker.last_failure.category)
      || (marker.last_failure.http_status !== null
        && (!Number.isInteger(marker.last_failure.http_status) || marker.last_failure.http_status < 100 || marker.last_failure.http_status > 599))
      || typeof marker.last_failure.retryable !== "boolean") throw new Error("Recovery marker last_failure is invalid");
  }
  if (marker.delivery_state === "confirmed") {
    const receipt = validateNotificationConnectorReceipt(marker.confirmed_receipt);
    if (receipt.request_id !== request.request_id || receipt.approval_id !== request.approval_id
      || receipt.binding_id !== binding.binding_id || receipt.request_sha256 !== notificationConnectorRequestHash(request)) {
      throw new Error("Confirmed recovery receipt does not match the exact connector inputs");
    }
  } else if (marker.confirmed_receipt !== null) {
    throw new Error("Unconfirmed recovery marker cannot contain a receipt");
  }
  return marker;
}

function enabledDestination(config, request) {
  return config.notifications.enabled && config.notifications.destinations.some((destination) => (
    destination.enabled
    && destination.adapter === "connector"
    && destination.id === request.destination.id
    && destination.channel === request.destination.channel
    && destination.connection_ref === request.destination.connection_ref
  ));
}

function readBearerCredential(profile, environment) {
  const value = environment[profile.authentication.environment_variable];
  if (typeof value !== "string" || value.length < 16 || value.length > 8_192 || /[\r\n\0]/.test(value)) {
    throw new Error("Connector credential is unavailable or invalid in the configured environment variable");
  }
  return value;
}

async function discardBoundedResponse(response, maximum) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) throw new Error("Connector response exceeds the configured byte limit");
  if (!response.body) return 0;
  if (typeof response.body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maximum) throw new Error("Connector response exceeds the configured byte limit");
    return buffer.byteLength;
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value?.byteLength ?? 0;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Connector response exceeds the configured byte limit");
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return size;
}

async function performAttempt({ endpoint, body, bearer, request, profile, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.request_policy.timeout_ms);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${bearer}`,
        "idempotency-key": request.request_id,
        "x-job-search-approval-id": request.approval_id,
      },
      body,
    });
    const status = Number(response.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Connector response status is invalid");
    await discardBoundedResponse(response, profile.request_policy.max_response_bytes);
    return { status };
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || (status >= 500 && status <= 599);
}

async function persistReceipt(target, receipt) {
  const contents = JSON.stringify(receipt, null, 2) + "\n";
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await fileExists(target)) {
    const existing = JSON.parse(await fs.readFile(target, "utf8"));
    validateNotificationConnectorReceipt(existing);
    if (existing.request_id !== receipt.request_id || existing.approval_id !== receipt.approval_id
      || existing.binding_id !== receipt.binding_id
      || existing.request_sha256 !== receipt.request_sha256) {
      throw new Error("A different connector receipt already exists for this request ID");
    }
    return { receipt: existing, already_delivered: true, persistent_files_written: 0 };
  }
  await atomicReplace(target, contents);
  return { receipt, already_delivered: false, persistent_files_written: 1 };
}

export async function runNotificationConnectorDispatch({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  requestPath,
  profilePath,
  bindingPath = null,
  recoverPath = null,
  send = false,
  approvalId = null,
  now = new Date().toISOString(),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  beforeReceiptCommit = async () => {},
} = {}) {
  if (!requestPath || !profilePath) throw new Error("Connector dispatch requires --request and --profile");
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Connector dispatch timestamp is invalid");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const outboxDirectory = path.join(config.stateDirectory, "notifications", "outbox");
  const profilesDirectory = path.join(config.stateDirectory, "notification-connectors");
  const absoluteRequest = requirePrivatePath(requestPath, outboxDirectory, "Connector outbox request");
  const absoluteProfile = requirePrivatePath(profilePath, profilesDirectory, "Connector profile");
  const request = validateNotificationDeliveryRequest(await readBoundedJson(
    absoluteRequest, MAX_CONNECTOR_REQUEST_BYTES, "Connector outbox request",
  ));
  const profile = validateNotificationConnectorProfile(await readBoundedJson(
    absoluteProfile, MAX_CONNECTOR_PROFILE_BYTES, "Connector profile",
  ));
  if (path.basename(absoluteProfile) !== `${profile.profile_id}.profile.json`) {
    throw new Error("Connector profile filename must match its profile_id as <profile_id>.profile.json");
  }
  const expectedBindingDirectory = path.join(config.stateDirectory, "notifications", "connectors");
  const deterministicBinding = path.join(expectedBindingDirectory, `${profile.profile_id}.binding.json`);
  const absoluteBinding = requirePrivatePath(bindingPath ?? deterministicBinding, expectedBindingDirectory, "Connector binding");
  if (absoluteBinding !== path.resolve(deterministicBinding)) {
    throw new Error("Connector binding must use its deterministic private binding path");
  }
  const binding = validateNotificationConnectorBinding(await readBoundedJson(
    absoluteBinding, MAX_CONNECTOR_BINDING_BYTES, "Connector binding",
  ));
  authorizeNotificationConnectorRequest(request, profile, binding);
  const boundaryPlan = buildNotificationConnectorPlan(request, { approvalId: request.approval_id, now: timestamp.toISOString() });
  const requestBody = JSON.stringify(request);
  const requestBytes = Buffer.byteLength(requestBody);
  if (requestBytes > profile.request_policy.max_request_bytes) {
    throw new Error("Connector request exceeds the profile's request byte limit");
  }
  const destinationEnabled = enabledDestination(config, request);
  const preview = {
    schema_version: 1,
    request_id: request.request_id,
    approval_id: request.approval_id,
    profile_id: profile.profile_id,
    binding_id: binding.binding_id,
    notifications_enabled: config.notifications.enabled,
    destination_enabled: destinationEnabled,
    connector_enabled: profile.enabled,
    destination_allowlisted: true,
    status: boundaryPlan.status,
    not_before: request.not_before,
    request_bytes: requestBytes,
    request_limit_bytes: profile.request_policy.max_request_bytes,
    timeout_ms: profile.request_policy.timeout_ms,
    maximum_attempts: profile.request_policy.max_attempts,
    retry_delays_ms: profile.request_policy.retry_delays_ms,
    idempotency_key: request.request_id,
    explicit_send_required: true,
    exact_approval_required: true,
    endpoint_included: false,
    credential_included: false,
    external_delivery_performed: false,
  };
  if (!send) {
    return {
      schema_version: 1,
      mode: "preview",
      preview,
      sent: false,
      network_attempts: 0,
      persistent_state_written: false,
      endpoint_included: false,
      credential_included: false,
      external_delivery_performed: false,
    };
  }
  if (approvalId !== request.approval_id) throw new Error("Live connector send requires the exact notification approval ID");
  if (!config.notifications.enabled || !destinationEnabled) {
    throw new Error("Live connector send requires the matching notification destination to remain enabled");
  }
  if (!profile.enabled) throw new Error("Live connector profile is disabled");
  if (boundaryPlan.status === "deferred") {
    return {
      schema_version: 1,
      mode: "send",
      preview,
      sent: false,
      deferred: true,
      network_attempts: 0,
      persistent_state_written: false,
      endpoint_included: false,
      credential_included: false,
      external_delivery_performed: false,
    };
  }
  if (typeof fetchImpl !== "function") throw new Error("No HTTPS connector transport is available");

  const targetReceipt = receiptPath(config.stateDirectory, request.request_id);
  if (await fileExists(targetReceipt)) {
    const existing = validateNotificationConnectorReceipt(JSON.parse(await fs.readFile(targetReceipt, "utf8")));
    if (existing.request_id !== request.request_id || existing.approval_id !== request.approval_id
      || existing.binding_id !== binding.binding_id
      || existing.request_sha256 !== notificationConnectorRequestHash(request)) {
      throw new Error("Existing connector receipt does not match the approved request");
    }
    return {
      schema_version: 1,
      mode: "send",
      preview,
      sent: true,
      deferred: false,
      already_delivered: true,
      network_attempts: 0,
      receipt: existing,
      persistent_state_written: false,
      endpoint_included: false,
      credential_included: false,
      external_delivery_performed: true,
    };
  }

  const expectedPending = pendingPath(config.stateDirectory, request.request_id);
  let marker = markerBase({ request, profile, binding, now: timestamp.toISOString() });
  if (recoverPath) {
    const absoluteRecovery = requirePrivatePath(recoverPath, config.stateDirectory, "Connector recovery marker");
    if (absoluteRecovery !== path.resolve(expectedPending)) throw new Error("Connector recovery marker path is not the deterministic pending path");
    marker = validateRecoveryMarker(await readBoundedJson(absoluteRecovery, MAX_CONNECTOR_REQUEST_BYTES, "Connector recovery marker"), {
      request, profile, binding,
    });
    if (marker.delivery_state === "confirmed") {
      const persisted = await persistReceipt(targetReceipt, marker.confirmed_receipt);
      await fs.rm(absoluteRecovery, { force: true });
      return {
        schema_version: 1,
        mode: "send",
        preview,
        sent: true,
        deferred: false,
        recovered: true,
        already_delivered: persisted.already_delivered,
        network_attempts: 0,
        receipt: persisted.receipt,
        persistent_state_written: persisted.persistent_files_written > 0,
        endpoint_included: false,
        credential_included: false,
        external_delivery_performed: true,
      };
    }
  } else if (await fileExists(expectedPending)) {
    throw new Error("A pending connector recovery marker exists; inspect it before another send attempt");
  }

  const bearer = readBearerCredential(profile, environment);
  const lock = lockPath(config.stateDirectory, request.request_id);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const maximumDispatchMs = profile.request_policy.timeout_ms * profile.request_policy.max_attempts
    + profile.request_policy.retry_delays_ms.reduce((sum, delay) => sum + delay, 0) + 60_000;
  const lockHandle = await acquireDispatchLock(lock, {
    request,
    profile,
    binding,
    recover: Boolean(recoverPath),
    staleAfterMs: maximumDispatchMs,
  });

  try {
    await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
    for (let attempt = 1; attempt <= profile.request_policy.max_attempts; attempt += 1) {
      if (attempt > 1) await sleepImpl(profile.request_policy.retry_delays_ms[attempt - 2]);
      marker = { ...marker, delivery_state: "attempting", attempts: attempt, last_failure: null, error: null };
      await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
      let response;
      try {
        response = await performAttempt({
          endpoint: profile.endpoint,
          body: requestBody,
          bearer,
          request,
          profile,
          fetchImpl,
        });
      } catch (error) {
        const responseLimit = /response exceeds/.test(String(error?.message ?? error));
        const retryable = !responseLimit && attempt < profile.request_policy.max_attempts;
        marker = {
          ...marker,
          delivery_state: retryable ? "retryable_failure" : "unknown",
          attempts: attempt,
          last_failure: { category: responseLimit ? "response_limit" : "transport", http_status: null, retryable },
          error: responseLimit ? "Connector response exceeded its configured byte limit" : "Connector transport did not confirm delivery",
        };
        await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
        if (retryable) continue;
        const dispatchError = new Error(responseLimit
          ? "Connector response exceeded its configured byte limit"
          : `Connector transport failed after ${attempt} attempt(s)`);
        dispatchError.pending_marker = expectedPending;
        dispatchError.external_request_attempted = true;
        dispatchError.external_delivery_performed = null;
        throw dispatchError;
      }
      if (response.status >= 200 && response.status <= 299) {
        const receipt = buildNotificationConnectorReceipt({
          request,
          binding,
          deliveredAt: timestamp.toISOString(),
          httpStatus: response.status,
          attempts: attempt,
        });
        marker = { ...marker, delivery_state: "confirmed", attempts: attempt, confirmed_receipt: receipt, last_failure: null, error: null };
        await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
        try {
          await beforeReceiptCommit(receipt);
          const persisted = await persistReceipt(targetReceipt, receipt);
          await fs.rm(expectedPending, { force: true });
          return {
            schema_version: 1,
            mode: "send",
            preview,
            sent: true,
            deferred: false,
            recovered: Boolean(recoverPath),
            already_delivered: persisted.already_delivered,
            network_attempts: attempt,
            receipt: persisted.receipt,
            persistent_state_written: persisted.persistent_files_written > 0,
            endpoint_included: false,
            credential_included: false,
            external_delivery_performed: true,
          };
        } catch (error) {
          marker = { ...marker, error: "Sanitized receipt commit failed after confirmed delivery" };
          await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n").catch(() => {});
          const commitError = new Error("Connector delivery was confirmed but the sanitized receipt could not be committed; use exact recovery");
          commitError.pending_marker = expectedPending;
          commitError.external_request_attempted = true;
          commitError.external_delivery_performed = true;
          throw commitError;
        }
      }
      const retryableStatus = isRetryableStatus(response.status);
      const willRetry = retryableStatus && attempt < profile.request_policy.max_attempts;
      marker = {
        ...marker,
        delivery_state: willRetry ? "retryable_failure" : retryableStatus ? "unknown" : "rejected",
        attempts: attempt,
        last_failure: { category: "http_status", http_status: response.status, retryable: retryableStatus },
        error: retryableStatus
          ? `Connector delivery outcome is unknown after HTTP ${response.status}`
          : `Connector rejected the request with HTTP ${response.status}`,
      };
      await atomicReplace(expectedPending, JSON.stringify(marker, null, 2) + "\n");
      if (willRetry) continue;
      const statusError = new Error(retryableStatus
        ? `Connector delivery outcome is unknown after HTTP ${response.status}`
        : `Connector rejected the request with HTTP ${response.status}`);
      statusError.pending_marker = expectedPending;
      statusError.external_request_attempted = true;
      statusError.external_delivery_performed = retryableStatus ? null : false;
      throw statusError;
    }
    throw new Error("Connector attempt limit was exhausted");
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.rm(lock, { force: true });
  }
}

async function main() {
  const result = await runNotificationConnectorDispatch({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    requestPath: argumentValue(process.argv, "--request"),
    profilePath: argumentValue(process.argv, "--profile"),
    bindingPath: argumentValue(process.argv, "--binding"),
    recoverPath: argumentValue(process.argv, "--recover"),
    approvalId: argumentValue(process.argv, "--approve"),
    now: argumentValue(process.argv, "--as-of", new Date().toISOString()),
    send: process.argv.includes("--send"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const hasDeliveryOutcome = Object.prototype.hasOwnProperty.call(error ?? {}, "external_delivery_performed");
    console.error(JSON.stringify({
      schema_version: 1,
      sent: false,
      external_request_attempted: error?.external_request_attempted === true,
      external_delivery_performed: hasDeliveryOutcome ? error.external_delivery_performed : false,
      error: String(error?.message ?? error),
      pending_marker: error?.pending_marker ?? null,
    }, null, 2));
    process.exitCode = 1;
  });
}
