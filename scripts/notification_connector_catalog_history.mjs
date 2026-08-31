import crypto from "node:crypto";
import { NOTIFICATION_CONNECTOR_RENDERERS } from "./notification_connector_renderer.mjs";
import { validateNotificationConnectorCapabilityCatalog } from "./notification_connector_discovery.mjs";

export const NOTIFICATION_CONNECTOR_CATALOG_HISTORY_SCHEMA_VERSION = 1;

const OPERATIONS = Object.freeze(["notifications.deliver", "notifications.status.read"]);
const OPERATION_SET = new Set(OPERATIONS);
const RENDERERS = NOTIFICATION_CONNECTOR_RENDERERS;
const RENDERER_SET = new Set(RENDERERS);
const STATUS = new Set(["unchanged", "changed"]);
const CHANGE_TYPES = new Set(["added", "removed", "modified"]);
const CHANNELS = new Set(["email", "slack", "webhook", "custom"]);
const REPORT_FIELDS = new Set([
  "schema_version", "report_id", "before_catalog_id", "after_catalog_id",
  "before_generated_at", "after_generated_at", "status", "counts",
  "global_changes", "target_changes", "safety",
]);
const COUNT_FIELDS = new Set([
  "before_targets", "after_targets", "added_targets", "removed_targets", "modified_targets",
  "target_changes", "global_operation_changes", "global_renderer_changes",
]);
const GLOBAL_FIELDS = new Set([
  "operations_added", "operations_removed", "renderers_added", "renderers_removed",
]);
const TARGET_CHANGE_FIELDS = new Set([
  "change_id", "target_ref", "change_type", "channel",
  "operations_added", "operations_removed", "renderers_added", "renderers_removed",
]);
const SAFETY_FIELDS = new Set([
  "read_only", "state_written", "network_accessed", "external_delivery_performed",
  "raw_exports_read", "profile_files_read", "credential_environment_read", "endpoint_included",
  "native_target_included", "target_id_included", "target_hash_included", "target_label_included",
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

function orderedDifference(left, right, order) {
  const rightSet = new Set(right);
  return order.filter((value) => left.includes(value) && !rightSet.has(value));
}

function targetKey(target) {
  return `${target.channel}\u0000${target.target_sha256}`;
}

function targetReference(connectionRef, target) {
  return stableId("NCAPHISTTGT", {
    connection_ref: connectionRef,
    channel: target.channel,
    target_sha256: target.target_sha256,
  });
}

function changeSeed(change) {
  return {
    target_ref: change.target_ref,
    change_type: change.change_type,
    channel: change.channel,
    operations_added: change.operations_added,
    operations_removed: change.operations_removed,
    renderers_added: change.renderers_added,
    renderers_removed: change.renderers_removed,
  };
}

function targetChange(connectionRef, beforeTarget, afterTarget) {
  const target = afterTarget ?? beforeTarget;
  const change = {
    change_id: "",
    target_ref: targetReference(connectionRef, target),
    change_type: beforeTarget ? (afterTarget ? "modified" : "removed") : "added",
    channel: target.channel,
    operations_added: afterTarget ? orderedDifference(afterTarget.operations, beforeTarget?.operations ?? [], OPERATIONS) : [],
    operations_removed: beforeTarget ? orderedDifference(beforeTarget.operations, afterTarget?.operations ?? [], OPERATIONS) : [],
    renderers_added: afterTarget ? orderedDifference(afterTarget.renderers, beforeTarget?.renderers ?? [], RENDERERS) : [],
    renderers_removed: beforeTarget ? orderedDifference(beforeTarget.renderers, afterTarget?.renderers ?? [], RENDERERS) : [],
  };
  change.change_id = stableId("NCAPHCHG", changeSeed(change));
  return change;
}

function reportSeed(report) {
  return {
    before_catalog_id: report.before_catalog_id,
    after_catalog_id: report.after_catalog_id,
    before_generated_at: report.before_generated_at,
    after_generated_at: report.after_generated_at,
    status: report.status,
    counts: report.counts,
    global_changes: report.global_changes,
    target_changes: report.target_changes,
  };
}

export function buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog } = {}) {
  validateNotificationConnectorCapabilityCatalog(beforeCatalog);
  validateNotificationConnectorCapabilityCatalog(afterCatalog);
  const beforeGeneratedAt = new Date(beforeCatalog.generated_at).toISOString();
  const afterGeneratedAt = new Date(afterCatalog.generated_at).toISOString();
  if (beforeCatalog.connection_ref !== afterCatalog.connection_ref) {
    throw new Error("Connector catalog history requires the same opaque connection reference");
  }
  if (new Date(afterGeneratedAt).getTime() < new Date(beforeGeneratedAt).getTime()) {
    throw new Error("Connector catalog history requires a nondecreasing after timestamp");
  }
  const beforeTargets = new Map(beforeCatalog.targets.map((target) => [targetKey(target), target]));
  const afterTargets = new Map(afterCatalog.targets.map((target) => [targetKey(target), target]));
  const keys = [...new Set([...beforeTargets.keys(), ...afterTargets.keys()])].sort();
  const targetChanges = [];
  for (const key of keys) {
    const beforeTarget = beforeTargets.get(key) ?? null;
    const afterTarget = afterTargets.get(key) ?? null;
    if (beforeTarget && afterTarget
      && canonical(beforeTarget.operations) === canonical(afterTarget.operations)
      && canonical(beforeTarget.renderers) === canonical(afterTarget.renderers)) continue;
    targetChanges.push(targetChange(beforeCatalog.connection_ref, beforeTarget, afterTarget));
  }
  targetChanges.sort((left, right) => left.target_ref.localeCompare(right.target_ref)
    || left.change_type.localeCompare(right.change_type));
  const globalChanges = {
    operations_added: orderedDifference(afterCatalog.operations, beforeCatalog.operations, OPERATIONS),
    operations_removed: orderedDifference(beforeCatalog.operations, afterCatalog.operations, OPERATIONS),
    renderers_added: orderedDifference(afterCatalog.renderers, beforeCatalog.renderers, RENDERERS),
    renderers_removed: orderedDifference(beforeCatalog.renderers, afterCatalog.renderers, RENDERERS),
  };
  const counts = {
    before_targets: beforeCatalog.targets.length,
    after_targets: afterCatalog.targets.length,
    added_targets: targetChanges.filter((change) => change.change_type === "added").length,
    removed_targets: targetChanges.filter((change) => change.change_type === "removed").length,
    modified_targets: targetChanges.filter((change) => change.change_type === "modified").length,
    target_changes: targetChanges.length,
    global_operation_changes: globalChanges.operations_added.length + globalChanges.operations_removed.length,
    global_renderer_changes: globalChanges.renderers_added.length + globalChanges.renderers_removed.length,
  };
  const changed = counts.target_changes > 0 || counts.global_operation_changes > 0 || counts.global_renderer_changes > 0;
  const report = {
    schema_version: 1,
    report_id: "",
    before_catalog_id: beforeCatalog.catalog_id,
    after_catalog_id: afterCatalog.catalog_id,
    before_generated_at: beforeGeneratedAt,
    after_generated_at: afterGeneratedAt,
    status: changed ? "changed" : "unchanged",
    counts,
    global_changes: globalChanges,
    target_changes: targetChanges,
    safety: {
      read_only: true,
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      raw_exports_read: false,
      profile_files_read: false,
      credential_environment_read: false,
      endpoint_included: false,
      native_target_included: false,
      target_id_included: false,
      target_hash_included: false,
      target_label_included: false,
      account_identifier_included: false,
      candidate_artifacts_included: false,
      private_paths_included: false,
      send_authorization_granted: false,
    },
  };
  report.report_id = stableId("NCAPHIST", reportSeed(report));
  return validateNotificationConnectorCatalogHistoryReport(report);
}

