import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJobAlertBatchFromGmail,
  GMAIL_ALLOWED_OPERATIONS,
  GMAIL_FORBIDDEN_OPERATIONS,
  GMAIL_READ_ONLY_SCOPE,
  gmailReadOnlyRequestPlan,
} from "../scripts/gmail_connector_contract.mjs";

const config = {
  enabled: true,
  read_only: true,
  query: "label:fictional-alerts newer_than:7d",
  freshness_hours: 168,
  max_messages: 25,
  max_links_per_message: 10,
  sender_allowlist: ["notifications.example.test"],
};

test("Gmail connector boundary exposes only read operations and readonly scope", () => {
  const plan = gmailReadOnlyRequestPlan(config);
  assert.deepEqual(plan.oauth_scopes, [GMAIL_READ_ONLY_SCOPE]);
  assert.deepEqual(plan.operations, [...GMAIL_ALLOWED_OPERATIONS]);
  assert.equal(plan.mutating_operations_allowed, false);
  assert.equal(plan.credentials_required_for_setup_or_tests, false);
  assert.ok(GMAIL_FORBIDDEN_OPERATIONS.includes("users.messages.send"));
  assert.ok(GMAIL_FORBIDDEN_OPERATIONS.includes("users.messages.delete"));
  assert.ok(GMAIL_FORBIDDEN_OPERATIONS.includes("users.messages.modify"));
});

test("normalized Gmail records become the transport-neutral batch contract", () => {
  const batch = buildJobAlertBatchFromGmail([{
    message_id: "synthetic-connector-record",
    received_at: "2026-08-30T07:00:00Z",
    from: "Alerts <alerts@notifications.example.test>",
    subject: "Fictional role",
    text_body: "https://jobs.ashbyhq.com/example/role-1",
  }], {
    batchId: "synthetic-connector-batch",
    retrievedAt: "2026-08-30T08:00:00Z",
    query: config.query,
  });
  assert.equal(batch.schema_version, 1);
  assert.equal(batch.transport.provider, "gmail");
  assert.equal(batch.transport.access_mode, "read_only");
  assert.equal(batch.messages.length, 1);
});
