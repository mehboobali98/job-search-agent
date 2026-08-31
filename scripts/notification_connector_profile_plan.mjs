import crypto from "node:crypto";
import { NOTIFICATION_CONNECTOR_RENDERERS } from "./notification_connector_renderer.mjs";
import { validateNotificationConnectorCapabilityCatalog } from "./notification_connector_discovery.mjs";

export const NOTIFICATION_CONNECTOR_PROFILE_PLAN_SCHEMA_VERSION = 1;

const CHANNELS = new Set(["email", "slack", "webhook", "custom"]);
const RENDERERS = new Set(NOTIFICATION_CONNECTOR_RENDERERS);
const REPORT_FIELDS = new Set([
  "schema_version", "plan_id", "catalog_id", "destination_id", "channel", "renderer",
  "profile_schema_version", "selected_target_ref", "destination_enabled", "profile_enabled_default",
  "required_manual_inputs", "request_policy_template", "idempotency", "verification", "safety",
]);
const REQUEST_POLICY_FIELDS = new Set([
  "timeout_ms", "max_request_bytes", "max_response_bytes", "max_attempts", "retry_delays_ms",
]);
const IDEMPOTENCY_FIELDS = new Set(["required", "header"]);
const VERIFICATION_FIELDS = new Set([
  "profile_preview_required", "exact_binding_approval_required", "catalog_drift_check_required",
  "native_target_hash_match_required", "expected_drift_status", "explicit_send_approval_still_required",
]);
const SAFETY_FIELDS = new Set([
  "read_only", "state_written", "profile_written", "raw_export_read", "profile_files_read",
  "credential_environment_read", "network_accessed", "external_delivery_performed", "endpoint_included",
  "credential_environment_name_included", "native_target_included", "target_id_included",
  "target_hash_included", "target_label_included", "account_identifier_included",
  "connection_ref_included", "candidate_artifacts_included", "private_paths_included",
  "approval_id_issued", "send_authorization_granted", "application_submission_allowed",
  "recruiter_outreach_allowed",
]);
const BASE_MANUAL_INPUTS = Object.freeze([
  "profile_id", "https_endpoint", "bearer_environment_variable",
]);
const REQUEST_POLICY_TEMPLATE = Object.freeze({
  timeout_ms: 5_000,
  max_request_bytes: 65_536,
  max_response_bytes: 8_192,
  max_attempts: 2,
  retry_delays_ms: Object.freeze([1_000]),
});

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

function targetReference(catalog, target) {
  return stableId("NCAPPROFTGT", {
    connection_ref: catalog.connection_ref,
    channel: target.channel,
    target_sha256: target.target_sha256,
  });
}

function planSeed(plan) {
  return {
    catalog_id: plan.catalog_id,
    destination_id: plan.destination_id,
    channel: plan.channel,
    renderer: plan.renderer,
    profile_schema_version: plan.profile_schema_version,
    selected_target_ref: plan.selected_target_ref,
    destination_enabled: plan.destination_enabled,
    profile_enabled_default: plan.profile_enabled_default,
    required_manual_inputs: plan.required_manual_inputs,
    request_policy_template: plan.request_policy_template,
    idempotency: plan.idempotency,
    verification: plan.verification,
  };
}

function validateDestination(destination) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new Error("Connector profile plan destination must be an object");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(destination.id ?? ""))
    || typeof destination.enabled !== "boolean" || destination.adapter !== "connector"
    || !CHANNELS.has(destination.channel)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(destination.connection_ref ?? ""))
    || /(?:secret|token|password|api[_-]?key|credential)/i.test(String(destination.connection_ref ?? ""))) {
    throw new Error("Connector profile plan requires an exact configured connector destination");
  }
  return destination;
}

export function buildNotificationConnectorProfilePlan({ catalog, destination, targetId, renderer } = {}) {
  validateNotificationConnectorCapabilityCatalog(catalog);
  validateDestination(destination);
  const selectedRenderer = String(renderer ?? "");
  if (!RENDERERS.has(selectedRenderer)) throw new Error("Connector profile plan renderer is unsupported");
  const target = catalog.targets.find((entry) => entry.target_id === targetId);
  if (!target) throw new Error("Connector profile plan requires an exact catalog target ID");
  if (destination.connection_ref !== catalog.connection_ref) {
    throw new Error("Connector profile plan destination connection does not match the catalog");
  }
  if (destination.channel !== target.channel) {
    throw new Error("Connector profile plan destination channel does not match the catalog target");
  }
  if (!catalog.operations.includes("notifications.deliver")
    || !target.operations.includes("notifications.deliver")
    || !catalog.renderers.includes(selectedRenderer) || !target.renderers.includes(selectedRenderer)) {
    throw new Error("Connector profile plan target does not support the selected delivery renderer");
  }
  if (selectedRenderer === "slack_blocks_v1" && target.channel !== "slack") {
    throw new Error("Slack profile planning requires an exact Slack catalog target");
  }
  const nativeTargetRequired = selectedRenderer === "slack_blocks_v1";
  const plan = {
    schema_version: NOTIFICATION_CONNECTOR_PROFILE_PLAN_SCHEMA_VERSION,
    plan_id: "",
    catalog_id: catalog.catalog_id,
    destination_id: destination.id,
    channel: destination.channel,
    renderer: selectedRenderer,
    profile_schema_version: 2,
    selected_target_ref: targetReference(catalog, target),
    destination_enabled: destination.enabled,
    profile_enabled_default: false,
    required_manual_inputs: [
      ...BASE_MANUAL_INPUTS,
      ...(nativeTargetRequired ? ["native_target"] : []),
    ],
    request_policy_template: {
      ...REQUEST_POLICY_TEMPLATE,
      retry_delays_ms: [...REQUEST_POLICY_TEMPLATE.retry_delays_ms],
    },
    idempotency: { required: true, header: "Idempotency-Key" },
    verification: {
      profile_preview_required: true,
      exact_binding_approval_required: true,
      catalog_drift_check_required: true,
      native_target_hash_match_required: nativeTargetRequired,
      expected_drift_status: nativeTargetRequired
        ? "aligned_only_if_native_target_matches"
        : "review_required_target_not_hash_bound",
      explicit_send_approval_still_required: true,
    },
    safety: {
      read_only: true,
      state_written: false,
      profile_written: false,
      raw_export_read: false,
      profile_files_read: false,
      credential_environment_read: false,
      network_accessed: false,
      external_delivery_performed: false,
      endpoint_included: false,
      credential_environment_name_included: false,
      native_target_included: false,
      target_id_included: false,
      target_hash_included: false,
      target_label_included: false,
      account_identifier_included: false,
      connection_ref_included: false,
      candidate_artifacts_included: false,
      private_paths_included: false,
      approval_id_issued: false,
      send_authorization_granted: false,
      application_submission_allowed: false,
      recruiter_outreach_allowed: false,
    },
  };
  plan.plan_id = stableId("NCAPPROF", planSeed(plan));
  return validateNotificationConnectorProfilePlan(plan);
}

