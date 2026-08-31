import crypto from "node:crypto";
import { NOTIFICATION_CONNECTOR_RENDERERS } from "./notification_connector_renderer.mjs";
import { validateNotificationConnectorBinding } from "./notification_connector_runtime.mjs";
import { validateNotificationConnectorCapabilityCatalog } from "./notification_connector_discovery.mjs";

export const NOTIFICATION_CONNECTOR_DRIFT_SCHEMA_VERSION = 1;

const STATUS = new Set(["aligned", "review_required", "incompatible"]);
const DESTINATION_STATUS = new Set(["compatible", "manual_review", "incompatible"]);
const TARGET_STATUS = new Set(["bound", "available"]);
const ISSUE_CODES = Object.freeze([
  "connection_ref_mismatch",
  "target_missing_from_catalog",
  "channel_mismatch",
  "channel_not_available",
  "renderer_unsupported",
  "target_not_hash_bound",
]);
const ISSUE_SET = new Set(ISSUE_CODES);
const RENDERER_SET = new Set(NOTIFICATION_CONNECTOR_RENDERERS);
const REPORT_FIELDS = new Set([
  "schema_version", "report_id", "catalog_id", "binding_id", "connection_ref_match",
  "status", "counts", "binding_destinations", "catalog_targets", "safety",
]);
const COUNT_FIELDS = new Set([
  "binding_destinations", "compatible", "manual_review", "incompatible",
  "catalog_targets", "bound_catalog_targets", "available_catalog_targets",
]);
const DESTINATION_FIELDS = new Set([
  "destination_id", "channel", "renderer", "target_hash_bound", "status",
  "matched_target_id", "candidate_target_count", "issue_codes",
]);
const TARGET_FIELDS = new Set(["target_id", "channel", "status", "matched_binding_count"]);
const SAFETY_FIELDS = new Set([
  "read_only", "state_written", "network_accessed", "external_delivery_performed",
  "profile_files_read", "credential_environment_read", "endpoint_included",
  "native_target_included", "target_hash_included", "target_label_included",
  "account_identifier_included", "candidate_artifacts_included", "private_paths_included",
  "send_authorization_granted",
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

function reportSeed(report) {
  return {
    catalog_id: report.catalog_id,
    binding_id: report.binding_id,
    connection_ref_match: report.connection_ref_match,
    status: report.status,
    counts: report.counts,
    binding_destinations: report.binding_destinations,
    catalog_targets: report.catalog_targets,
  };
}

function rendererForBindingDestination(binding, destination) {
  return binding.schema_version === 1 ? "adapter_neutral_json_v1" : destination.renderer;
}

function compareBindingDestination(catalog, binding, destination) {
  const renderer = rendererForBindingDestination(binding, destination);
  const targetHash = binding.schema_version === 2 ? destination.target_sha256 : null;
  const base = {
    destination_id: destination.destination_id,
    channel: destination.channel,
    renderer,
    target_hash_bound: targetHash !== null,
    status: "incompatible",
    matched_target_id: null,
    candidate_target_count: 0,
    issue_codes: [],
  };
  if (catalog.connection_ref !== binding.connection_ref) {
    return { ...base, issue_codes: ["connection_ref_mismatch"] };
  }

  if (targetHash !== null) {
    const sameTarget = catalog.targets.filter((target) => target.target_sha256 === targetHash);
    if (sameTarget.length === 0) return { ...base, issue_codes: ["target_missing_from_catalog"] };
    const sameChannel = sameTarget.filter((target) => target.channel === destination.channel);
    if (sameChannel.length === 0) return { ...base, issue_codes: ["channel_mismatch"] };
    const compatible = sameChannel.filter((target) => target.renderers.includes(renderer)
      && target.operations.includes("notifications.deliver"));
    if (compatible.length === 0) return { ...base, issue_codes: ["renderer_unsupported"] };
    return {
      ...base,
      status: "compatible",
      matched_target_id: compatible[0].target_id,
      candidate_target_count: compatible.length,
    };
  }

  const sameChannel = catalog.targets.filter((target) => target.channel === destination.channel
    && target.operations.includes("notifications.deliver"));
  if (sameChannel.length === 0) return { ...base, issue_codes: ["channel_not_available"] };
  const compatible = sameChannel.filter((target) => target.renderers.includes(renderer));
  if (compatible.length === 0) return { ...base, issue_codes: ["renderer_unsupported"] };
  return {
    ...base,
    status: "manual_review",
    candidate_target_count: compatible.length,
    issue_codes: ["target_not_hash_bound"],
  };
}

export function buildNotificationConnectorDriftReport({ catalog, binding } = {}) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  validateNotificationConnectorBinding(binding);
  const bindingDestinations = binding.allowed_destinations
    .map((destination) => compareBindingDestination(catalog, binding, destination))
    .sort((left, right) => left.destination_id.localeCompare(right.destination_id)
      || left.channel.localeCompare(right.channel));
  const matchedCounts = new Map();
  for (const destination of bindingDestinations) {
    if (destination.matched_target_id) {
      matchedCounts.set(destination.matched_target_id, (matchedCounts.get(destination.matched_target_id) ?? 0) + 1);
    }
  }
  const catalogTargets = catalog.targets.map((target) => {
    const matchedBindingCount = matchedCounts.get(target.target_id) ?? 0;
    return {
      target_id: target.target_id,
      channel: target.channel,
      status: matchedBindingCount > 0 ? "bound" : "available",
      matched_binding_count: matchedBindingCount,
    };
  }).sort((left, right) => left.channel.localeCompare(right.channel) || left.target_id.localeCompare(right.target_id));
  const counts = {
    binding_destinations: bindingDestinations.length,
    compatible: bindingDestinations.filter((destination) => destination.status === "compatible").length,
    manual_review: bindingDestinations.filter((destination) => destination.status === "manual_review").length,
    incompatible: bindingDestinations.filter((destination) => destination.status === "incompatible").length,
    catalog_targets: catalogTargets.length,
    bound_catalog_targets: catalogTargets.filter((target) => target.status === "bound").length,
    available_catalog_targets: catalogTargets.filter((target) => target.status === "available").length,
  };
  const status = counts.incompatible > 0 ? "incompatible"
    : counts.manual_review > 0 ? "review_required" : "aligned";
  const report = {
    schema_version: 1,
    report_id: "",
    catalog_id: catalog.catalog_id,
    binding_id: binding.binding_id,
    connection_ref_match: catalog.connection_ref === binding.connection_ref,
    status,
    counts,
    binding_destinations: bindingDestinations,
    catalog_targets: catalogTargets,
    safety: {
      read_only: true,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      profile_files_read: false,
      credential_environment_read: false,
      endpoint_included: false,
      native_target_included: false,
      target_hash_included: false,
      target_label_included: false,
      account_identifier_included: false,
      candidate_artifacts_included: false,
      private_paths_included: false,
      send_authorization_granted: false,
    },
  };
  report.report_id = stableId("NCAPDRIFT", reportSeed(report));
  return validateNotificationConnectorDriftReport(report);
}

export function validateNotificationConnectorDriftReport(report) {
  exactFields(report, REPORT_FIELDS, "Connector drift report");
  if (report.schema_version !== NOTIFICATION_CONNECTOR_DRIFT_SCHEMA_VERSION
    || !/^NCAPDRIFT-[A-F0-9]{24}$/.test(String(report.report_id ?? ""))
    || !/^NCAPCAT-[A-F0-9]{24}$/.test(String(report.catalog_id ?? ""))
    || !/^NCBIND-[A-F0-9]{24}$/.test(String(report.binding_id ?? ""))
    || typeof report.connection_ref_match !== "boolean" || !STATUS.has(report.status)) {
    throw new Error("Connector drift report identifiers or status are invalid");
  }
  exactFields(report.counts, COUNT_FIELDS, "connector drift counts");
  for (const field of COUNT_FIELDS) {
    if (!Number.isInteger(report.counts[field]) || report.counts[field] < 0 || report.counts[field] > 100) {
      throw new Error("Connector drift report counts are invalid");
    }
  }
  if (!Array.isArray(report.binding_destinations) || report.binding_destinations.length < 1
    || report.binding_destinations.length > 10 || !Array.isArray(report.catalog_targets)
    || report.catalog_targets.length < 1 || report.catalog_targets.length > 100) {
    throw new Error("Connector drift report collections are invalid");
  }
  const destinations = report.binding_destinations.map((destination, index) => {
    exactFields(destination, DESTINATION_FIELDS, `connector drift destination[${index}]`);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(destination.destination_id ?? ""))
      || !new Set(["email", "slack", "webhook", "custom"]).has(destination.channel)
      || !RENDERER_SET.has(destination.renderer) || typeof destination.target_hash_bound !== "boolean"
      || !DESTINATION_STATUS.has(destination.status)
      || (destination.matched_target_id !== null
        && !/^NCAPTGT-[A-F0-9]{24}$/.test(String(destination.matched_target_id ?? "")))
      || !Number.isInteger(destination.candidate_target_count) || destination.candidate_target_count < 0
      || destination.candidate_target_count > 100 || !Array.isArray(destination.issue_codes)
      || new Set(destination.issue_codes).size !== destination.issue_codes.length
      || destination.issue_codes.some((code) => !ISSUE_SET.has(code))) {
      throw new Error(`Connector drift destination[${index}] is invalid`);
    }
    if (destination.status === "compatible"
      && (!destination.target_hash_bound || !destination.matched_target_id
        || destination.candidate_target_count !== 1 || destination.issue_codes.length !== 0)) {
      throw new Error("Compatible connector drift destinations require one exact target and no issue");
    }
    if (destination.status === "manual_review"
      && (destination.target_hash_bound || destination.matched_target_id !== null
        || destination.candidate_target_count < 1
        || canonical(destination.issue_codes) !== canonical(["target_not_hash_bound"]))) {
      throw new Error("Manual-review connector drift destinations must remain unbound");
    }
    if (destination.status === "incompatible"
      && (destination.matched_target_id !== null || destination.candidate_target_count !== 0
        || destination.issue_codes.length !== 1)) {
      throw new Error("Incompatible connector drift destinations require one bounded issue");
    }
    return destination;
  });
  const orderedDestinations = [...destinations].sort((left, right) => left.destination_id.localeCompare(right.destination_id)
    || left.channel.localeCompare(right.channel));
  if (canonical(orderedDestinations) !== canonical(destinations)) {
    throw new Error("Connector drift destinations must be deterministically ordered");
  }
  const hasConnectionMismatch = destinations.some((destination) => destination.issue_codes.includes("connection_ref_mismatch"));
  if (report.connection_ref_match === hasConnectionMismatch
    || (!report.connection_ref_match
      && destinations.some((destination) => canonical(destination.issue_codes) !== canonical(["connection_ref_mismatch"])))) {
    throw new Error("Connector drift connection match does not agree with destination issues");
  }
  const targets = report.catalog_targets.map((target, index) => {
    exactFields(target, TARGET_FIELDS, `connector drift catalog target[${index}]`);
    if (!/^NCAPTGT-[A-F0-9]{24}$/.test(String(target.target_id ?? ""))
      || !new Set(["email", "slack", "webhook", "custom"]).has(target.channel)
      || !TARGET_STATUS.has(target.status) || !Number.isInteger(target.matched_binding_count)
      || target.matched_binding_count < 0 || target.matched_binding_count > 10
      || (target.status === "bound") !== (target.matched_binding_count > 0)) {
      throw new Error(`Connector drift catalog target[${index}] is invalid`);
    }
    return target;
  });
  const orderedTargets = [...targets]
    .sort((left, right) => left.channel.localeCompare(right.channel) || left.target_id.localeCompare(right.target_id));
  if (canonical(orderedTargets) !== canonical(targets)
    || new Set(targets.map((target) => target.target_id)).size !== targets.length) {
    throw new Error("Connector drift catalog targets must be unique and deterministically ordered");
  }
  for (const target of targets) {
    const expectedMatchedCount = destinations.filter((destination) => destination.matched_target_id === target.target_id).length;
    if (target.matched_binding_count !== expectedMatchedCount) {
      throw new Error("Connector drift target match count does not agree with destinations");
    }
  }
  const expectedCounts = {
    binding_destinations: destinations.length,
    compatible: destinations.filter((destination) => destination.status === "compatible").length,
    manual_review: destinations.filter((destination) => destination.status === "manual_review").length,
    incompatible: destinations.filter((destination) => destination.status === "incompatible").length,
    catalog_targets: targets.length,
    bound_catalog_targets: targets.filter((target) => target.status === "bound").length,
    available_catalog_targets: targets.filter((target) => target.status === "available").length,
  };
  if (canonical(report.counts) !== canonical(expectedCounts)) throw new Error("Connector drift report counts do not match content");
  const expectedStatus = expectedCounts.incompatible > 0 ? "incompatible"
    : expectedCounts.manual_review > 0 ? "review_required" : "aligned";
  if (report.status !== expectedStatus) throw new Error("Connector drift report status does not match content");
  exactFields(report.safety, SAFETY_FIELDS, "connector drift safety");
  if (report.safety.read_only !== true || report.safety.state_written !== false
    || report.safety.network_accessed !== false || report.safety.external_delivery_performed !== false
    || report.safety.profile_files_read !== false || report.safety.credential_environment_read !== false
    || report.safety.endpoint_included !== false || report.safety.native_target_included !== false
    || report.safety.target_hash_included !== false || report.safety.target_label_included !== false
    || report.safety.account_identifier_included !== false || report.safety.candidate_artifacts_included !== false
    || report.safety.private_paths_included !== false || report.safety.send_authorization_granted !== false) {
    throw new Error("Connector drift report safety flags are invalid");
  }
  if (report.report_id !== stableId("NCAPDRIFT", reportSeed(report))) {
    throw new Error("Connector drift report ID does not match deterministic content");
  }
  return report;
}