function validateOrderedSubset(values, allowed, order, label) {
  if (!Array.isArray(values) || new Set(values).size !== values.length
    || values.some((value) => !allowed.has(value))
    || canonical(values) !== canonical(order.filter((value) => values.includes(value)))) {
    throw new Error(`${label} must be unique and deterministically ordered`);
  }
}

export function validateNotificationConnectorCatalogHistoryReport(report) {
  exactFields(report, REPORT_FIELDS, "Connector catalog history report");
  if (report.schema_version !== NOTIFICATION_CONNECTOR_CATALOG_HISTORY_SCHEMA_VERSION
    || !/^NCAPHIST-[A-F0-9]{24}$/.test(String(report.report_id ?? ""))
    || !/^NCAPCAT-[A-F0-9]{24}$/.test(String(report.before_catalog_id ?? ""))
    || !/^NCAPCAT-[A-F0-9]{24}$/.test(String(report.after_catalog_id ?? ""))
    || !Number.isFinite(new Date(report.before_generated_at).getTime())
    || !Number.isFinite(new Date(report.after_generated_at).getTime())
    || new Date(report.after_generated_at).getTime() < new Date(report.before_generated_at).getTime()
    || !STATUS.has(report.status)) {
    throw new Error("Connector catalog history report identity or timestamps are invalid");
  }
  exactFields(report.counts, COUNT_FIELDS, "connector catalog history counts");
  const countLimits = {
    before_targets: [1, 100],
    after_targets: [1, 100],
    added_targets: [0, 100],
    removed_targets: [0, 100],
    modified_targets: [0, 100],
    target_changes: [0, 200],
    global_operation_changes: [0, 4],
    global_renderer_changes: [0, 4],
  };
  for (const [field, [minimum, maximum]] of Object.entries(countLimits)) {
    if (!Number.isInteger(report.counts[field])
      || report.counts[field] < minimum || report.counts[field] > maximum) {
      throw new Error("Connector catalog history counts are invalid");
    }
  }
  exactFields(report.global_changes, GLOBAL_FIELDS, "connector catalog global changes");
  validateOrderedSubset(report.global_changes.operations_added, OPERATION_SET, OPERATIONS, "Added connector operations");
  validateOrderedSubset(report.global_changes.operations_removed, OPERATION_SET, OPERATIONS, "Removed connector operations");
  validateOrderedSubset(report.global_changes.renderers_added, RENDERER_SET, RENDERERS, "Added connector renderers");
  validateOrderedSubset(report.global_changes.renderers_removed, RENDERER_SET, RENDERERS, "Removed connector renderers");
  if (report.global_changes.operations_added.some((value) => report.global_changes.operations_removed.includes(value))
    || report.global_changes.renderers_added.some((value) => report.global_changes.renderers_removed.includes(value))) {
    throw new Error("Connector catalog global changes cannot add and remove the same capability");
  }
  if (!Array.isArray(report.target_changes) || report.target_changes.length > 200) {
    throw new Error("Connector catalog target changes are invalid");
  }
  const targetChanges = report.target_changes.map((change, index) => {
    exactFields(change, TARGET_CHANGE_FIELDS, `connector catalog target change[${index}]`);
    if (!/^NCAPHCHG-[A-F0-9]{24}$/.test(String(change.change_id ?? ""))
      || !/^NCAPHISTTGT-[A-F0-9]{24}$/.test(String(change.target_ref ?? ""))
      || !CHANGE_TYPES.has(change.change_type) || !CHANNELS.has(change.channel)) {
      throw new Error(`Connector catalog target change[${index}] identity is invalid`);
    }
    validateOrderedSubset(change.operations_added, OPERATION_SET, OPERATIONS, `Target change[${index}] added operations`);
    validateOrderedSubset(change.operations_removed, OPERATION_SET, OPERATIONS, `Target change[${index}] removed operations`);
    validateOrderedSubset(change.renderers_added, RENDERER_SET, RENDERERS, `Target change[${index}] added renderers`);
    validateOrderedSubset(change.renderers_removed, RENDERER_SET, RENDERERS, `Target change[${index}] removed renderers`);
    if (change.operations_added.some((value) => change.operations_removed.includes(value))
      || change.renderers_added.some((value) => change.renderers_removed.includes(value))) {
      throw new Error("Connector catalog target change cannot add and remove the same capability");
    }
    const addedCount = change.operations_added.length + change.renderers_added.length;
    const removedCount = change.operations_removed.length + change.renderers_removed.length;
    if ((change.change_type === "added" && (addedCount < 2 || removedCount !== 0))
      || (change.change_type === "removed" && (removedCount < 2 || addedCount !== 0))
      || (change.change_type === "modified" && addedCount + removedCount < 1)) {
      throw new Error(`Connector catalog target change[${index}] deltas do not match its type`);
    }
    if (change.change_id !== stableId("NCAPHCHG", changeSeed(change))) {
      throw new Error(`Connector catalog target change[${index}] ID is not deterministic`);
    }
    return change;
  });
  const orderedChanges = [...targetChanges].sort((left, right) => left.target_ref.localeCompare(right.target_ref)
    || left.change_type.localeCompare(right.change_type));
  if (canonical(orderedChanges) !== canonical(targetChanges)
    || new Set(targetChanges.map((change) => change.target_ref)).size !== targetChanges.length) {
    throw new Error("Connector catalog target changes must be unique and deterministically ordered");
  }
  const expectedCounts = {
    before_targets: report.counts.before_targets,
    after_targets: report.counts.after_targets,
    added_targets: targetChanges.filter((change) => change.change_type === "added").length,
    removed_targets: targetChanges.filter((change) => change.change_type === "removed").length,
    modified_targets: targetChanges.filter((change) => change.change_type === "modified").length,
    target_changes: targetChanges.length,
    global_operation_changes: report.global_changes.operations_added.length + report.global_changes.operations_removed.length,
    global_renderer_changes: report.global_changes.renderers_added.length + report.global_changes.renderers_removed.length,
  };
  if (canonical(expectedCounts) !== canonical(report.counts)) {
    throw new Error("Connector catalog history counts do not match its changes");
  }
  if (expectedCounts.after_targets
      !== expectedCounts.before_targets + expectedCounts.added_targets - expectedCounts.removed_targets
    || expectedCounts.added_targets > expectedCounts.after_targets
    || expectedCounts.removed_targets > expectedCounts.before_targets
    || expectedCounts.modified_targets > Math.min(expectedCounts.before_targets, expectedCounts.after_targets)) {
    throw new Error("Connector catalog history target counts are internally inconsistent");
  }
  const changed = expectedCounts.target_changes > 0
    || expectedCounts.global_operation_changes > 0 || expectedCounts.global_renderer_changes > 0;
  if (report.status !== (changed ? "changed" : "unchanged")) {
    throw new Error("Connector catalog history status does not match its changes");
  }
  exactFields(report.safety, SAFETY_FIELDS, "connector catalog history safety");
  if (report.safety.read_only !== true || report.safety.state_written !== false
    || report.safety.network_accessed !== false || report.safety.external_delivery_performed !== false
    || report.safety.raw_exports_read !== false || report.safety.profile_files_read !== false
    || report.safety.credential_environment_read !== false || report.safety.endpoint_included !== false
    || report.safety.native_target_included !== false || report.safety.target_id_included !== false
    || report.safety.target_hash_included !== false || report.safety.target_label_included !== false
    || report.safety.account_identifier_included !== false || report.safety.candidate_artifacts_included !== false
    || report.safety.private_paths_included !== false || report.safety.send_authorization_granted !== false) {
    throw new Error("Connector catalog history safety flags are invalid");
  }
  if (report.report_id !== stableId("NCAPHIST", reportSeed(report))) {
    throw new Error("Connector catalog history report ID is not deterministic");
  }
  return report;
}
