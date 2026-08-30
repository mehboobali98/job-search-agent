import crypto from "node:crypto";
import {
  notificationConnectorRequestHash,
  validateNotificationConnectorReceipt,
  validateNotificationConnectorRecoveryMarker,
} from "./notification_connector_runtime.mjs";
import {
  notificationStatusApprovalIdForBindingId,
  notificationStatusRequestHash,
  validateNotificationStatusObservation,
  validateNotificationStatusRecoveryMarker,
} from "./notification_status_runtime.mjs";
import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";

export const NOTIFICATION_DELIVERY_HEALTH_SCHEMA_VERSION = 2;
export const MAX_NOTIFICATION_HEALTH_ARTIFACTS = 1_000;
export const MAX_NOTIFICATION_HEALTH_ARTIFACT_BYTES = 256 * 1024;

const STATUS = new Set(["confirmed", "rejected", "unknown", "deferred", "queued", "stale"]);
const CHANNEL = new Set(["email", "slack", "webhook", "custom"]);
const EVIDENCE = new Set([
  "none", "receipt", "recovery_marker", "provider_observation", "status_recovery_marker",
]);
const ACTION = new Set([
  "none", "wait_until_not_before", "review_outbox", "review_provider_status", "run_pending_inspection",
]);
const ARTIFACT_TYPE = new Set([
  "request", "receipt", "recovery_marker", "status_observation", "status_recovery_marker",
]);
const ISSUE_CODE = new Set([
  "invalid_json", "oversized", "not_regular_file", "invalid_contract", "filename_mismatch",
  "unsupported_adapter", "orphaned_receipt", "orphaned_marker", "receipt_mismatch", "marker_mismatch",
  "receipt_marker_conflict", "orphaned_status_observation", "orphaned_status_marker",
  "status_observation_mismatch", "status_marker_mismatch", "status_observation_conflict",
]);
const REPORT_FIELDS = new Set([
  "schema_version", "report_id", "as_of", "stale_after_hours", "counts", "requests", "artifact_issues",
  "guidance", "safety",
]);
const COUNT_FIELDS = new Set([
  "total_requests", "confirmed", "rejected", "unknown", "deferred", "queued", "stale",
  "requires_attention", "artifact_issues",
]);
const REQUEST_FIELDS = new Set([
  "request_id", "destination_id", "channel", "status", "created_at", "not_before", "last_activity_at",
  "age_hours", "attempts", "http_status", "receipt_id", "binding_id", "delivery_evidence",
  "status_observation_id", "status_binding_id", "provider_status", "provider_observed_at",
  "requires_attention", "recovery_required", "recovery_action",
]);
const ARTIFACT_FIELDS = new Set(["artifact_ref", "artifact_type", "issue_code"]);
const GUIDANCE_FIELDS = new Set(["pending_recovery_command", "automatic_retry_available"]);
const SAFETY_FIELDS = new Set([
  "read_only", "state_written", "network_accessed", "external_delivery_performed", "automatic_retry_performed",
  "profile_files_read", "credential_environment_read", "endpoint_included", "request_items_included",
  "candidate_artifacts_included", "private_paths_included",
]);

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
  for (const field of Object.keys(value)) if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
}

