import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedPublicPath, publicContentViolations } from "../scripts/public_repo_privacy.mjs";

test("private email exports and candidate artifacts are blocked from the public repository", () => {
  for (const name of [
    "gmail-imports/private.json", "job-alert-imports/batch.json", "email-imports/export.json",
    "historical-imports/old-tracker.json", "tracker-imports/mapping.json", "private-history.xlsx",
    "notification-exports/digest.json", "digest-exports/request.json",
    "notification-health-exports/report.json", "delivery-health-exports/report.json",
    "notification-status-exports/observation.json", "provider-status-exports/observation.json",
    "notification-connectors/live.profile.json", "connector-profiles/live.json",
    "notification-status-connectors/live.status-profile.json", "status-connector-profiles/live.json",
    "mailbox.eml", "archive.mbox", "mail-export.zip", "profile/candidate-profile.md", "profile/resumes/private.pdf", "state/private.json",
  ]) assert.equal(isBlockedPublicPath(name), true, name);
  assert.equal(isBlockedPublicPath("fixtures/job-alert-batch.synthetic.json"), false);
  assert.equal(isBlockedPublicPath("schemas/job-alert-batch.v1.schema.json"), false);
});

test("private live connector profiles, bindings, and receipts cannot enter the public tree", () => {
  const profile = JSON.stringify({
    schema_version: 1,
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_CONNECTOR_BEARER" },
  });
  const binding = JSON.stringify({ binding_id: "NCBIND-AAAAAAAAAAAAAAAAAAAAAAAA", profile_sha256: "a".repeat(64) });
  const receipt = JSON.stringify({ receipt_id: "NCREC-BBBBBBBBBBBBBBBBBBBBBBBB", request_sha256: "b".repeat(64) });
  assert.ok(publicContentViolations(profile, { fileName: "live-profile.json" }).includes("private notification connector profile"));
  assert.ok(publicContentViolations(binding, { fileName: "binding.json" }).includes("private notification connector binding"));
  assert.ok(publicContentViolations(receipt, { fileName: "receipt.json" }).includes("private notification connector receipt"));
});

test("private delivery health reports cannot enter the public tree", () => {
  const report = JSON.stringify({
    schema_version: 1,
    report_id: "NHEALTH-AAAAAAAAAAAAAAAAAAAAAAAA",
    counts: { total_requests: 1 },
    requests: [{ request_id: "NREQ-BBBBBBBBBBBBBBBBBBBBBBBB" }],
    artifact_issues: [],
  });
  assert.ok(publicContentViolations(report, { fileName: "health.json" }).includes("private notification delivery health report"));
  assert.equal(publicContentViolations(report, { fileName: "fixtures/health.synthetic.json" }).includes("private notification delivery health report"), false);
});

test("private provider-status profiles, bindings, and observations cannot enter the public tree", () => {
  const profile = JSON.stringify({
    schema_version: 1,
    transport: "https_json_bearer_status",
    endpoint: "https://status.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_STATUS_BEARER" },
  });
  const binding = JSON.stringify({
    binding_id: "NSTATBIND-AAAAAAAAAAAAAAAAAAAAAAAA",
    profile_sha256: "a".repeat(64),
  });
  const observation = JSON.stringify({
    observation_id: "NSTATOBS-BBBBBBBBBBBBBBBBBBBBBBBB",
    request_sha256: "b".repeat(64),
  });
  assert.ok(publicContentViolations(profile, { fileName: "status-profile.json" }).includes("private notification status profile"));
  assert.ok(publicContentViolations(binding, { fileName: "status-binding.json" }).includes("private notification status binding"));
  assert.ok(publicContentViolations(observation, { fileName: "status-observation.json" }).includes("private notification status observation"));
  assert.equal(publicContentViolations(observation, { fileName: "fixtures/status.synthetic.json" }).includes("private notification status observation"), false);
});

test("private notification delivery requests are rejected outside fixtures", () => {
  const request = JSON.stringify({
    schema_version: 1,
    request_id: "NREQ-AAAAAAAAAAAAAAAAAAAAAAAA",
    destination: { id: "local", adapter: "private_file", channel: "local" },
    items: [{ lead_id: "L-SYNTHETIC" }],
  });
  assert.ok(publicContentViolations(request, { fileName: "notification.json" }).includes("private notification delivery request"));
  assert.equal(publicContentViolations(request, { fileName: "fixtures/notification.synthetic.json" }).includes("private notification delivery request"), false);
});

test("real email addresses are rejected while reserved synthetic domains remain usable", () => {
  assert.deepEqual(publicContentViolations("Contact alerts@example.test for synthetic data."), []);
  const privateAddress = ["private.person", "private.example.biz"].join("@");
  assert.ok(publicContentViolations("Contact " + privateAddress).includes("email address"));
});

test("raw message batches are rejected outside the synthetic fixture namespace", () => {
  const rawBatch = JSON.stringify({
    schema_version: 1,
    transport: { provider: "gmail", access_mode: "read_only" },
    messages: [{ from: "alerts@example.test", text_body: "private body" }],
  });
  assert.ok(publicContentViolations(rawBatch, { fileName: "batch.json" }).includes("private job-alert message batch"));
  assert.equal(publicContentViolations(rawBatch, { fileName: "fixtures/synthetic.json" }).includes("private job-alert message batch"), false);
});