export function validateNotificationConnectorProfilePlan(plan) {
  exactFields(plan, REPORT_FIELDS, "Connector profile authoring plan");
  if (plan.schema_version !== NOTIFICATION_CONNECTOR_PROFILE_PLAN_SCHEMA_VERSION
    || !/^NCAPPROF-[A-F0-9]{24}$/.test(String(plan.plan_id ?? ""))
    || !/^NCAPCAT-[A-F0-9]{24}$/.test(String(plan.catalog_id ?? ""))
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(plan.destination_id ?? ""))
    || !CHANNELS.has(plan.channel) || !RENDERERS.has(plan.renderer)
    || plan.profile_schema_version !== 2
    || !/^NCAPPROFTGT-[A-F0-9]{24}$/.test(String(plan.selected_target_ref ?? ""))
    || typeof plan.destination_enabled !== "boolean" || plan.profile_enabled_default !== false) {
    throw new Error("Connector profile authoring plan identity or selection is invalid");
  }
  const expectedManualInputs = [
    ...BASE_MANUAL_INPUTS,
    ...(plan.renderer === "slack_blocks_v1" ? ["native_target"] : []),
  ];
  if (canonical(plan.required_manual_inputs) !== canonical(expectedManualInputs)) {
    throw new Error("Connector profile authoring plan manual inputs are invalid");
  }
  exactFields(plan.request_policy_template, REQUEST_POLICY_FIELDS, "connector profile plan request policy");
  if (canonical(plan.request_policy_template) !== canonical(REQUEST_POLICY_TEMPLATE)) {
    throw new Error("Connector profile authoring plan request policy is invalid");
  }
  exactFields(plan.idempotency, IDEMPOTENCY_FIELDS, "connector profile plan idempotency");
  if (plan.idempotency.required !== true || plan.idempotency.header !== "Idempotency-Key") {
    throw new Error("Connector profile authoring plan idempotency is invalid");
  }
  exactFields(plan.verification, VERIFICATION_FIELDS, "connector profile plan verification");
  const nativeTargetRequired = plan.renderer === "slack_blocks_v1";
  if (plan.verification.profile_preview_required !== true
    || plan.verification.exact_binding_approval_required !== true
    || plan.verification.catalog_drift_check_required !== true
    || plan.verification.native_target_hash_match_required !== nativeTargetRequired
    || plan.verification.expected_drift_status !== (nativeTargetRequired
      ? "aligned_only_if_native_target_matches"
      : "review_required_target_not_hash_bound")
    || plan.verification.explicit_send_approval_still_required !== true) {
    throw new Error("Connector profile authoring plan verification is invalid");
  }
  if (nativeTargetRequired && plan.channel !== "slack") {
    throw new Error("Connector profile authoring plan Slack rendering requires a Slack channel");
  }
  exactFields(plan.safety, SAFETY_FIELDS, "connector profile authoring plan safety");
  if (plan.safety.read_only !== true || plan.safety.state_written !== false
    || plan.safety.profile_written !== false || plan.safety.raw_export_read !== false
    || plan.safety.profile_files_read !== false || plan.safety.credential_environment_read !== false
    || plan.safety.network_accessed !== false || plan.safety.external_delivery_performed !== false
    || plan.safety.endpoint_included !== false || plan.safety.credential_environment_name_included !== false
    || plan.safety.native_target_included !== false || plan.safety.target_id_included !== false
    || plan.safety.target_hash_included !== false || plan.safety.target_label_included !== false
    || plan.safety.account_identifier_included !== false || plan.safety.connection_ref_included !== false
    || plan.safety.candidate_artifacts_included !== false || plan.safety.private_paths_included !== false
    || plan.safety.approval_id_issued !== false || plan.safety.send_authorization_granted !== false
    || plan.safety.application_submission_allowed !== false
    || plan.safety.recruiter_outreach_allowed !== false) {
    throw new Error("Connector profile authoring plan safety flags are invalid");
  }
  if (plan.plan_id !== stableId("NCAPPROF", planSeed(plan))) {
    throw new Error("Connector profile authoring plan ID is not deterministic");
  }
  return plan;
}
