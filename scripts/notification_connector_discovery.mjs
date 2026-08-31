import crypto from "node:crypto";
import { NOTIFICATION_CHANNELS } from "./project_config.mjs";
import { NOTIFICATION_CONNECTOR_RENDERERS } from "./notification_connector_renderer.mjs";

export const NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_SCHEMA_VERSION = 1;
export const NOTIFICATION_CONNECTOR_CAPABILITY_CATALOG_SCHEMA_VERSION = 1;
export const MAX_NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_BYTES = 256 * 1024;
export const MAX_NOTIFICATION_CONNECTOR_CAPABILITY_TARGETS = 100;

const OPERATIONS = Object.freeze(["notifications.deliver", "notifications.status.read"]);
const OPERATION_SET = new Set(OPERATIONS);
const RENDERER_SET = new Set(NOTIFICATION_CONNECTOR_RENDERERS);
const CHANNEL_SET = new Set(NOTIFICATION_CHANNELS.filter((channel) => channel !== "local"));
const EXPORT_FIELDS = new Set([
  "schema_version", "export_id", "exported_at", "connection_ref", "account_ref",
  "operations", "renderers", "targets", "safety",
]);
const EXPORT_TARGET_FIELDS = new Set(["target", "label", "channel", "operations", "renderers"]);
const EXPORT_SAFETY_FIELDS = new Set([
  "read_only", "credentials_included", "endpoints_included", "external_delivery_performed",
]);
const CATALOG_FIELDS = new Set([
  "schema_version", "catalog_id", "approval_id", "source_export_id", "source_sha256",
  "connection_ref", "generated_at", "operations", "renderers", "targets", "counts", "safety",
]);
const CATALOG_TARGET_FIELDS = new Set(["target_id", "target_sha256", "channel", "operations", "renderers"]);
const CATALOG_COUNTS_FIELDS = new Set(["targets"]);
const CATALOG_SAFETY_FIELDS = new Set([
  "read_only_source", "external_connector_invoked", "explicit_apply_required",
  "account_identifier_included", "native_target_included", "target_label_included",
  "endpoint_included", "credential_included", "application_submission_allowed", "recruiter_outreach_allowed",
]);
const RECOVERY_FIELDS = new Set([
  "schema_version", "workflow", "created_at", "catalog_id", "approval_id", "source_export_id",
  "source_sha256", "connection_ref", "error", "safety",
]);
const RECOVERY_SAFETY_FIELDS = new Set([
  "account_identifier_included", "native_target_included", "target_label_included",
  "endpoint_included", "credential_included", "external_connector_invoked",
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
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function opaqueReference(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)
    || /(?:secret|token|password|api[_-]?key|credential)/i.test(text)) {
    throw new Error(`${label} must be a non-secret opaque reference`);
  }
  return text;
}

function privateLabel(value, label) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) throw new Error(`${label} must contain 1-160 characters`);
  return text;
}

function validTimestamp(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp.toISOString();
}

function orderedUnique(values, allowed, order, label, { requireDelivery = false } = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > order.length) {
    throw new Error(`${label} must contain 1-${order.length} entries`);
  }
  const normalized = values.map((value) => String(value));
  if (new Set(normalized).size !== normalized.length || normalized.some((value) => !allowed.has(value))) {
    throw new Error(`${label} contains duplicates or unsupported values`);
  }
  if (requireDelivery && !normalized.includes("notifications.deliver")) {
    throw new Error(`${label} must include notifications.deliver`);
  }
  return order.filter((value) => normalized.includes(value));
}

function validateOperations(value, label) {
  return orderedUnique(value, OPERATION_SET, OPERATIONS, label, { requireDelivery: true });
}

function validateRenderers(value, label) {
  return orderedUnique(value, RENDERER_SET, NOTIFICATION_CONNECTOR_RENDERERS, label);
}

