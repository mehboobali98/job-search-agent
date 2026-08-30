import crypto from "node:crypto";
import { NOTIFICATION_CHANNELS } from "./project_config.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";
import { requireNotificationStatusOperation } from "./notification_status_contract.mjs";

export const NOTIFICATION_STATUS_PROFILE_SCHEMA_VERSION = 1;
export const NOTIFICATION_STATUS_BINDING_SCHEMA_VERSION = 1;
export const NOTIFICATION_STATUS_OBSERVATION_SCHEMA_VERSION = 1;
export const MAX_NOTIFICATION_STATUS_PROFILE_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_STATUS_BINDING_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_STATUS_REQUEST_BYTES = 16 * 1024;
export const MAX_NOTIFICATION_STATUS_RESPONSE_BYTES = 64 * 1024;

const PROFILE_FIELDS = new Set([
  "schema_version", "profile_id", "enabled", "connection_ref", "transport", "endpoint", "authentication",
  "allowed_destinations", "request_policy",
]);
const AUTH_FIELDS = new Set(["type", "environment_variable"]);
const DESTINATION_FIELDS = new Set(["destination_id", "channel"]);
const POLICY_FIELDS = new Set(["timeout_ms", "max_request_bytes", "max_response_bytes"]);
const BINDING_FIELDS = new Set([
  "schema_version", "binding_id", "approval_id", "profile_id", "profile_sha256", "connection_ref",
  "endpoint_sha256", "allowed_destinations", "request_policy", "safety",
]);
const BINDING_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "credential_environment_name_included",
  "destination_allowlist_required", "explicit_probe_required", "single_attempt_required",
]);
const OBSERVATION_FIELDS = new Set([
  "schema_version", "observation_id", "request_id", "approval_id", "binding_id", "request_sha256",
  "observed_at", "recorded_at", "delivery_status", "http_status", "network_attempts", "safety",
]);
const OBSERVATION_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "response_body_included", "request_items_included",
  "automatic_retry_performed", "external_delivery_performed", "application_submission_performed",
  "recruiter_outreach_performed",
]);
const PROVIDER_RESPONSE_FIELDS = new Set(["schema_version", "request_id", "delivery_status", "observed_at"]);
const RECOVERY_FIELDS = new Set([
  "schema_version", "workflow", "created_at", "request_id", "approval_id", "binding_id", "profile_id",
  "connection_ref", "request_sha256", "profile_sha256", "probe_state", "network_attempts", "last_failure",
  "confirmed_observation", "error", "safety",
]);
const RECOVERY_FAILURE_FIELDS = new Set(["category", "http_status"]);
const RECOVERY_SAFETY_FIELDS = new Set([
  "endpoint_included", "credential_included", "response_body_included", "request_items_included",
  "automatic_retry_performed", "external_delivery_performed",
]);
const CHANNELS = new Set(NOTIFICATION_CHANNELS.filter((channel) => channel !== "local"));
const DELIVERY_STATUS = new Set(["delivered", "rejected", "pending", "unknown"]);

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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
  }
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function dateValue(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp;
}

function opaqueReference(value, label, maximum = 128) {
  const text = String(value ?? "").trim();
  if (!new RegExp(`^[a-z0-9][a-z0-9._:-]{0,${maximum - 1}}$`, "i").test(text)
    || /(?:secret|token|password|api[_-]?key|credential)/i.test(text)) {
    throw new Error(`${label} must be a non-secret opaque reference`);
  }
  return text;
}

function validateAllowedDestinations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error("Status profile allowed_destinations must contain 1-10 entries");
  }
  const normalized = value.map((entry, index) => {
    exactFields(entry, DESTINATION_FIELDS, `status profile allowed_destinations[${index}]`);
    const destinationId = String(entry.destination_id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(destinationId) || !CHANNELS.has(entry.channel)) {
      throw new Error(`Status profile allowed_destinations[${index}] is invalid`);
    }
    return { destination_id: destinationId, channel: entry.channel };
  });
  const tuples = normalized.map((entry) => `${entry.destination_id}\u0000${entry.channel}`);
  if (new Set(tuples).size !== tuples.length) throw new Error("Status profile allowed_destinations contains duplicates");
  return normalized;
}

