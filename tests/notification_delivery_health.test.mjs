import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNotificationDeliveryHealthReport,
  validateNotificationDeliveryHealthReport,
} from "../scripts/notification_delivery_health_lib.mjs";
import { inspectNotificationDeliveryHealth, runNotificationDeliveryHealth } from "../scripts/inspect_notification_health.mjs";
import {
  buildNotificationConnectorReceipt,
  buildSanitizedNotificationConnectorBinding,
  notificationConnectorRequestHash,
} from "../scripts/notification_connector_runtime.mjs";
import { buildJobDigest, planNotificationDeliveries } from "../scripts/notification_delivery_lib.mjs";

function profile() {
  return {
    schema_version: 1,
    profile_id: "fictional-health",
    enabled: false,
    connection_ref: "fictional-workspace",
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_CONNECTOR_BEARER" },
    allowed_destinations: [{ destination_id: "health-jobs", channel: "slack" }],
    request_policy: {
      timeout_ms: 2_000,
      max_request_bytes: 65_536,
      max_response_bytes: 4_096,
      max_attempts: 2,
      retry_delays_ms: [250],
    },
    idempotency: { required: true, header: "Idempotency-Key" },
  };
}

function connectorRequest(runId, generatedAt, quietHours = { enabled: false, start: "22:00", end: "08:00" }) {
  const source = {
    run_id: runId,
    completed_at: generatedAt,
    replay: { replay_hash: crypto.createHash("sha256").update(runId).digest("hex") },
    alerts: [{
      lead_id: `L-${runId}`,
      company: "Fictional Health Systems",
      title: "Synthetic Reliability Engineer",
      final_score: 91,
      canonical_url: `https://jobs.example.test/${runId.toLowerCase()}`,
      location: "Remote",
      eligibility: "Eligible",
      strengths: ["Synthetic delivery evidence"],
      gaps: ["Synthetic monitoring gap"],
      posted_date: "2026-08-29",
      best_resume: "Backend / Platform",
    }],
  };
  const { digest } = buildJobDigest(source, { generatedAt, timezone: "Etc/UTC", maxItems: 1 });
  return planNotificationDeliveries(digest, {
    enabled: true,
    max_items_per_digest: 1,
    quiet_hours: quietHours,
    destinations: [{
      id: "health-jobs",
      enabled: true,
      adapter: "connector",
      channel: "slack",
      connection_ref: "fictional-workspace",
      minimum_score: 80,
      max_items: 1,
      include_resume: false,
    }],
  }).requests[0];
}