export function validateNotificationConnectorCapabilityExport(value) {
  requireObject(value, "Connector capability export");
  exactFields(value, EXPORT_FIELDS, "connector capability export");
  if (value.schema_version !== NOTIFICATION_CONNECTOR_CAPABILITY_EXPORT_SCHEMA_VERSION) {
    throw new Error("Unsupported connector capability export schema_version");
  }
  const exportId = String(value.export_id ?? "");
  if (!/^NCAPEXP-[A-F0-9]{24}$/.test(exportId)) throw new Error("Connector capability export_id is invalid");
  const connectionRef = opaqueReference(value.connection_ref, "Connector capability connection_ref");
  const accountRef = opaqueReference(value.account_ref, "Connector capability account_ref");
  const operations = validateOperations(value.operations, "Connector capability operations");
  const renderers = validateRenderers(value.renderers, "Connector capability renderers");
  if (!Array.isArray(value.targets) || value.targets.length < 1
    || value.targets.length > MAX_NOTIFICATION_CONNECTOR_CAPABILITY_TARGETS) {
    throw new Error(`Connector capability targets must contain 1-${MAX_NOTIFICATION_CONNECTOR_CAPABILITY_TARGETS} entries`);
  }
  const targets = value.targets.map((raw, index) => {
    requireObject(raw, `Connector capability target[${index}]`);
    exactFields(raw, EXPORT_TARGET_FIELDS, `connector capability target[${index}]`);
    const target = opaqueReference(raw.target, `Connector capability target[${index}].target`);
    const label = privateLabel(raw.label, `Connector capability target[${index}].label`);
    if (!CHANNEL_SET.has(raw.channel)) throw new Error(`Connector capability target[${index}].channel is unsupported`);
    const targetOperations = validateOperations(raw.operations, `Connector capability target[${index}].operations`);
    const targetRenderers = validateRenderers(raw.renderers, `Connector capability target[${index}].renderers`);
    if (targetOperations.some((operation) => !operations.includes(operation))
      || targetRenderers.some((renderer) => !renderers.includes(renderer))) {
      throw new Error(`Connector capability target[${index}] exceeds the export capability set`);
    }
    if (targetRenderers.includes("slack_blocks_v1") && raw.channel !== "slack") {
      throw new Error("Slack rendering is valid only for Slack discovery targets");
    }
    return { target, label, channel: raw.channel, operations: targetOperations, renderers: targetRenderers };
  });
  const targetKeys = targets.map((target) => `${target.channel}\u0000${target.target}`);
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("Connector capability targets contain duplicates");
  const safety = requireObject(value.safety, "Connector capability export safety");
  exactFields(safety, EXPORT_SAFETY_FIELDS, "connector capability export safety");
  if (safety.read_only !== true || safety.credentials_included !== false
    || safety.endpoints_included !== false || safety.external_delivery_performed !== false) {
    throw new Error("Connector capability export safety flags are invalid");
  }
  return {
    schema_version: 1,
    export_id: exportId,
    exported_at: validTimestamp(value.exported_at, "Connector capability exported_at"),
    connection_ref: connectionRef,
    account_ref: accountRef,
    operations,
    renderers,
    targets,
    safety: {
      read_only: true,
      credentials_included: false,
      endpoints_included: false,
      external_delivery_performed: false,
    },
  };
}

export function notificationConnectorCapabilityExportHash(value) {
  return sha256(canonical(validateNotificationConnectorCapabilityExport(value)));
}

function sanitizedTarget(exportValue, target) {
  const targetSha256 = sha256(target.target);
  return {
    target_id: stableId("NCAPTGT", {
      source_export_id: exportValue.export_id,
      connection_ref: exportValue.connection_ref,
      channel: target.channel,
      target_sha256: targetSha256,
    }),
    target_sha256: targetSha256,
    channel: target.channel,
    operations: target.operations,
    renderers: target.renderers,
  };
}

function catalogSeed(catalog) {
  return {
    source_export_id: catalog.source_export_id,
    source_sha256: catalog.source_sha256,
    connection_ref: catalog.connection_ref,
    generated_at: catalog.generated_at,
    operations: catalog.operations,
    renderers: catalog.renderers,
    targets: catalog.targets,
  };
}