function validateRequestPolicy(value) {
  exactFields(value, POLICY_FIELDS, "status profile request_policy");
  return {
    timeout_ms: boundedInteger(value.timeout_ms, 1_000, 15_000, "Status profile timeout_ms"),
    max_request_bytes: boundedInteger(
      value.max_request_bytes, 1_024, MAX_NOTIFICATION_STATUS_REQUEST_BYTES, "Status profile max_request_bytes",
    ),
    max_response_bytes: boundedInteger(
      value.max_response_bytes, 1_024, MAX_NOTIFICATION_STATUS_RESPONSE_BYTES, "Status profile max_response_bytes",
    ),
  };
}

export function validateNotificationConnectorStatusProfile(value) {
  exactFields(value, PROFILE_FIELDS, "notification status profile");
  if (value.schema_version !== NOTIFICATION_STATUS_PROFILE_SCHEMA_VERSION) {
    throw new Error("Unsupported notification status profile schema_version");
  }
  const profileId = String(value.profile_id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileId)) throw new Error("Status profile profile_id is invalid");
  if (typeof value.enabled !== "boolean") throw new Error("Status profile enabled must be a boolean");
  const connectionRef = opaqueReference(value.connection_ref, "Status profile connection_ref");
  if (value.transport !== "https_json_bearer_status") {
    throw new Error("Status profile transport must be https_json_bearer_status");
  }
  let endpoint;
  try { endpoint = new URL(String(value.endpoint ?? "")); } catch { throw new Error("Status profile endpoint must be a valid HTTPS URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.href.length > 2_048) {
    throw new Error("Status profile endpoint must be a bounded HTTPS URL without user info, a query, or a fragment");
  }
  exactFields(value.authentication, AUTH_FIELDS, "status profile authentication");
  if (value.authentication.type !== "bearer_env") throw new Error("Status profile authentication type must be bearer_env");
  const environmentVariable = String(value.authentication.environment_variable ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(environmentVariable)) {
    throw new Error("Status profile authentication environment_variable is invalid");
  }
  return {
    schema_version: 1,
    profile_id: profileId,
    enabled: value.enabled,
    connection_ref: connectionRef,
    transport: "https_json_bearer_status",
    endpoint: endpoint.href,
    authentication: { type: "bearer_env", environment_variable: environmentVariable },
    allowed_destinations: validateAllowedDestinations(value.allowed_destinations),
    request_policy: validateRequestPolicy(value.request_policy),
  };
}

export function notificationStatusProfileHash(profile) {
  return sha256(canonical(validateNotificationConnectorStatusProfile(profile)));
}

function bindingSeed(profile) {
  return {
    profile_id: profile.profile_id,
    profile_sha256: notificationStatusProfileHash(profile),
    connection_ref: profile.connection_ref,
    endpoint_sha256: sha256(profile.endpoint),
    allowed_destinations: profile.allowed_destinations,
    request_policy: profile.request_policy,
  };
}

export function buildSanitizedNotificationStatusBinding(profile) {
  const validated = validateNotificationConnectorStatusProfile(profile);
  const seed = bindingSeed(validated);
  const bindingId = stableId("NSTATBIND", seed);
  return validateNotificationStatusBinding({
    schema_version: NOTIFICATION_STATUS_BINDING_SCHEMA_VERSION,
    binding_id: bindingId,
    approval_id: stableId("NSTATCON", { binding_id: bindingId }),
    ...seed,
    safety: {
      endpoint_included: false,
      credential_included: false,
      credential_environment_name_included: false,
      destination_allowlist_required: true,
      explicit_probe_required: true,
      single_attempt_required: true,
    },
  });
}