function recoveryMarker(request, binding, deliveryState, createdAt, { httpStatus = null, receipt = null, attempts = 1 } = {}) {
  const retryable = httpStatus === null || httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500;
  return {
    schema_version: 1,
    workflow: "notification_connector_dispatch",
    created_at: createdAt,
    request_id: request.request_id,
    approval_id: request.approval_id,
    binding_id: binding.binding_id,
    profile_id: profile().profile_id,
    connection_ref: profile().connection_ref,
    request_sha256: notificationConnectorRequestHash(request),
    profile_sha256: binding.profile_sha256,
    idempotency_key: request.request_id,
    delivery_state: deliveryState,
    attempts,
    last_failure: deliveryState === "confirmed" ? null : {
      category: httpStatus === null ? "transport" : "http_status",
      http_status: httpStatus,
      retryable,
    },
    confirmed_receipt: receipt,
    error: deliveryState === "confirmed" ? null : "Synthetic redacted connector outcome",
    safety: {
      endpoint_included: false,
      credential_included: false,
      response_body_included: false,
      request_items_included: false,
    },
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function directorySnapshot(root) {
  const records = [];
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) records.push([relative, crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex")]);
      else records.push([relative, "non-file"]);
    }
  }
  await visit(root);
  return records;
}

test("delivery health deterministically classifies every bounded connector state", () => {
  const binding = buildSanitizedNotificationConnectorBinding(profile());
  const confirmed = connectorRequest("RUN-HEALTH-CONFIRMED", "2026-08-30T06:00:00.000Z");
  const rejected = connectorRequest("RUN-HEALTH-REJECTED", "2026-08-30T07:00:00.000Z");
  const unknown = connectorRequest("RUN-HEALTH-UNKNOWN", "2026-08-30T08:00:00.000Z");
  const stale = connectorRequest("RUN-HEALTH-STALE", "2026-08-30T09:00:00.000Z");
  const deferred = connectorRequest(
    "RUN-HEALTH-DEFERRED", "2026-08-30T11:00:00.000Z",
    { enabled: true, start: "10:00", end: "13:00" },
  );
  const queued = connectorRequest("RUN-HEALTH-QUEUED", "2026-08-30T11:30:00.000Z");
  const receipt = buildNotificationConnectorReceipt({
    request: confirmed,
    binding,
    deliveredAt: "2026-08-30T06:30:00.000Z",
    httpStatus: 202,
    attempts: 1,
  });
  const report = buildNotificationDeliveryHealthReport({
    requests: [queued, unknown, confirmed, deferred, rejected, stale],
    receipts: [receipt],
    recoveryMarkers: [
      recoveryMarker(rejected, binding, "rejected", "2026-08-30T07:30:00.000Z", { httpStatus: 400 }),
      recoveryMarker(unknown, binding, "unknown", "2026-08-30T08:30:00.000Z", { httpStatus: 503, attempts: 2 }),
    ],
    asOf: "2026-08-30T12:00:00.000Z",
    staleAfterHours: 2,
  });
  assert.deepEqual(report.counts, {
    total_requests: 6,
    confirmed: 1,
    rejected: 1,
    unknown: 1,
    deferred: 1,
    queued: 1,
    stale: 1,
    requires_attention: 3,
    artifact_issues: 0,
  });
  assert.deepEqual([...report.requests].map((item) => item.status).sort(), [
    "confirmed", "deferred", "queued", "rejected", "stale", "unknown",
  ]);
  assert.equal(report.requests.find((item) => item.status === "confirmed").delivery_evidence, "receipt");
  assert.equal(report.requests.find((item) => item.status === "rejected").recovery_action, "run_pending_inspection");
  assert.equal(report.requests.find((item) => item.status === "deferred").recovery_action, "wait_until_not_before");
  assert.equal(report.requests.find((item) => item.status === "stale").recovery_action, "review_outbox");
  assert.equal(validateNotificationDeliveryHealthReport(report), report);
  assert.deepEqual(buildNotificationDeliveryHealthReport({
    requests: [queued, unknown, confirmed, deferred, rejected, stale],
    receipts: [receipt],
    recoveryMarkers: [
      recoveryMarker(rejected, binding, "rejected", "2026-08-30T07:30:00.000Z", { httpStatus: 400 }),
      recoveryMarker(unknown, binding, "unknown", "2026-08-30T08:30:00.000Z", { httpStatus: 503, attempts: 2 }),
    ],
    asOf: "2026-08-30T12:00:00.000Z",
    staleAfterHours: 2,
  }), report);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Fictional Health Systems"), false);
  assert.equal(serialized.includes(profile().endpoint), false);
  assert.equal(serialized.includes(profile().authentication.environment_variable), false);
  assert.equal(report.safety.network_accessed, false);
  assert.equal(report.safety.state_written, false);
  assert.equal(report.safety.automatic_retry_performed, false);
});

test("confirmed recovery and receipt-marker conflicts require inspection without resending", () => {
  const binding = buildSanitizedNotificationConnectorBinding(profile());
  const pendingReceipt = connectorRequest("RUN-HEALTH-CONFIRMED-PENDING", "2026-08-30T08:00:00.000Z");
  const persisted = connectorRequest("RUN-HEALTH-RECEIPT-CONFLICT", "2026-08-30T09:00:00.000Z");
  const pendingReceiptValue = buildNotificationConnectorReceipt({
    request: pendingReceipt, binding, deliveredAt: "2026-08-30T08:30:00.000Z", httpStatus: 204, attempts: 1,
  });
  const persistedReceipt = buildNotificationConnectorReceipt({
    request: persisted, binding, deliveredAt: "2026-08-30T09:30:00.000Z", httpStatus: 202, attempts: 1,
  });
  const report = buildNotificationDeliveryHealthReport({
    requests: [pendingReceipt, persisted],
    receipts: [persistedReceipt],
    recoveryMarkers: [
      recoveryMarker(pendingReceipt, binding, "confirmed", "2026-08-30T08:30:00.000Z", { receipt: pendingReceiptValue }),
      recoveryMarker(persisted, binding, "rejected", "2026-08-30T09:31:00.000Z", { httpStatus: 400 }),
    ],
    asOf: "2026-08-30T10:00:00.000Z",
  });
  assert.equal(report.counts.confirmed, 2);
  assert.equal(report.counts.requires_attention, 2);
  assert.equal(report.counts.artifact_issues, 1);
  assert.equal(report.artifact_issues[0].issue_code, "receipt_marker_conflict");
  assert.ok(report.requests.every((item) => item.recovery_action === "run_pending_inspection"));
  assert.equal(report.guidance.automatic_retry_available, false);
});

test("filesystem inspection is bounded, privacy-minimized, and strictly read-only", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "notification-health-"));
  const outbox = path.join(state, "notifications", "outbox");
  const receipts = path.join(state, "notifications", "receipts");
  const binding = buildSanitizedNotificationConnectorBinding(profile());
  const delivered = connectorRequest("RUN-HEALTH-FS-DELIVERED", "2026-08-30T08:00:00.000Z");
  const orphan = connectorRequest("RUN-HEALTH-FS-ORPHAN", "2026-08-30T08:10:00.000Z");
  const deliveredReceipt = buildNotificationConnectorReceipt({
    request: delivered, binding, deliveredAt: "2026-08-30T08:30:00.000Z", httpStatus: 202, attempts: 1,
  });
  const orphanReceipt = buildNotificationConnectorReceipt({
    request: orphan, binding, deliveredAt: "2026-08-30T08:40:00.000Z", httpStatus: 202, attempts: 1,
  });
  await writeJson(path.join(outbox, `${delivered.request_id}.request.json`), delivered);
  await writeJson(path.join(receipts, `${delivered.request_id}.receipt.json`), deliveredReceipt);
  await writeJson(path.join(receipts, `${orphan.request_id}.receipt.json`), orphanReceipt);
  await fs.writeFile(path.join(outbox, "invalid.request.json"), "{not-json\n");
  await fs.writeFile(path.join(outbox, "oversized.request.json"), "x".repeat(256 * 1024 + 1));
  if (process.platform !== "win32") {
    await fs.symlink(path.join(outbox, `${delivered.request_id}.request.json`), path.join(outbox, "linked.request.json"));
  }
  const before = await directorySnapshot(state);
  const first = await inspectNotificationDeliveryHealth({
    stateDirectory: state,
    asOf: "2026-08-30T12:00:00.000Z",
    staleAfterHours: 24,
  });
  const second = await inspectNotificationDeliveryHealth({
    stateDirectory: state,
    asOf: "2026-08-30T12:00:00.000Z",
    staleAfterHours: 24,
  });
  const after = await directorySnapshot(state);
  assert.deepEqual(second, first);
  assert.deepEqual(after, before);
  assert.equal(first.counts.total_requests, 1);
  assert.equal(first.counts.confirmed, 1);
  const expectedIssues = ["invalid_json", "orphaned_receipt", "oversized"];
  if (process.platform !== "win32") expectedIssues.push("not_regular_file");
  assert.equal(first.counts.artifact_issues, expectedIssues.length);
  assert.deepEqual(first.artifact_issues.map((issue) => issue.issue_code).sort(), expectedIssues.sort());
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(state), false);
  assert.equal(serialized.includes("Fictional Health Systems"), false);
  assert.equal(serialized.includes("jobs.example.test"), false);
  assert.equal(serialized.includes(profile().endpoint), false);
  assert.equal(first.safety.profile_files_read, false);
  assert.equal(first.safety.credential_environment_read, false);
  await fs.rm(state, { recursive: true, force: true });
});

