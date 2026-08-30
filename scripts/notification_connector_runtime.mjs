import crypto from "node:crypto";
import { NOTIFICATION_CHANNELS } from "./project_config.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";

export const NOTIFICATION_CONNECTOR_PROFILE_SCHEMA_VERSION = 1;
export const NOTIFICATION_CONNECTOR_BINDING_SCHEMA_VERSION = 1;
export const NOTIFICATION_CONNECTOR_RECEIPT_SCHEMA_VERSION = 1;
export const MAX_CONNECTOR_PROFILE_BYTES = 64 * 1024;
export const MAX_CONNECTOR_BINDING_BYTES = 64 * 1024;
export const MAX_CONNECTOR_REQUEST_BYTES = 256 * 1024;

const PROFILE_FIELDS = new Set([
  "schema_version", "profile_id", "enabled", "connection_ref", "transport", "endpoint", "authentication",
  "allowed_destinations", "request_policy", "idempotency",
]);
const AUTH_FIELDS = new Set(["type", "environment_variable"]);
const DESTINATION_FIELDS = new Set(["destination_id", "channel"]);
const REQUEST_POLICY_FIELDS = new Set([
  "timeout_ms", "max_request_bytes", "max_response_bytes", "max_attempts", "retry_delays_ms",
]);
const IDEMPOTENCY_FIELDS = new Set(["required", "header"]);
const BINDING_FIELDS = new Set([
  "schema_version", "binding_id", "approval_id", "profile_id", "profile_sha256", "connection_ref",
  "endpoint_sha256", "allowed_destinations", "request_policy", "safety",
]);
const BINDING_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "credential_environment_name_included",
  "destination_allowlist_required", "explicit_send_required",
]);
const RECEIPT_FIELDS = new Set([
  "schema_version", "receipt_id", "request_id", "approval_id", "binding_id", "request_sha256", "delivered_at",
  "http_status", "attempts", "idempotency_key", "safety",
]);
const RECEIPT_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "response_body_included",
  "application_submission_performed", "recruiter_outreach_performed",
]);
const RECOVERY_MARKER_FIELDS = new Set([
  "schema_version", "workflow", "created_at", "request_id", "approval_id", "binding_id", "profile_id",
  "connection_ref", "request_sha256", "profile_sha256", "idempotency_key", "delivery_state", "attempts",
  "last_failure", "confirmed_receipt", "error", "safety",
]);
const RECOVERY_MARKER_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "response_body_included", "request_items_included",
]);
const RECOVERY_MARKER_FAILURE_FIELDS = new Set(["category", "http_status", "retryable"]);
const CHANNELS = new Set(NOTIFICATION_CHANNELS.filter((channel) => channel !== "local"));

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableId(prefix, value) {
  return `${prefix}-${sha256(canonical(value)).slice(0, 24).toUpperCase()}`;
}

function exactFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
  }
}