export function validateNotificationStatusBinding(value) {
  exactFields(value, BINDING_FIELDS, "notification status binding");
  if (value.schema_version !== NOTIFICATION_STATUS_BINDING_SCHEMA_VERSION
    || !/^NSTATBIND-[A-F0-9]{24}$/.test(String(value.binding_id ?? ""))
    || !/^NSTATCON-[A-F0-9]{24}$/.test(String(value.approval_id ?? ""))) {
    throw new Error("Notification status binding version or identifiers are invalid");
  }
  const normalized = {
    profile_id: String(value.profile_id ?? "").trim(),
    profile_sha256: String(value.profile_sha256 ?? ""),
    connection_ref: opaqueReference(value.connection_ref, "Status binding connection_ref"),
    endpoint_sha256: String(value.endpoint_sha256 ?? ""),
    allowed_destinations: validateAllowedDestinations(value.allowed_destinations),
    request_policy: validateRequestPolicy(value.request_policy),
  };
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized.profile_id)
    || !/^[a-f0-9]{64}$/.test(normalized.profile_sha256)
    || !/^[a-f0-9]{64}$/.test(normalized.endpoint_sha256)) {
    throw new Error("Notification status binding hashes or profile ID are invalid");
  }
  exactFields(value.safety, BINDING_SAFETY_FIELDS, "notification status binding safety");
  if (value.safety.endpoint_included !== false || value.safety.credential_included !== false
    || value.safety.credential_environment_name_included !== false
    || value.safety.destination_allowlist_required !== true || value.safety.explicit_probe_required !== true
    || value.safety.single_attempt_required !== true) throw new Error("Notification status binding safety flags are invalid");
  const bindingId = stableId("NSTATBIND", normalized);
  if (value.binding_id !== bindingId || value.approval_id !== stableId("NSTATCON", { binding_id: bindingId })) {
    throw new Error("Notification status binding IDs do not match deterministic content");
  }
  return value;
}

export function notificationStatusProfilePreview(profile) {
  const validated = validateNotificationConnectorStatusProfile(profile);
  const binding = buildSanitizedNotificationStatusBinding(validated);
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
    network_accessed: false,
    external_delivery_performed: false,
  };
}

export function authorizeNotificationStatusRequest(request, profile, binding) {
  validateNotificationDeliveryRequest(request);
  const validatedProfile = validateNotificationConnectorStatusProfile(profile);
  validateNotificationStatusBinding(binding);
  if (canonical(binding) !== canonical(buildSanitizedNotificationStatusBinding(validatedProfile))) {
    throw new Error("Status profile does not match its approved sanitized binding");
  }
  if (request.destination.adapter !== "connector") throw new Error("Status probe requires a connector outbox request");
  if (request.destination.connection_ref !== validatedProfile.connection_ref) {
    throw new Error("Status request connection_ref is not allowlisted by this profile");
  }
  const allowed = validatedProfile.allowed_destinations.some((destination) => (
    destination.destination_id === request.destination.id && destination.channel === request.destination.channel
  ));
  if (!allowed) throw new Error("Status request destination is not allowlisted by this profile");
  return { request, profile: validatedProfile, binding };
}

export function notificationStatusRequestHash(request) {
  validateNotificationDeliveryRequest(request);
  return sha256(canonical(request));
}

export function notificationStatusApprovalId(request, binding) {
  validateNotificationDeliveryRequest(request);
  validateNotificationStatusBinding(binding);
  return notificationStatusApprovalIdForBindingId(request, binding.binding_id);
}

export function notificationStatusApprovalIdForBindingId(request, bindingId) {
  validateNotificationDeliveryRequest(request);
  if (!/^NSTATBIND-[A-F0-9]{24}$/.test(String(bindingId ?? ""))) {
    throw new Error("Notification status binding ID is invalid");
  }
  return stableId("NSTAT", {
    request_id: request.request_id,
    request_sha256: notificationStatusRequestHash(request),
    binding_id: bindingId,
  });
}

export function buildNotificationStatusProbePlan(request, profile, binding) {
  const authorized = authorizeNotificationStatusRequest(request, profile, binding);
  const approvalId = notificationStatusApprovalId(request, binding);
  const operation = requireNotificationStatusOperation("notifications.status.read");
  const body = {
    schema_version: 1,
    operation,
    request_id: request.request_id,
    request_sha256: notificationStatusRequestHash(request),
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(body));
  if (requestBytes > authorized.profile.request_policy.max_request_bytes) {
    throw new Error("Notification status probe exceeds the configured request byte limit");
  }
  return {
    schema_version: 1,
    request_id: request.request_id,
    profile_id: authorized.profile.profile_id,
    binding_id: binding.binding_id,
    approval_id: approvalId,
    operation,
    destination: { id: request.destination.id, channel: request.destination.channel },
    request_bytes: requestBytes,
    request_limit_bytes: authorized.profile.request_policy.max_request_bytes,
    response_limit_bytes: authorized.profile.request_policy.max_response_bytes,
    timeout_ms: authorized.profile.request_policy.timeout_ms,
    maximum_attempts: 1,
    automatic_retry_available: false,
    explicit_probe_required: true,
    exact_approval_required: true,
    authenticated_private_profile_required: true,
    approved_sanitized_binding_required: true,
    destination_allowlist_required: true,
    read_only_external_operation: true,
    endpoint_included: false,
    credential_included: false,
    request_items_included: false,
    network_accessed: false,
    external_delivery_performed: false,
    body,
  };
}