function dateValue(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function notificationHealthArtifactIssue(artifactType, issueCode, sourceReference) {
  if (!ARTIFACT_TYPE.has(artifactType) || !ISSUE_CODE.has(issueCode)) {
    throw new Error("Notification health artifact issue is invalid");
  }
  return {
    artifact_ref: stableId("NHART", { artifact_type: artifactType, source_reference: String(sourceReference) }),
    artifact_type: artifactType,
    issue_code: issueCode,
  };
}

function matchesReceipt(request, receipt) {
  return receipt.request_id === request.request_id
    && receipt.approval_id === request.approval_id
    && receipt.request_sha256 === notificationConnectorRequestHash(request);
}

function matchesMarker(request, marker) {
  return marker.request_id === request.request_id
    && marker.approval_id === request.approval_id
    && marker.request_sha256 === notificationConnectorRequestHash(request);
}

function matchesStatusObservation(request, observation) {
  return observation.request_id === request.request_id
    && observation.request_sha256 === notificationStatusRequestHash(request)
    && observation.approval_id === notificationStatusApprovalIdForBindingId(request, observation.binding_id);
}

function matchesStatusMarker(request, marker) {
  return marker.request_id === request.request_id
    && marker.request_sha256 === notificationStatusRequestHash(request)
    && marker.approval_id === notificationStatusApprovalIdForBindingId(request, marker.binding_id);
}

function ageHours(asOf, activity) {
  return Math.max(0, Math.min(1_000_000, Math.floor((asOf.getTime() - activity.getTime()) / 3_600_000)));
}

function requestHealth(
  request, receipt, marker, statusObservation, statusMarker, asOf, staleAfterHours, hasArtifactConflict,
) {
  let status;
  let lastActivity = dateValue(request.not_before, "Notification request not_before");
  let attempts = 0;
  let httpStatus = null;
  let receiptId = null;
  let bindingId = null;
  let statusObservationId = null;
  let statusBindingId = null;
  let providerStatus = null;
  let providerObservedAt = null;
  let deliveryEvidence = "none";
  let recoveryRequired = false;
  let recoveryAction = "none";

  if (receipt) {
    lastActivity = dateValue(receipt.delivered_at, "Connector receipt delivered_at");
    attempts = receipt.attempts;
    httpStatus = receipt.http_status;
    receiptId = receipt.receipt_id;
    bindingId = receipt.binding_id;
  } else if (marker) {
    lastActivity = dateValue(marker.created_at, "Connector recovery marker created_at");
    attempts = marker.attempts;
    httpStatus = marker.last_failure?.http_status ?? marker.confirmed_receipt?.http_status ?? null;
    receiptId = marker.confirmed_receipt?.receipt_id ?? null;
    bindingId = marker.binding_id;
  }

  let providerEvidence = statusObservation;
  if (statusMarker?.probe_state === "confirmed") providerEvidence = statusMarker.confirmed_observation;
  if (statusMarker) {
    deliveryEvidence = "status_recovery_marker";
    recoveryRequired = true;
    recoveryAction = "run_pending_inspection";
    statusBindingId = statusMarker.binding_id;
    lastActivity = dateValue(statusMarker.created_at, "Notification status recovery marker created_at");
    if (providerEvidence) {
      statusObservationId = providerEvidence.observation_id;
      statusBindingId = providerEvidence.binding_id;
      providerStatus = providerEvidence.delivery_status;
      providerObservedAt = providerEvidence.observed_at;
      lastActivity = dateValue(providerEvidence.observed_at, "Notification provider observed_at");
    }
    status = providerEvidence?.delivery_status === "delivered"
      ? "confirmed"
      : providerEvidence?.delivery_status === "rejected" ? "rejected" : "unknown";
  } else if (providerEvidence) {
    statusObservationId = providerEvidence.observation_id;
    statusBindingId = providerEvidence.binding_id;
    providerStatus = providerEvidence.delivery_status;
    providerObservedAt = providerEvidence.observed_at;
    lastActivity = dateValue(providerEvidence.observed_at, "Notification provider observed_at");
    deliveryEvidence = "provider_observation";
    if (providerStatus === "delivered") status = "confirmed";
    else if (providerStatus === "rejected") {
      status = "rejected";
      recoveryAction = "review_provider_status";
    } else if (providerStatus === "unknown") {
      status = "unknown";
      recoveryAction = "review_provider_status";
    } else if (ageHours(asOf, lastActivity) >= staleAfterHours) {
      status = "stale";
      recoveryAction = "review_provider_status";
    } else {
      status = "queued";
    }
  } else if (receipt) {
    status = "confirmed";
    deliveryEvidence = "receipt";
  } else if (marker) {
    deliveryEvidence = "recovery_marker";
    recoveryRequired = true;
    recoveryAction = "run_pending_inspection";
    status = marker.delivery_state === "confirmed"
      ? "confirmed"
      : marker.delivery_state === "rejected" ? "rejected" : "unknown";
  } else if (asOf < dateValue(request.not_before, "Notification request not_before")) {
    status = "deferred";
    recoveryAction = "wait_until_not_before";
  } else if (ageHours(asOf, lastActivity) >= staleAfterHours) {
    status = "stale";
    recoveryAction = "review_outbox";
  } else {
    status = "queued";
  }
  if ((marker && receipt) || hasArtifactConflict) {
    recoveryRequired = true;
    recoveryAction = "run_pending_inspection";
  }
  const requiresAttention = hasArtifactConflict || recoveryRequired || new Set(["rejected", "unknown", "stale"]).has(status);
  return {
    request_id: request.request_id,
    destination_id: request.destination.id,
    channel: request.destination.channel,
    status,
    created_at: request.created_at,
    not_before: request.not_before,
    last_activity_at: lastActivity.toISOString(),
    age_hours: ageHours(asOf, lastActivity),
    attempts,
    http_status: httpStatus,
    receipt_id: receiptId,
    binding_id: bindingId,
    status_observation_id: statusObservationId,
    status_binding_id: statusBindingId,
    provider_status: providerStatus,
    provider_observed_at: providerObservedAt,
    delivery_evidence: deliveryEvidence,
    requires_attention: requiresAttention,
    recovery_required: recoveryRequired,
    recovery_action: recoveryAction,
  };
}

export function buildNotificationDeliveryHealthReport({
  requests = [], receipts = [], recoveryMarkers = [], statusObservations = [], statusRecoveryMarkers = [], artifactIssues = [],
  asOf = new Date().toISOString(), staleAfterHours = 24,
} = {}) {
  const timestamp = dateValue(asOf, "Notification health as_of");
  boundedInteger(staleAfterHours, 1, 720, "Notification health stale_after_hours");
  if (!Array.isArray(requests) || !Array.isArray(receipts) || !Array.isArray(recoveryMarkers)
    || !Array.isArray(statusObservations) || !Array.isArray(statusRecoveryMarkers)
    || !Array.isArray(artifactIssues)) throw new Error("Notification health artifacts must be arrays");
  if (requests.length + receipts.length + recoveryMarkers.length + statusObservations.length
    + statusRecoveryMarkers.length > MAX_NOTIFICATION_HEALTH_ARTIFACTS) {
    throw new Error(`Notification health inspection supports at most ${MAX_NOTIFICATION_HEALTH_ARTIFACTS} artifacts`);
  }

  const requestMap = new Map();
  for (const request of requests) {
    validateNotificationDeliveryRequest(request);
    if (request.destination.adapter !== "connector") throw new Error("Notification health accepts connector outbox requests only");
    if (requestMap.has(request.request_id)) throw new Error("Notification health request IDs must be unique");
    requestMap.set(request.request_id, request);
  }
  const issues = artifactIssues.map((issue) => ({ ...issue }));
  const receiptMap = new Map();
  for (const receipt of receipts) {
    validateNotificationConnectorReceipt(receipt);
    const request = requestMap.get(receipt.request_id);
    if (!request) {
      issues.push(notificationHealthArtifactIssue("receipt", "orphaned_receipt", receipt.receipt_id));
    } else if (!matchesReceipt(request, receipt)) {
      issues.push(notificationHealthArtifactIssue("receipt", "receipt_mismatch", receipt.receipt_id));
    } else if (receiptMap.has(receipt.request_id)) {
      issues.push(notificationHealthArtifactIssue("receipt", "receipt_mismatch", receipt.receipt_id));
    } else {
      receiptMap.set(receipt.request_id, receipt);
    }
  }
  const markerMap = new Map();
  for (const marker of recoveryMarkers) {
    validateNotificationConnectorRecoveryMarker(marker);
    const request = requestMap.get(marker.request_id);
    if (!request) {
      issues.push(notificationHealthArtifactIssue("recovery_marker", "orphaned_marker", marker.request_id));
    } else if (!matchesMarker(request, marker)) {
      issues.push(notificationHealthArtifactIssue("recovery_marker", "marker_mismatch", marker.request_id));
    } else if (markerMap.has(marker.request_id)) {
      issues.push(notificationHealthArtifactIssue("recovery_marker", "marker_mismatch", marker.request_id));
    } else {
      markerMap.set(marker.request_id, marker);
    }
  }
  const statusObservationMap = new Map();
  for (const observation of statusObservations) {
    validateNotificationStatusObservation(observation);
    const request = requestMap.get(observation.request_id);
    if (!request) {
      issues.push(notificationHealthArtifactIssue(
        "status_observation", "orphaned_status_observation", observation.observation_id,
      ));
    } else if (!matchesStatusObservation(request, observation)) {
      issues.push(notificationHealthArtifactIssue(
        "status_observation", "status_observation_mismatch", observation.observation_id,
      ));
    } else {
      const existing = statusObservationMap.get(observation.request_id);
      if (existing && existing.observed_at === observation.observed_at
        && existing.delivery_status !== observation.delivery_status) {
        issues.push(notificationHealthArtifactIssue(
          "status_observation", "status_observation_conflict", `${existing.observation_id}:${observation.observation_id}`,
        ));
      }
      if (!existing || observation.observed_at > existing.observed_at
        || (observation.observed_at === existing.observed_at
          && observation.observation_id.localeCompare(existing.observation_id) > 0)) {
        statusObservationMap.set(observation.request_id, observation);
      }
    }
  }
  const statusMarkerMap = new Map();
  for (const marker of statusRecoveryMarkers) {
    validateNotificationStatusRecoveryMarker(marker);
    const request = requestMap.get(marker.request_id);
    if (!request) {
      issues.push(notificationHealthArtifactIssue(
        "status_recovery_marker", "orphaned_status_marker", marker.request_id,
      ));
    } else if (!matchesStatusMarker(request, marker)) {
      issues.push(notificationHealthArtifactIssue(
        "status_recovery_marker", "status_marker_mismatch", marker.request_id,
      ));
    } else if (statusMarkerMap.has(marker.request_id)) {
      issues.push(notificationHealthArtifactIssue(
        "status_recovery_marker", "status_marker_mismatch", marker.request_id,
      ));
    } else {
      statusMarkerMap.set(marker.request_id, marker);
    }
  }

  const conflicted = new Set();
  for (const requestId of requestMap.keys()) {
    if (receiptMap.has(requestId) && markerMap.has(requestId)) {
      const receipt = receiptMap.get(requestId);
      const marker = markerMap.get(requestId);
      issues.push(notificationHealthArtifactIssue(
        "recovery_marker", "receipt_marker_conflict", `${receipt.receipt_id}:${marker.request_id}`,
      ));
      conflicted.add(requestId);
    }
  }
  const healthRequests = [...requestMap.values()]
    .map((request) => requestHealth(
      request, receiptMap.get(request.request_id), markerMap.get(request.request_id),
      statusObservationMap.get(request.request_id), statusMarkerMap.get(request.request_id), timestamp,
      staleAfterHours, conflicted.has(request.request_id),
    ))
    .sort((left, right) => left.request_id.localeCompare(right.request_id));
  issues.sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const counts = {
    total_requests: healthRequests.length,
    confirmed: healthRequests.filter((item) => item.status === "confirmed").length,
    rejected: healthRequests.filter((item) => item.status === "rejected").length,
    unknown: healthRequests.filter((item) => item.status === "unknown").length,
    deferred: healthRequests.filter((item) => item.status === "deferred").length,
    queued: healthRequests.filter((item) => item.status === "queued").length,
    stale: healthRequests.filter((item) => item.status === "stale").length,
    requires_attention: healthRequests.filter((item) => item.requires_attention).length,
    artifact_issues: issues.length,
  };
  const seed = {
    as_of: timestamp.toISOString(), stale_after_hours: staleAfterHours, counts,
    requests: healthRequests, artifact_issues: issues,
  };
  return validateNotificationDeliveryHealthReport({
    schema_version: NOTIFICATION_DELIVERY_HEALTH_SCHEMA_VERSION,
    report_id: stableId("NHEALTH", seed),
    ...seed,
    guidance: { pending_recovery_command: "npm run pending", automatic_retry_available: false },
    safety: {
      read_only: true,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      automatic_retry_performed: false,
      profile_files_read: false,
      credential_environment_read: false,
      endpoint_included: false,
      request_items_included: false,
      candidate_artifacts_included: false,
      private_paths_included: false,
    },
  });
}

export function validateNotificationDeliveryHealthReport(report) {
  exactFields(report, REPORT_FIELDS, "notification delivery health report");
  if (report.schema_version !== NOTIFICATION_DELIVERY_HEALTH_SCHEMA_VERSION
    || !/^NHEALTH-[A-F0-9]{24}$/.test(String(report.report_id ?? ""))) {
    throw new Error("Notification delivery health report version or ID is invalid");
  }
  const timestamp = dateValue(report.as_of, "Notification health as_of");
  boundedInteger(report.stale_after_hours, 1, 720, "Notification health stale_after_hours");
  exactFields(report.counts, COUNT_FIELDS, "notification health counts");
  for (const field of COUNT_FIELDS) boundedInteger(report.counts[field], 0, 1_000, `Notification health counts.${field}`);
  if (!Array.isArray(report.requests) || report.requests.length > MAX_NOTIFICATION_HEALTH_ARTIFACTS) {
    throw new Error("Notification health requests are invalid");
  }
  const requestIds = new Set();
  let previousRequestId = null;
  for (const item of report.requests) {
    exactFields(item, REQUEST_FIELDS, "notification health request");
    if (!/^NREQ-[A-F0-9]{24}$/.test(String(item.request_id ?? "")) || requestIds.has(item.request_id)) {
      throw new Error("Notification health request ID is invalid or duplicated");
    }
    requestIds.add(item.request_id);
    if (previousRequestId !== null && previousRequestId.localeCompare(item.request_id) >= 0) {
      throw new Error("Notification health requests must be deterministically sorted");
    }
    previousRequestId = item.request_id;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(item.destination_id ?? ""))
      || !CHANNEL.has(item.channel) || !STATUS.has(item.status)) throw new Error("Notification health destination or status is invalid");
    const createdAt = dateValue(item.created_at, "Notification health request created_at");
    const notBefore = dateValue(item.not_before, "Notification health request not_before");
    const lastActivity = dateValue(item.last_activity_at, "Notification health request last_activity_at");
    if (notBefore < createdAt) throw new Error("Notification health request not_before cannot precede created_at");
    boundedInteger(item.age_hours, 0, 1_000_000, "Notification health request age_hours");
    if (item.age_hours !== ageHours(timestamp, lastActivity)) throw new Error("Notification health request age_hours is inconsistent");
    boundedInteger(item.attempts, 0, 3, "Notification health request attempts");
    if (item.http_status !== null) boundedInteger(item.http_status, 100, 599, "Notification health request http_status");
    if (item.receipt_id !== null && !/^NCREC-[A-F0-9]{24}$/.test(String(item.receipt_id))) throw new Error("Notification health receipt ID is invalid");
    if (item.binding_id !== null && !/^NCBIND-[A-F0-9]{24}$/.test(String(item.binding_id))) throw new Error("Notification health binding ID is invalid");
    if (item.status_observation_id !== null
      && !/^NSTATOBS-[A-F0-9]{24}$/.test(String(item.status_observation_id))) {
      throw new Error("Notification health status observation ID is invalid");
    }
    if (item.status_binding_id !== null
      && !/^NSTATBIND-[A-F0-9]{24}$/.test(String(item.status_binding_id))) {
      throw new Error("Notification health status binding ID is invalid");
    }
    if (item.provider_status !== null && !new Set(["delivered", "rejected", "pending", "unknown"]).has(item.provider_status)) {
      throw new Error("Notification health provider status is invalid");
    }
    if (item.provider_observed_at !== null) dateValue(item.provider_observed_at, "Notification health provider observed_at");
    if (!EVIDENCE.has(item.delivery_evidence) || !ACTION.has(item.recovery_action)
      || typeof item.requires_attention !== "boolean" || typeof item.recovery_required !== "boolean") {
      throw new Error("Notification health recovery fields are invalid");
    }
    const expectedAttention = item.recovery_required || new Set(["rejected", "unknown", "stale"]).has(item.status);
    if (item.requires_attention !== expectedAttention
      || item.recovery_required !== (item.recovery_action === "run_pending_inspection")) {
      throw new Error("Notification health attention flags are inconsistent");
    }
    const providerFieldsPresent = item.status_observation_id !== null && item.status_binding_id !== null
      && item.provider_status !== null && item.provider_observed_at !== null;
    const providerFieldsAbsent = item.status_observation_id === null && item.status_binding_id === null
      && item.provider_status === null && item.provider_observed_at === null;
    if (item.delivery_evidence === "receipt") {
      if (item.status !== "confirmed" || item.receipt_id === null || item.binding_id === null
        || item.attempts < 1 || item.http_status === null || item.http_status < 200 || item.http_status > 299
        || !providerFieldsAbsent || !new Set(["none", "run_pending_inspection"]).has(item.recovery_action)) {
        throw new Error("Notification health receipt evidence is inconsistent");
      }
    } else if (item.delivery_evidence === "recovery_marker") {
      if (!new Set(["confirmed", "rejected", "unknown"]).has(item.status) || item.binding_id === null
        || !providerFieldsAbsent || item.recovery_action !== "run_pending_inspection") {
        throw new Error("Notification health recovery-marker evidence is inconsistent");
      }
    } else if (item.delivery_evidence === "provider_observation") {
      const expectedStatus = item.provider_status === "delivered" ? "confirmed"
        : item.provider_status === "rejected" ? "rejected"
          : item.provider_status === "unknown" ? "unknown"
            : item.age_hours >= report.stale_after_hours ? "stale" : "queued";
      const expectedAction = item.provider_status === "delivered" || (item.provider_status === "pending" && expectedStatus === "queued")
        ? "none" : "review_provider_status";
      if (!providerFieldsPresent || item.last_activity_at !== new Date(item.provider_observed_at).toISOString()
        || item.status !== expectedStatus
        || item.recovery_action !== (item.recovery_required ? "run_pending_inspection" : expectedAction)) {
        throw new Error("Notification health provider observation evidence is inconsistent");
      }
    } else if (item.delivery_evidence === "status_recovery_marker") {
      const confirmedProvider = providerFieldsPresent;
      const unknownProvider = item.status_observation_id === null && item.status_binding_id !== null
        && item.provider_status === null && item.provider_observed_at === null;
      if ((!confirmedProvider && !unknownProvider) || item.recovery_action !== "run_pending_inspection"
        || !item.recovery_required || !new Set(["confirmed", "rejected", "unknown"]).has(item.status)) {
        throw new Error("Notification health status recovery-marker evidence is inconsistent");
      }
    } else if (item.attempts !== 0 || item.http_status !== null || item.receipt_id !== null || item.binding_id !== null
      || !providerFieldsAbsent || item.recovery_required || !new Set(["deferred", "queued", "stale"]).has(item.status)
      || item.last_activity_at !== notBefore.toISOString()
      || (item.status === "deferred" && (timestamp >= notBefore || item.recovery_action !== "wait_until_not_before"))
      || (item.status === "queued" && (timestamp < notBefore || item.age_hours >= report.stale_after_hours || item.recovery_action !== "none"))
      || (item.status === "stale" && (timestamp < notBefore || item.age_hours < report.stale_after_hours || item.recovery_action !== "review_outbox"))) {
      throw new Error("Notification health queued-state evidence is inconsistent");
    }
  }
  if (!Array.isArray(report.artifact_issues) || report.artifact_issues.length > MAX_NOTIFICATION_HEALTH_ARTIFACTS) {
    throw new Error("Notification health artifact issues are invalid");
  }
  const artifactRefs = new Set();
  let previousIssue = null;
  for (const issue of report.artifact_issues) {
    exactFields(issue, ARTIFACT_FIELDS, "notification health artifact issue");
    if (!/^NHART-[A-F0-9]{24}$/.test(String(issue.artifact_ref ?? ""))
      || !ARTIFACT_TYPE.has(issue.artifact_type) || !ISSUE_CODE.has(issue.issue_code)) {
      throw new Error("Notification health artifact issue is invalid");
    }
    if (artifactRefs.has(issue.artifact_ref)) throw new Error("Notification health artifact issue is duplicated");
    artifactRefs.add(issue.artifact_ref);
    const serialized = canonical(issue);
    if (previousIssue !== null && previousIssue.localeCompare(serialized) > 0) {
      throw new Error("Notification health artifact issues must be deterministically sorted");
    }
    previousIssue = serialized;
  }
  const statusTotal = [...STATUS].reduce((sum, status) => sum + report.counts[status], 0);
  if (report.counts.total_requests !== report.requests.length || statusTotal !== report.requests.length
    || report.counts.requires_attention !== report.requests.filter((item) => item.requires_attention).length
    || report.counts.artifact_issues !== report.artifact_issues.length) {
    throw new Error("Notification health counts do not match report content");
  }
  exactFields(report.guidance, GUIDANCE_FIELDS, "notification health guidance");
  if (report.guidance.pending_recovery_command !== "npm run pending"
    || report.guidance.automatic_retry_available !== false) throw new Error("Notification health guidance is invalid");
  exactFields(report.safety, SAFETY_FIELDS, "notification health safety");
  if (Object.entries(report.safety).some(([field, value]) => field === "read_only" ? value !== true : value !== false)) {
    throw new Error("Notification health safety flags are invalid");
  }
  const seed = {
    as_of: timestamp.toISOString(), stale_after_hours: report.stale_after_hours, counts: report.counts,
    requests: report.requests, artifact_issues: report.artifact_issues,
  };
  if (report.report_id !== stableId("NHEALTH", seed)) throw new Error("Notification health report ID does not match deterministic content");
  return report;
}