export function buildSanitizedNotificationConnectorCapabilityCatalog(value) {
  const validated = validateNotificationConnectorCapabilityExport(value);
  const catalog = {
    schema_version: 1,
    catalog_id: "",
    approval_id: "",
    source_export_id: validated.export_id,
    source_sha256: notificationConnectorCapabilityExportHash(validated),
    connection_ref: validated.connection_ref,
    generated_at: validated.exported_at,
    operations: validated.operations,
    renderers: validated.renderers,
    targets: validated.targets.map((target) => sanitizedTarget(validated, target))
      .sort((left, right) => left.channel.localeCompare(right.channel) || left.target_id.localeCompare(right.target_id)),
    counts: { targets: validated.targets.length },
    safety: {
      read_only_source: true,
      external_connector_invoked: false,
      explicit_apply_required: true,
      account_identifier_included: false,
      native_target_included: false,
      target_label_included: false,
      endpoint_included: false,
      credential_included: false,
      application_submission_allowed: false,
      recruiter_outreach_allowed: false,
    },
  };
  catalog.catalog_id = stableId("NCAPCAT", catalogSeed(catalog));
  catalog.approval_id = stableId("NCAP", { catalog_id: catalog.catalog_id });
  return validateNotificationConnectorCapabilityCatalog(catalog);
}

export function validateNotificationConnectorCapabilityCatalog(value) {
  requireObject(value, "Connector capability catalog");
  exactFields(value, CATALOG_FIELDS, "connector capability catalog");
  if (value.schema_version !== NOTIFICATION_CONNECTOR_CAPABILITY_CATALOG_SCHEMA_VERSION) {
    throw new Error("Unsupported connector capability catalog schema_version");
  }
  if (!/^NCAPCAT-[A-F0-9]{24}$/.test(String(value.catalog_id ?? ""))
    || !/^NCAP-[A-F0-9]{24}$/.test(String(value.approval_id ?? ""))
    || !/^NCAPEXP-[A-F0-9]{24}$/.test(String(value.source_export_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.source_sha256 ?? ""))) {
    throw new Error("Connector capability catalog identifiers are invalid");
  }
  const normalized = {
    schema_version: 1,
    catalog_id: value.catalog_id,
    approval_id: value.approval_id,
    source_export_id: value.source_export_id,
    source_sha256: value.source_sha256,
    connection_ref: opaqueReference(value.connection_ref, "Connector capability catalog connection_ref"),
    generated_at: validTimestamp(value.generated_at, "Connector capability catalog generated_at"),
    operations: validateOperations(value.operations, "Connector capability catalog operations"),
    renderers: validateRenderers(value.renderers, "Connector capability catalog renderers"),
    targets: [],
    counts: value.counts,
    safety: value.safety,
  };
  if (!Array.isArray(value.targets) || value.targets.length < 1
    || value.targets.length > MAX_NOTIFICATION_CONNECTOR_CAPABILITY_TARGETS) {
    throw new Error("Connector capability catalog targets are invalid");
  }
  normalized.targets = value.targets.map((target, index) => {
    requireObject(target, `Connector capability catalog target[${index}]`);
    exactFields(target, CATALOG_TARGET_FIELDS, `connector capability catalog target[${index}]`);
    if (!/^NCAPTGT-[A-F0-9]{24}$/.test(String(target.target_id ?? ""))
      || !/^[a-f0-9]{64}$/.test(String(target.target_sha256 ?? ""))
      || !CHANNEL_SET.has(target.channel)) {
      throw new Error(`Connector capability catalog target[${index}] is invalid`);
    }
    const operations = validateOperations(target.operations, `Connector capability catalog target[${index}].operations`);
    const renderers = validateRenderers(target.renderers, `Connector capability catalog target[${index}].renderers`);
    if (operations.some((operation) => !normalized.operations.includes(operation))
      || renderers.some((renderer) => !normalized.renderers.includes(renderer))
      || (renderers.includes("slack_blocks_v1") && target.channel !== "slack")) {
      throw new Error(`Connector capability catalog target[${index}] exceeds its catalog capability set`);
    }
    const expectedTargetId = stableId("NCAPTGT", {
      source_export_id: normalized.source_export_id,
      connection_ref: normalized.connection_ref,
      channel: target.channel,
      target_sha256: target.target_sha256,
    });
    if (target.target_id !== expectedTargetId) throw new Error("Connector capability target ID is not deterministic");
    return { target_id: target.target_id, target_sha256: target.target_sha256, channel: target.channel, operations, renderers };
  });
  const sortedTargets = [...normalized.targets]
    .sort((left, right) => left.channel.localeCompare(right.channel) || left.target_id.localeCompare(right.target_id));
  if (canonical(sortedTargets) !== canonical(normalized.targets)
    || new Set(normalized.targets.map((target) => target.target_id)).size !== normalized.targets.length) {
    throw new Error("Connector capability catalog targets must be unique and deterministically ordered");
  }
  requireObject(normalized.counts, "Connector capability catalog counts");
  exactFields(normalized.counts, CATALOG_COUNTS_FIELDS, "connector capability catalog counts");
  if (normalized.counts.targets !== normalized.targets.length) throw new Error("Connector capability catalog counts are invalid");
  requireObject(normalized.safety, "Connector capability catalog safety");
  exactFields(normalized.safety, CATALOG_SAFETY_FIELDS, "connector capability catalog safety");
  if (normalized.safety.read_only_source !== true || normalized.safety.external_connector_invoked !== false
    || normalized.safety.explicit_apply_required !== true || normalized.safety.account_identifier_included !== false
    || normalized.safety.native_target_included !== false || normalized.safety.target_label_included !== false
    || normalized.safety.endpoint_included !== false || normalized.safety.credential_included !== false
    || normalized.safety.application_submission_allowed !== false || normalized.safety.recruiter_outreach_allowed !== false) {
    throw new Error("Connector capability catalog safety flags are invalid");
  }
  const expectedCatalogId = stableId("NCAPCAT", catalogSeed(normalized));
  if (normalized.catalog_id !== expectedCatalogId
    || normalized.approval_id !== stableId("NCAP", { catalog_id: expectedCatalogId })) {
    throw new Error("Connector capability catalog IDs do not match deterministic content");
  }
  return value;
}

