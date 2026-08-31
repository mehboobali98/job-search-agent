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
    "notification-connector-discovery/private.capabilities.json", "connector-capability-exports/account.json",
    "connector-discovery/catalog.json",
    "notification-connector-drift-exports/report.json", "connector-drift-exports/report.json",
    "notification-connector-history-exports/report.json", "connector-catalog-history-exports/report.json",
    "notification-connector-profile-plan-exports/plan.json", "connector-authoring-plan-exports/plan.json",
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

test("private native-rendering profiles and sanitized target bindings cannot enter the public tree", () => {
  const profile = JSON.stringify({
    schema_version: 2,
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_BEARER" },
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      rendering: { renderer: "slack_blocks_v1", target: "C0123456789" },
    }],
  });
  const binding = JSON.stringify({
    schema_version: 2,
    binding_id: "NCBIND-AAAAAAAAAAAAAAAAAAAAAAAA",
    profile_sha256: "a".repeat(64),
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      renderer: "slack_blocks_v1",
      target_sha256: "b".repeat(64),
    }],
  });
  assert.ok(publicContentViolations(profile, { fileName: "native-profile.json" }).includes("private notification connector profile"));
  assert.ok(publicContentViolations(binding, { fileName: "native-binding.json" }).includes("private notification connector binding"));
});

test("private connector capability exports and sanitized catalogs cannot enter the public tree", () => {
  const capabilityExport = JSON.stringify({
    schema_version: 1,
    export_id: "NCAPEXP-AAAAAAAAAAAAAAAAAAAAAAAA",
    account_ref: "fictional-account-42",
    targets: [{ target: "C0123456789", label: "Fictional Jobs" }],
  });
  const catalog = JSON.stringify({
    schema_version: 1,
    catalog_id: "NCAPCAT-BBBBBBBBBBBBBBBBBBBBBBBB",
    source_sha256: "c".repeat(64),
    targets: [{
      target_id: "NCAPTGT-DDDDDDDDDDDDDDDDDDDDDDDD",
      target_sha256: "e".repeat(64),
    }],
  });
  assert.ok(publicContentViolations(capabilityExport, { fileName: "capabilities.json" })
    .includes("private notification connector capability export"));
  assert.ok(publicContentViolations(catalog, { fileName: "catalog.json" })
    .includes("private notification connector capability catalog"));
  assert.equal(publicContentViolations(catalog, { fileName: "fixtures/catalog.synthetic.json" })
    .includes("private notification connector capability catalog"), false);
});

test("private connector drift reports cannot enter the public tree", () => {
  const report = JSON.stringify({
    schema_version: 1,
    report_id: "NCAPDRIFT-AAAAAAAAAAAAAAAAAAAAAAAA",
    catalog_id: "NCAPCAT-BBBBBBBBBBBBBBBBBBBBBBBB",
    binding_id: "NCBIND-CCCCCCCCCCCCCCCCCCCCCCCC",
    binding_destinations: [{ destination_id: "fictional-slack" }],
    catalog_targets: [{ target_id: "NCAPTGT-DDDDDDDDDDDDDDDDDDDDDDDD" }],
  });
  assert.ok(publicContentViolations(report, { fileName: "connector-drift.json" })
    .includes("private notification connector drift report"));
  assert.equal(publicContentViolations(report, { fileName: "fixtures/connector-drift.synthetic.json" })
    .includes("private notification connector drift report"), false);
});

test("private connector catalog history reports cannot enter the public tree", () => {
  const report = JSON.stringify({
    schema_version: 1,
    report_id: "NCAPHIST-AAAAAAAAAAAAAAAAAAAAAAAA",
    before_catalog_id: "NCAPCAT-BBBBBBBBBBBBBBBBBBBBBBBB",
    after_catalog_id: "NCAPCAT-CCCCCCCCCCCCCCCCCCCCCCCC",
    target_changes: [{ change_id: "NCAPHCHG-DDDDDDDDDDDDDDDDDDDDDDDD" }],
  });
  assert.ok(publicContentViolations(report, { fileName: "catalog-history.json" })
    .includes("private notification connector catalog history report"));
  assert.equal(publicContentViolations(report, { fileName: "fixtures/catalog-history.synthetic.json" })
    .includes("private notification connector catalog history report"), false);
});

test("private connector profile authoring plans cannot enter the public tree", () => {
  const plan = JSON.stringify({
    schema_version: 1,
    plan_id: "NCAPPROF-AAAAAAAAAAAAAAAAAAAAAAAA",
    catalog_id: "NCAPCAT-BBBBBBBBBBBBBBBBBBBBBBBB",
    selected_target_ref: "NCAPPROFTGT-CCCCCCCCCCCCCCCCCCCCCCCC",
    required_manual_inputs: ["profile_id", "https_endpoint", "bearer_environment_variable"],
  });
  assert.ok(publicContentViolations(plan, { fileName: "connector-profile-plan.json" })
    .includes("private notification connector profile authoring plan"));
  assert.equal(publicContentViolations(plan, { fileName: "fixtures/connector-profile-plan.synthetic.json" })
    .includes("private notification connector profile authoring plan"), false);
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