export function validateNotificationStatusProviderResponse(value, request) {
  validateNotificationDeliveryRequest(request);
  exactFields(value, PROVIDER_RESPONSE_FIELDS, "notification status provider response");
  if (value.schema_version !== 1 || value.request_id !== request.request_id || !DELIVERY_STATUS.has(value.delivery_status)) {
    throw new Error("Notification status provider response does not match the approved request");
  }
  const observedAt = dateValue(value.observed_at, "Notification status provider observed_at");
  if (observedAt < dateValue(request.created_at, "Notification request created_at")) {
    throw new Error("Notification status provider observation predates the request");
  }
  return {
    schema_version: 1,
    request_id: request.request_id,
    delivery_status: value.delivery_status,
    observed_at: observedAt.toISOString(),
  };
}

export function buildNotificationStatusObservation({ request, binding, providerResponse, recordedAt, httpStatus }) {
  validateNotificationDeliveryRequest(request);
  validateNotificationStatusBinding(binding);
  const response = validateNotificationStatusProviderResponse(providerResponse, request);
  const recorded = dateValue(recordedAt, "Notification status recorded_at");
  const observed = dateValue(response.observed_at, "Notification status observed_at");
  if (observed.getTime() > recorded.getTime() + 5 * 60_000) {
    throw new Error("Notification status provider observation is unreasonably in the future");
  }
  boundedInteger(httpStatus, 200, 299, "Notification status http_status");
  const approvalId = notificationStatusApprovalId(request, binding);
  const seed = {
    request_id: request.request_id,
    binding_id: binding.binding_id,
    observed_at: observed.toISOString(),
    recorded_at: recorded.toISOString(),
    delivery_status: response.delivery_status,
  };
  return validateNotificationStatusObservation({
    schema_version: NOTIFICATION_STATUS_OBSERVATION_SCHEMA_VERSION,
    observation_id: stableId("NSTATOBS", seed),
    request_id: request.request_id,
    approval_id: approvalId,
    binding_id: binding.binding_id,
    request_sha256: notificationStatusRequestHash(request),
    observed_at: observed.toISOString(),
    recorded_at: recorded.toISOString(),
    delivery_status: response.delivery_status,
    http_status: httpStatus,
    network_attempts: 1,
    safety: {
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      request_items_included: false,
      automatic_retry_performed: false,
      external_delivery_performed: false,
      application_submission_performed: false,
      recruiter_outreach_performed: false,
    },
  });
}

export function validateNotificationStatusObservation(value) {
  exactFields(value, OBSERVATION_FIELDS, "notification status observation");
  if (value.schema_version !== NOTIFICATION_STATUS_OBSERVATION_SCHEMA_VERSION
    || !/^NSTATOBS-[A-F0-9]{24}$/.test(String(value.observation_id ?? ""))
    || !/^NREQ-[A-F0-9]{24}$/.test(String(value.request_id ?? ""))
    || !/^NSTAT-[A-F0-9]{24}$/.test(String(value.approval_id ?? ""))
    || !/^NSTATBIND-[A-F0-9]{24}$/.test(String(value.binding_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.request_sha256 ?? ""))
    || !DELIVERY_STATUS.has(value.delivery_status)) throw new Error("Notification status observation identifiers are invalid");
  const observed = dateValue(value.observed_at, "Notification status observed_at");
  const recorded = dateValue(value.recorded_at, "Notification status recorded_at");
  if (observed.getTime() > recorded.getTime() + 5 * 60_000) {
    throw new Error("Notification status observation timestamp is invalid");
  }
  boundedInteger(value.http_status, 200, 299, "Notification status observation http_status");
  if (value.network_attempts !== 1) throw new Error("Notification status observation must record exactly one network attempt");
  exactFields(value.safety, OBSERVATION_SAFETY_FIELDS, "notification status observation safety");
  if (Object.values(value.safety).some((flag) => flag !== false)) {
    throw new Error("Notification status observation safety flags are invalid");
  }
  const seed = {
    request_id: value.request_id,
    binding_id: value.binding_id,
    observed_at: observed.toISOString(),
    recorded_at: recorded.toISOString(),
    delivery_status: value.delivery_status,
  };
  if (value.observation_id !== stableId("NSTATOBS", seed)) {
    throw new Error("Notification status observation ID does not match deterministic content");
  }
  return value;
}