test("health validation rejects drift and unbounded scans", () => {
  const request = connectorRequest("RUN-HEALTH-VALIDATION", "2026-08-30T11:00:00.000Z");
  const report = buildNotificationDeliveryHealthReport({
    requests: [request], asOf: "2026-08-30T12:00:00.000Z", staleAfterHours: 24,
  });
  assert.throws(() => validateNotificationDeliveryHealthReport({
    ...report, safety: { ...report.safety, network_accessed: true },
  }), /safety flags/);
  assert.throws(() => buildNotificationDeliveryHealthReport({
    requests: [request], asOf: "2026-08-30T12:00:00.000Z", staleAfterHours: 0,
  }), /stale_after_hours/);
  assert.throws(() => buildNotificationDeliveryHealthReport({
    recoveryMarkers: Array.from({ length: 1_001 }), asOf: "2026-08-30T12:00:00.000Z",
  }), /at most 1000 artifacts/);
});

test("project inspection reads supported version 5 configuration without migrating it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-health-v5-"));
  const configPath = path.join(root, ".job-search.local.json");
  const config = {
    version: 5,
    candidate_name: "Synthetic Candidate",
    timezone: "Etc/UTC",
    target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx",
    candidate_profile_path: "profile/candidate.md",
    search_terms_path: "profile/search-terms.json",
    eligibility_evidence_path: "profile/eligibility.json",
    resumes_directory: "profile/resumes",
    state_directory: "state",
    application_packages_directory: "application-packages",
    reliability: {
      require_preflight: true,
      pending_retention_days: 30,
      query_recommendation_window: 20,
      query_recommendation_min_attempts: 5,
    },
    gmail_job_alerts: {
      enabled: false,
      read_only: true,
      query: "newer_than:7d",
      freshness_hours: 168,
      max_messages: 50,
      max_links_per_message: 20,
      sender_allowlist: [],
    },
  };
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const before = await directorySnapshot(root);
  const report = await runNotificationDeliveryHealth({
    projectRoot: root,
    asOf: "2026-08-30T12:00:00.000Z",
  });
  const after = await directorySnapshot(root);
  assert.equal(report.counts.total_requests, 0);
  assert.equal(report.safety.state_written, false);
  assert.deepEqual(after, before);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), config);
  await fs.rm(root, { recursive: true, force: true });
});

test("inspection rejects a notification directory that escapes private state through a link", {
  skip: process.platform === "win32",
}, async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "notification-health-link-state-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "notification-health-link-outside-"));
  await fs.mkdir(path.join(outside, "outbox"), { recursive: true });
  await fs.symlink(outside, path.join(state, "notifications"));
  await assert.rejects(inspectNotificationDeliveryHealth({
    stateDirectory: state,
    asOf: "2026-08-30T12:00:00.000Z",
  }), /regular directory/);
  await fs.rm(state, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
