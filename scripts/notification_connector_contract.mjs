import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";

export const NOTIFICATION_CONNECTOR_ALLOWED_OPERATIONS = Object.freeze(["notifications.deliver"]);
export const NOTIFICATION_CONNECTOR_FORBIDDEN_OPERATIONS = Object.freeze([
  "applications.submit", "applications.update", "recruiters.contact", "email.send", "gmail.send",
]);

export function buildNotificationConnectorPlan(request, { approvalId, now = new Date().toISOString() } = {}) {
  validateNotificationDeliveryRequest(request);
  if (request.destination.adapter !== "connector") throw new Error("Connector dispatch requires a connector destination");
  if (approvalId !== request.approval_id) throw new Error("Connector dispatch requires the exact notification approval ID");
  const asOf = new Date(now);
  if (!Number.isFinite(asOf.getTime())) throw new Error("Connector dispatch timestamp is invalid");
  const deferred = asOf < new Date(request.not_before);
  return {
    schema_version: 1,
    request_id: request.request_id,
    approval_id: request.approval_id,
    operation: "notifications.deliver",
    destination: request.destination,
    not_before: request.not_before,
    status: deferred ? "deferred" : "ready",
    payload: { schema_version: 1, digest_id: request.digest_id, run_id: request.run_id, items: request.items },
    mutating_external_operation: true,
    requires_explicit_approval: true,
    requires_explicit_send_flag: true,
    authenticated_private_profile_required: true,
    approved_sanitized_binding_required: true,
    destination_allowlist_required: true,
    bounded_timeout_required: true,
    bounded_request_required: true,
    deterministic_retry_required: true,
    idempotency_key: request.request_id,
    application_submission_allowed: false,
    recruiter_outreach_allowed: false,
    credentials_required_for_setup_or_tests: false,
    connector_invoked: false,
  };
}