export function buildNotificationConnectorDiscoveryRecoveryMarker(catalog, { createdAt, error } = {}) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  const summary = String(error ?? "Sanitized connector capability catalog commit failed")
    .split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim().slice(0, 240);
  return validateNotificationConnectorDiscoveryRecoveryMarker({
    schema_version: 1,
    workflow: "notification_connector_discovery_import",
    created_at: validTimestamp(createdAt, "Connector discovery recovery created_at"),
    catalog_id: catalog.catalog_id,
    approval_id: catalog.approval_id,
    source_export_id: catalog.source_export_id,
    source_sha256: catalog.source_sha256,
    connection_ref: catalog.connection_ref,
    error: summary || "Sanitized connector capability catalog commit failed",
    safety: {
      account_identifier_included: false,
      native_target_included: false,
      target_label_included: false,
      endpoint_included: false,
      credential_included: false,
      external_connector_invoked: false,
    },
  }, { catalog });
}

export function validateNotificationConnectorDiscoveryRecoveryMarker(marker, { catalog = null } = {}) {
  requireObject(marker, "Connector discovery recovery marker");
  exactFields(marker, RECOVERY_FIELDS, "connector discovery recovery marker");
  if (marker.schema_version !== 1 || marker.workflow !== "notification_connector_discovery_import"
    || !Number.isFinite(new Date(marker.created_at).getTime())
    || !/^NCAPCAT-[A-F0-9]{24}$/.test(String(marker.catalog_id ?? ""))
    || !/^NCAP-[A-F0-9]{24}$/.test(String(marker.approval_id ?? ""))
    || !/^NCAPEXP-[A-F0-9]{24}$/.test(String(marker.source_export_id ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(marker.source_sha256 ?? ""))) {
    throw new Error("Connector discovery recovery marker is invalid");
  }
  opaqueReference(marker.connection_ref, "Connector discovery recovery connection_ref");
  if (typeof marker.error !== "string" || !marker.error || marker.error.length > 240 || /[\r\n]/.test(marker.error)) {
    throw new Error("Connector discovery recovery error summary is invalid");
  }
  requireObject(marker.safety, "Connector discovery recovery safety");
  exactFields(marker.safety, RECOVERY_SAFETY_FIELDS, "connector discovery recovery safety");
  if (marker.safety.account_identifier_included !== false || marker.safety.native_target_included !== false
    || marker.safety.target_label_included !== false || marker.safety.endpoint_included !== false
    || marker.safety.credential_included !== false || marker.safety.external_connector_invoked !== false) {
    throw new Error("Connector discovery recovery safety flags are invalid");
  }
  if (catalog) {
    validateNotificationConnectorCapabilityCatalog(catalog);
    for (const field of ["catalog_id", "approval_id", "source_export_id", "source_sha256", "connection_ref"]) {
      if (marker[field] !== catalog[field]) throw new Error(`Connector discovery recovery ${field} does not match the exact catalog`);
    }
  }
  return marker;
}