function opaqueReference(value, label, maximum = 128) {
  const text = String(value ?? "").trim();
  if (!new RegExp(`^[a-z0-9][a-z0-9._:-]{0,${maximum - 1}}$`, "i").test(text)
    || /(?:secret|token|password|api[_-]?key|credential)/i.test(text)) {
    throw new Error(`${label} must be a non-secret opaque reference`);
  }
  return text;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateAllowedDestinations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error("Connector profile allowed_destinations must contain 1-10 entries");
  }
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Connector profile allowed_destinations[${index}] must be an object`);
    }
    exactFields(entry, DESTINATION_FIELDS, `connector profile allowed_destinations[${index}]`);
    const destinationId = String(entry.destination_id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(destinationId)) {
      throw new Error(`Connector profile allowed_destinations[${index}].destination_id is invalid`);
    }
    if (!CHANNELS.has(entry.channel)) {
      throw new Error(`Connector profile allowed_destinations[${index}].channel is unsupported`);
    }
    return { destination_id: destinationId, channel: entry.channel };
  });
  const tuples = normalized.map((entry) => `${entry.destination_id}\u0000${entry.channel}`);
  if (new Set(tuples).size !== tuples.length) throw new Error("Connector profile allowed_destinations contains duplicates");
  return normalized;
}

function validateRequestPolicy(requestPolicy) {
  if (!requestPolicy || typeof requestPolicy !== "object" || Array.isArray(requestPolicy)) {
    throw new Error("Connector profile request_policy must be an object");
  }
  exactFields(requestPolicy, REQUEST_POLICY_FIELDS, "connector profile request_policy");
  const timeoutMs = boundedInteger(requestPolicy.timeout_ms, 1_000, 15_000, "Connector profile timeout_ms");
  const maxRequestBytes = boundedInteger(requestPolicy.max_request_bytes, 1_024, MAX_CONNECTOR_REQUEST_BYTES, "Connector profile max_request_bytes");
  const maxResponseBytes = boundedInteger(requestPolicy.max_response_bytes, 1_024, 65_536, "Connector profile max_response_bytes");
  const maxAttempts = boundedInteger(requestPolicy.max_attempts, 1, 3, "Connector profile max_attempts");
  if (!Array.isArray(requestPolicy.retry_delays_ms) || requestPolicy.retry_delays_ms.length !== maxAttempts - 1) {
    throw new Error("Connector profile retry_delays_ms must contain one delay for each retry");
  }
  const retryDelays = requestPolicy.retry_delays_ms.map((delay, index) => boundedInteger(
    delay, 0, 5_000, `Connector profile retry_delays_ms[${index}]`,
  ));
  if (retryDelays.some((delay, index) => index > 0 && delay < retryDelays[index - 1])
    || retryDelays.reduce((sum, delay) => sum + delay, 0) > 10_000) {
    throw new Error("Connector profile retry delays must be non-decreasing and total at most 10000ms");
  }
  return {
    timeout_ms: timeoutMs,
    max_request_bytes: maxRequestBytes,
    max_response_bytes: maxResponseBytes,
    max_attempts: maxAttempts,
    retry_delays_ms: retryDelays,
  };
}

export function validateNotificationConnectorProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connector profile must be an object");
  exactFields(value, PROFILE_FIELDS, "connector profile");
  if (value.schema_version !== NOTIFICATION_CONNECTOR_PROFILE_SCHEMA_VERSION) {
    throw new Error("Unsupported connector profile schema_version");
  }
  const profileId = String(value.profile_id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileId)) throw new Error("Connector profile profile_id is invalid");
  if (typeof value.enabled !== "boolean") throw new Error("Connector profile enabled must be a boolean");
  const connectionRef = opaqueReference(value.connection_ref, "Connector profile connection_ref");
  if (value.transport !== "https_json_bearer") throw new Error("Connector profile transport must be https_json_bearer");
  let endpoint;
  try { endpoint = new URL(String(value.endpoint ?? "")); } catch { throw new Error("Connector profile endpoint must be a valid HTTPS URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href.length > 2_048) {
    throw new Error("Connector profile endpoint must be a bounded HTTPS URL without user info, a query, or a fragment");
  }
  const authentication = value.authentication;
  if (!authentication || typeof authentication !== "object" || Array.isArray(authentication)) {
    throw new Error("Connector profile authentication must be an object");
  }
  exactFields(authentication, AUTH_FIELDS, "connector profile authentication");
  if (authentication.type !== "bearer_env") throw new Error("Connector profile authentication type must be bearer_env");
  const environmentVariable = String(authentication.environment_variable ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(environmentVariable)) {
    throw new Error("Connector profile authentication environment_variable is invalid");
  }
  const idempotency = value.idempotency;
  if (!idempotency || typeof idempotency !== "object" || Array.isArray(idempotency)) {
    throw new Error("Connector profile idempotency must be an object");
  }
  exactFields(idempotency, IDEMPOTENCY_FIELDS, "connector profile idempotency");
  if (idempotency.required !== true || idempotency.header !== "Idempotency-Key") {
    throw new Error("Connector profile must require the Idempotency-Key header");
  }
  return {
    schema_version: 1,
    profile_id: profileId,
    enabled: value.enabled,
    connection_ref: connectionRef,
    transport: "https_json_bearer",
    endpoint: endpoint.href,
    authentication: { type: "bearer_env", environment_variable: environmentVariable },
    allowed_destinations: validateAllowedDestinations(value.allowed_destinations),
    request_policy: validateRequestPolicy(value.request_policy),
    idempotency: { required: true, header: "Idempotency-Key" },
  };
}

export function notificationConnectorProfileHash(profile) {
  return sha256(canonical(validateNotificationConnectorProfile(profile)));
}

function bindingSeed(profile) {
  return {
    profile_id: profile.profile_id,
    profile_sha256: notificationConnectorProfileHash(profile),
    connection_ref: profile.connection_ref,
    endpoint_sha256: sha256(profile.endpoint),
    allowed_destinations: profile.allowed_destinations,
    request_policy: profile.request_policy,
  };
}

export function buildSanitizedNotificationConnectorBinding(profile) {
  const validated = validateNotificationConnectorProfile(profile);
  const seed = bindingSeed(validated);
  const bindingId = stableId("NCBIND", seed);
  const binding = {
    schema_version: NOTIFICATION_CONNECTOR_BINDING_SCHEMA_VERSION,
    binding_id: bindingId,
    approval_id: stableId("NCON", { binding_id: bindingId }),
    ...seed,
    safety: {
      endpoint_included: false,
      credential_included: false,
      credential_environment_name_included: false,
      destination_allowlist_required: true,
      explicit_send_required: true,
    },
  };
  return validateNotificationConnectorBinding(binding);
}

export function validateNotificationConnectorBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Connector binding must be an object");
  exactFields(binding, BINDING_FIELDS, "connector binding");
  if (binding.schema_version !== NOTIFICATION_CONNECTOR_BINDING_SCHEMA_VERSION) {
    throw new Error("Unsupported connector binding schema_version");
  }
  if (!/^NCBIND-[A-F0-9]{24}$/.test(String(binding.binding_id ?? ""))) throw new Error("Connector binding_id is invalid");
  if (!/^NCON-[A-F0-9]{24}$/.test(String(binding.approval_id ?? ""))) throw new Error("Connector binding approval_id is invalid");
  const normalized = {
    profile_id: String(binding.profile_id ?? "").trim(),
    profile_sha256: String(binding.profile_sha256 ?? ""),
    connection_ref: opaqueReference(binding.connection_ref, "Connector binding connection_ref"),
    endpoint_sha256: String(binding.endpoint_sha256 ?? ""),
    allowed_destinations: validateAllowedDestinations(binding.allowed_destinations),
    request_policy: binding.request_policy,
  };
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized.profile_id)
    || !/^[a-f0-9]{64}$/.test(normalized.profile_sha256)
    || !/^[a-f0-9]{64}$/.test(normalized.endpoint_sha256)) throw new Error("Connector binding hashes or profile ID are invalid");
  normalized.request_policy = validateRequestPolicy(normalized.request_policy);
  if (!binding.safety || typeof binding.safety !== "object" || Array.isArray(binding.safety)) {
    throw new Error("Connector binding safety must be an object");
  }
  exactFields(binding.safety, BINDING_SAFETY_FIELDS, "connector binding safety");
  if (binding.safety.endpoint_included !== false || binding.safety.credential_included !== false
    || binding.safety?.credential_environment_name_included !== false
    || binding.safety?.destination_allowlist_required !== true || binding.safety?.explicit_send_required !== true) {
    throw new Error("Connector binding safety flags are invalid");
  }
  const seed = { ...normalized };
  const expectedBindingId = stableId("NCBIND", seed);
  if (binding.binding_id !== expectedBindingId || binding.approval_id !== stableId("NCON", { binding_id: expectedBindingId })) {
    throw new Error("Connector binding IDs do not match deterministic content");
  }
  return binding;
}

export function authorizeNotificationConnectorRequest(request, profile, binding) {
  validateNotificationDeliveryRequest(request);
  const validatedProfile = validateNotificationConnectorProfile(profile);
  validateNotificationConnectorBinding(binding);
  const expectedBinding = buildSanitizedNotificationConnectorBinding(validatedProfile);
  if (canonical(binding) !== canonical(expectedBinding)) throw new Error("Connector profile does not match its approved sanitized binding");
  if (request.destination.adapter !== "connector") throw new Error("Live connector requires a connector outbox request");
  if (request.destination.connection_ref !== validatedProfile.connection_ref) {
    throw new Error("Connector request connection_ref is not allowlisted by this profile");
  }
  const allowed = validatedProfile.allowed_destinations.some((destination) => (
    destination.destination_id === request.destination.id && destination.channel === request.destination.channel
  ));
  if (!allowed) throw new Error("Connector request destination is not allowlisted by this profile");
  return { request, profile: validatedProfile, binding };
}

export function notificationConnectorRequestHash(request) {
  validateNotificationDeliveryRequest(request);
  return sha256(canonical(request));
}

export function buildNotificationConnectorReceipt({ request, binding, deliveredAt, httpStatus, attempts }) {
  validateNotificationDeliveryRequest(request);
  validateNotificationConnectorBinding(binding);
  const timestamp = new Date(deliveredAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Connector receipt delivered_at is invalid");
  boundedInteger(httpStatus, 200, 299, "Connector receipt http_status");
  boundedInteger(attempts, 1, binding.request_policy.max_attempts, "Connector receipt attempts");
  const seed = { request_id: request.request_id, binding_id: binding.binding_id };
  const receipt = {
    schema_version: NOTIFICATION_CONNECTOR_RECEIPT_SCHEMA_VERSION,
    receipt_id: stableId("NCREC", seed),
    request_id: request.request_id,
    approval_id: request.approval_id,
    binding_id: binding.binding_id,
    request_sha256: notificationConnectorRequestHash(request),
    delivered_at: timestamp.toISOString(),
    http_status: httpStatus,
    attempts,
    idempotency_key: request.request_id,
    safety: {
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      application_submission_performed: false,
      recruiter_outreach_performed: false,
    },
  };
  return validateNotificationConnectorReceipt(receipt);
}

export function validateNotificationConnectorReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Connector receipt must be an object");
  exactFields(receipt, RECEIPT_FIELDS, "connector receipt");
  if (receipt.schema_version !== NOTIFICATION_CONNECTOR_RECEIPT_SCHEMA_VERSION) throw new Error("Unsupported connector receipt schema_version");
  if (!/^NCREC-[A-F0-9]{24}$/.test(String(receipt.receipt_id ?? ""))
    || !/^NREQ-[A-F0-9]{24}$/.test(String(receipt.request_id ?? ""))
    || !/^NAPP-[A-F0-9]{24}$/.test(String(receipt.approval_id ?? ""))
    || !/^NCBIND-[A-F0-9]{24}$/.test(String(receipt.binding_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(receipt.request_sha256 ?? ""))) throw new Error("Connector receipt identifiers are invalid");
  if (!Number.isFinite(new Date(receipt.delivered_at).getTime())) throw new Error("Connector receipt delivered_at is invalid");
  boundedInteger(receipt.http_status, 200, 299, "Connector receipt http_status");
  boundedInteger(receipt.attempts, 1, 3, "Connector receipt attempts");
  if (receipt.idempotency_key !== receipt.request_id) throw new Error("Connector receipt idempotency key is invalid");
  if (!receipt.safety || typeof receipt.safety !== "object" || Array.isArray(receipt.safety)) {
    throw new Error("Connector receipt safety must be an object");
  }
  exactFields(receipt.safety, RECEIPT_SAFETY_FIELDS, "connector receipt safety");
  if (receipt.safety.endpoint_included !== false || receipt.safety.credential_included !== false
    || receipt.safety?.response_body_included !== false || receipt.safety?.application_submission_performed !== false
    || receipt.safety?.recruiter_outreach_performed !== false) throw new Error("Connector receipt safety flags are invalid");
  if (receipt.receipt_id !== stableId("NCREC", { request_id: receipt.request_id, binding_id: receipt.binding_id })) {
    throw new Error("Connector receipt ID does not match deterministic content");
  }
  return receipt;
}

export function validateNotificationConnectorRecoveryMarker(marker, { request = null, profile = null, binding = null } = {}) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)
    || marker.workflow !== "notification_connector_dispatch") {
    throw new Error("Recovery marker is not a notification-connector marker");
  }
  exactFields(marker, RECOVERY_MARKER_FIELDS, "connector recovery marker");
  if (marker.schema_version !== 1 || !Number.isFinite(new Date(marker.created_at).getTime())) {
    throw new Error("Recovery marker version or timestamp is invalid");
  }
  if (!/^NREQ-[A-F0-9]{24}$/.test(String(marker.request_id ?? ""))
    || !/^NAPP-[A-F0-9]{24}$/.test(String(marker.approval_id ?? ""))
    || !/^NCBIND-[A-F0-9]{24}$/.test(String(marker.binding_id ?? ""))
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(marker.profile_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(marker.request_sha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(marker.profile_sha256 ?? ""))) {
    throw new Error("Recovery marker identifiers or hashes are invalid");
  }
  opaqueReference(marker.connection_ref, "Recovery marker connection_ref");
  if (marker.idempotency_key !== marker.request_id) throw new Error("Recovery marker idempotency key is invalid");
  if (!Number.isInteger(marker.attempts) || marker.attempts < 0 || marker.attempts > 3) {
    throw new Error("Recovery marker attempt count is invalid");
  }
  if (!new Set(["attempting", "retryable_failure", "unknown", "rejected", "confirmed"]).has(marker.delivery_state)) {
    throw new Error("Recovery marker delivery_state is invalid");
  }
  if (!marker.safety || typeof marker.safety !== "object" || Array.isArray(marker.safety)) {
    throw new Error("Recovery marker safety must be an object");
  }
  exactFields(marker.safety, RECOVERY_MARKER_SAFETY_FIELDS, "connector recovery marker safety");
  if (marker.safety.endpoint_included !== false || marker.safety.credential_included !== false
    || marker.safety.response_body_included !== false || marker.safety.request_items_included !== false) {
    throw new Error("Recovery marker safety flags are invalid");
  }
  if (marker.error !== null && (typeof marker.error !== "string" || !marker.error
    || marker.error.length > 240 || /[\r\n]/.test(marker.error))) {
    throw new Error("Recovery marker error summary is invalid");
  }
  if (marker.last_failure !== null) {
    if (!marker.last_failure || typeof marker.last_failure !== "object" || Array.isArray(marker.last_failure)) {
      throw new Error("Recovery marker last_failure is invalid");
    }
    exactFields(marker.last_failure, RECOVERY_MARKER_FAILURE_FIELDS, "connector recovery marker last_failure");
    if (!new Set(["response_limit", "transport", "http_status"]).has(marker.last_failure.category)
      || (marker.last_failure.http_status !== null
        && (!Number.isInteger(marker.last_failure.http_status)
          || marker.last_failure.http_status < 100 || marker.last_failure.http_status > 599))
      || typeof marker.last_failure.retryable !== "boolean") {
      throw new Error("Recovery marker last_failure is invalid");
    }
  }
  if (marker.delivery_state === "confirmed") {
    const receipt = validateNotificationConnectorReceipt(marker.confirmed_receipt);
    if (receipt.request_id !== marker.request_id || receipt.approval_id !== marker.approval_id
      || receipt.binding_id !== marker.binding_id || receipt.request_sha256 !== marker.request_sha256) {
      throw new Error("Confirmed recovery receipt does not match the recovery marker");
    }
  } else if (marker.confirmed_receipt !== null) {
    throw new Error("Unconfirmed recovery marker cannot contain a receipt");
  }

  if (request || profile || binding) {
    if (!request || !profile || !binding) throw new Error("Exact recovery validation requires request, profile, and binding");
    validateNotificationDeliveryRequest(request);
    const validatedProfile = validateNotificationConnectorProfile(profile);
    validateNotificationConnectorBinding(binding);
    const expected = {
      request_id: request.request_id,
      approval_id: request.approval_id,
      binding_id: binding.binding_id,
      profile_id: validatedProfile.profile_id,
      connection_ref: validatedProfile.connection_ref,
      request_sha256: notificationConnectorRequestHash(request),
      profile_sha256: binding.profile_sha256,
      idempotency_key: request.request_id,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (marker[key] !== value) throw new Error(`Recovery marker ${key} does not match the private connector inputs`);
    }
    if (marker.attempts > binding.request_policy.max_attempts) throw new Error("Recovery marker attempt count is invalid");
  }
  return marker;
}

export function notificationConnectorProfilePreview(profile) {
  const validated = validateNotificationConnectorProfile(profile);
  const binding = buildSanitizedNotificationConnectorBinding(validated);
  return {
    schema_version: 1,
    profile_id: validated.profile_id,
    enabled: validated.enabled,
    connection_ref: validated.connection_ref,
    transport: validated.transport,
    allowed_destinations: validated.allowed_destinations,
    request_policy: validated.request_policy,
    binding,
    approval_id: binding.approval_id,
    endpoint_included: false,
    credential_included: false,
    credential_environment_name_included: false,
    external_delivery_performed: false,
  };
}
