import { JOB_ALERT_BATCH_SCHEMA_VERSION, validateJobAlertBatchEnvelope } from "./job_alert_ingestion_lib.mjs";
import { validateGmailJobAlertsConfig } from "./project_config.mjs";

export const GMAIL_READ_ONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_ALLOWED_OPERATIONS = Object.freeze(["users.messages.list", "users.messages.get"]);
export const GMAIL_FORBIDDEN_OPERATIONS = Object.freeze([
  "users.messages.send", "users.messages.delete", "users.messages.modify", "users.messages.trash", "users.messages.untrash",
  "users.threads.modify", "users.threads.delete", "users.threads.trash", "users.labels.create", "users.labels.update", "users.labels.delete",
]);

export function gmailReadOnlyRequestPlan(config) {
  const validated = validateGmailJobAlertsConfig(config);
  return {
    enabled: validated.enabled,
    access_mode: "read_only",
    oauth_scopes: [GMAIL_READ_ONLY_SCOPE],
    operations: [...GMAIL_ALLOWED_OPERATIONS],
    query: validated.query,
    max_results: validated.max_messages,
    format: "full",
    mutating_operations_allowed: false,
    credentials_required_for_setup_or_tests: false,
  };
}

export function buildJobAlertBatchFromGmail(records, { batchId, retrievedAt, query }) {
  if (!Array.isArray(records)) throw new Error("Normalized Gmail connector records must be an array");
  const batch = {
    schema_version: JOB_ALERT_BATCH_SCHEMA_VERSION,
    batch_id: batchId,
    transport: { provider: "gmail", access_mode: "read_only", query },
    retrieved_at: retrievedAt,
    messages: records.map((record) => ({
      message_id: record.message_id,
      received_at: record.received_at,
      from: record.from,
      subject: record.subject ?? "",
      text_body: record.text_body ?? "",
      html_body: record.html_body ?? "",
    })),
  };
  return validateJobAlertBatchEnvelope(batch);
}