export function validateNotificationStatusRecoveryMarker(marker, { request = null, profile = null, binding = null } = {}) {
  exactFields(marker, RECOVERY_FIELDS, "notification status recovery marker");
  if (marker.schema_version !== 1 || marker.workflow !== "notification_connector_status_probe"
    || !Number.isFinite(new Date(marker.created_at).getTime())
    || !/^NREQ-[A-F0-9]{24}$/.test(String(marker.request_id ?? ""))
    || !/^NSTAT-[A-F0-9]{24}$/.test(String(marker.approval_id ?? ""))
    || !/^NSTATBIND-[A-F0-9]{24}$/.test(String(marker.binding_id ?? ""))
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(marker.profile_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(marker.request_sha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(marker.profile_sha256 ?? ""))) {
    throw new Error("Notification status recovery marker identifiers are invalid");
  }
  opaqueReference(marker.connection_ref, "Notification status recovery connection_ref");
  if (!new Set(["attempting", "unknown", "confirmed"]).has(marker.probe_state)
    || !Number.isInteger(marker.network_attempts) || marker.network_attempts < 0 || marker.network_attempts > 1) {
    throw new Error("Notification status recovery marker state is invalid");
  }
  if (marker.error !== null && (typeof marker.error !== "string" || !marker.error || marker.error.length > 240
    || /[\r\n]/.test(marker.error))) throw new Error("Notification status recovery marker error is invalid");
  if (marker.last_failure !== null) {
    exactFields(marker.last_failure, RECOVERY_FAILURE_FIELDS, "notification status recovery failure");
    if (!new Set(["transport", "http_status", "response_limit", "invalid_response"]).has(marker.last_failure.category)
      || (marker.last_failure.http_status !== null
        && (!Number.isInteger(marker.last_failure.http_status)
          || marker.last_failure.http_status < 100 || marker.last_failure.http_status > 599))) {
      throw new Error("Notification status recovery failure is invalid");
    }
  }
  exactFields(marker.safety, RECOVERY_SAFETY_FIELDS, "notification status recovery safety");
  if (marker.safety.endpoint_included !== false || marker.safety.credential_included !== false
    || marker.safety.response_body_included !== false || marker.safety.request_items_included !== false
    || marker.safety.automatic_retry_performed !== false || marker.safety.external_delivery_performed !== false) {
    throw new Error("Notification status recovery safety flags are invalid");
  }
  if (marker.probe_state === "confirmed") validateNotificationStatusObservation(marker.confirmed_observation);
  else if (marker.confirmed_observation !== null) throw new Error("Unconfirmed status recovery cannot contain an observation");

  if (request || profile || binding) {
    if (!request || !profile || !binding) throw new Error("Exact status recovery requires request, profile, and binding");
    const authorized = authorizeNotificationStatusRequest(request, profile, binding);
    const expected = {
      request_id: request.request_id,
      approval_id: notificationStatusApprovalId(request, binding),
      binding_id: binding.binding_id,
      profile_id: authorized.profile.profile_id,
      connection_ref: authorized.profile.connection_ref,
      request_sha256: notificationStatusRequestHash(request),
      profile_sha256: binding.profile_sha256,
    };
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (marker[field] !== expectedValue) throw new Error(`Notification status recovery ${field} does not match exact inputs`);
    }
    if (marker.confirmed_observation) {
      const observation = marker.confirmed_observation;
      if (observation.request_id !== request.request_id || observation.approval_id !== expected.approval_id
        || observation.binding_id !== binding.binding_id || observation.request_sha256 !== expected.request_sha256) {
        throw new Error("Confirmed notification status observation does not match recovery inputs");
      }
    }
  }
  return marker;
}
