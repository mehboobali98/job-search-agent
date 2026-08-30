import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectNotificationDeliveryHealth } from "../scripts/inspect_notification_health.mjs";
import { inspectPending } from "../scripts/inspect_pending.mjs";
import { runNotificationStatusProfile } from "../scripts/manage_notification_status_connector.mjs";
import { buildJobDigest, planNotificationDeliveries } from "../scripts/notification_delivery_lib.mjs";
import {
  buildSanitizedNotificationStatusBinding,
  buildNotificationStatusObservation,
  notificationStatusApprovalId,
  validateNotificationConnectorStatusProfile,
  validateNotificationStatusObservation,
} from "../scripts/notification_status_runtime.mjs";
import { runNotificationStatusProbe } from "../scripts/probe_notification_status.mjs";
import { buildNotificationDeliveryHealthReport } from "../scripts/notification_delivery_health_lib.mjs";
import {
  NOTIFICATION_STATUS_ALLOWED_OPERATIONS,
  NOTIFICATION_STATUS_FORBIDDEN_OPERATIONS,
  requireNotificationStatusOperation,
} from "../scripts/notification_status_contract.mjs";

function statusProfile(overrides = {}) {
  return {
    schema_version: 1,
    profile_id: "fictional-status",
    enabled: true,
    connection_ref: "fictional-workspace",
    transport: "https_json_bearer_status",
    endpoint: "https://status.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_STATUS_BEARER" },
    allowed_destinations: [{ destination_id: "slack-jobs", channel: "slack" }],
    request_policy: { timeout_ms: 2_000, max_request_bytes: 4_096, max_response_bytes: 4_096 },
    ...overrides,
  };
}

function localConfig() {
  return {
    version: 6,
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
    notifications: {
      enabled: true,
      max_items_per_digest: 5,
      quiet_hours: { enabled: false, start: "22:00", end: "08:00" },
      destinations: [{
        id: "slack-jobs",
        enabled: true,
        adapter: "connector",
        channel: "slack",
        connection_ref: "fictional-workspace",
        minimum_score: 80,
        max_items: 5,
        include_resume: false,
      }],
    },
  };
}

function connectorRequest(runId, completedAt) {
  const source = {
    run_id: runId,
    completed_at: completedAt,
    replay: { replay_hash: "d".repeat(64) },
    alerts: [{
      lead_id: `L-${runId}`,
      company: "Fictional Status Systems",
      title: "Staff Platform Engineer",
      final_score: 94,
      canonical_url: `https://jobs.example.test/${runId.toLowerCase()}`,
      location: "Remote",
      eligibility: "Eligible",
      strengths: ["Synthetic platform evidence"],
      gaps: ["Synthetic compensation gap"],
      posted_date: "2026-08-29",
      best_resume: "Staff / Principal / Tech Lead",
    }],
  };
  const { digest } = buildJobDigest(source, { generatedAt: completedAt, timezone: "Etc/UTC", maxItems: 5 });
  return planNotificationDeliveries(digest, localConfig().notifications).requests[0];
}

async function workspace(profile = statusProfile()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-status-"));
  const state = path.join(root, "state");
  await fs.mkdir(path.join(state, "notifications", "outbox"), { recursive: true });
  await fs.mkdir(path.join(state, "notification-status-connectors"), { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const profilePath = path.join(state, "notification-status-connectors", `${profile.profile_id}.status-profile.json`);
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n");
  return { root, state, profilePath };
}

async function writeRequest(root, request) {
  const target = path.join(root, "state", "notifications", "outbox", `${request.request_id}.request.json`);
  await fs.writeFile(target, JSON.stringify(request, null, 2) + "\n");
  return target;
}

async function importBinding(root, profilePath) {
  const preview = await runNotificationStatusProfile({ projectRoot: root, profilePath });
  const applied = await runNotificationStatusProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: preview.preview.approval_id,
  });
  return { preview, applied };
}

test("status profiles and bindings are strict, deterministic, and sanitized", () => {
  const profile = validateNotificationConnectorStatusProfile(statusProfile());
  const first = buildSanitizedNotificationStatusBinding(profile);
  const second = buildSanitizedNotificationStatusBinding(statusProfile());
  assert.deepEqual(second, first);
  assert.match(first.binding_id, /^NSTATBIND-/);
  assert.match(first.approval_id, /^NSTATCON-/);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(profile.endpoint), false);
  assert.equal(serialized.includes(profile.authentication.environment_variable), false);
  assert.throws(() => validateNotificationConnectorStatusProfile({
    ...statusProfile(), endpoint: "http://status.example.test/notifications",
  }), /HTTPS/);
  assert.throws(() => validateNotificationConnectorStatusProfile({
    ...statusProfile(), request_policy: { ...statusProfile().request_policy, max_attempts: 2 },
  }), /Unsupported status profile request_policy field/);
});

test("status connector contract permits reads and explicitly forbids delivery or outreach", () => {
  assert.deepEqual(NOTIFICATION_STATUS_ALLOWED_OPERATIONS, ["notifications.status.read"]);
  assert.ok(NOTIFICATION_STATUS_FORBIDDEN_OPERATIONS.includes("notifications.deliver"));
  assert.ok(NOTIFICATION_STATUS_FORBIDDEN_OPERATIONS.includes("applications.submit"));
  assert.ok(NOTIFICATION_STATUS_FORBIDDEN_OPERATIONS.includes("recruiters.contact"));
  assert.equal(requireNotificationStatusOperation("notifications.status.read"), "notifications.status.read");
  assert.throws(() => requireNotificationStatusOperation("notifications.deliver"), /permits only/);
});

test("profile import and request preview are exact, private, and network-free", async () => {
  const { root, profilePath } = await workspace();
  const request = connectorRequest("RUN-STATUS-PREVIEW", "2026-08-30T12:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const { preview, applied } = await importBinding(root, profilePath);
  assert.equal(applied.persistence.persistent_files_written, 1);
  await assert.rejects(runNotificationStatusProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: "NSTATCON-000000000000000000000000",
  }), /exact preview approval/);
  let credentialReads = 0;
  let networkCalls = 0;
  const result = await runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:01:00.000Z",
    environment: new Proxy({}, { get() { credentialReads += 1; return undefined; } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 500 }); },
  });
  assert.equal(result.mode, "preview");
  assert.equal(result.network_attempts, 0);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  assert.match(result.preview.approval_id, /^NSTAT-/);
  assert.equal(JSON.stringify(result).includes(statusProfile().endpoint), false);
  assert.equal(JSON.stringify(result).includes(statusProfile().authentication.environment_variable), false);
  assert.equal(JSON.stringify(preview).includes(statusProfile().endpoint), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("status profile and binding paths reject symbolic-link escapes", {
  skip: process.platform === "win32",
}, async () => {
  const { root, state, profilePath } = await workspace();
  const outsideProfiles = await fs.mkdtemp(path.join(os.tmpdir(), "notification-status-outside-profiles-"));
  const outsideBindings = await fs.mkdtemp(path.join(os.tmpdir(), "notification-status-outside-bindings-"));
  const profileContents = await fs.readFile(profilePath);
  await fs.rm(path.dirname(profilePath), { recursive: true, force: true });
  await fs.writeFile(path.join(outsideProfiles, path.basename(profilePath)), profileContents);
  await fs.symlink(outsideProfiles, path.dirname(profilePath));
  await assert.rejects(runNotificationStatusProfile({ projectRoot: root, profilePath }), /escape private state/);
  await fs.rm(path.dirname(profilePath));
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, profileContents);
  const preview = await runNotificationStatusProfile({ projectRoot: root, profilePath });
  const bindingDirectory = path.join(state, "notifications", "status-connectors");
  await fs.symlink(outsideBindings, bindingDirectory);
  await assert.rejects(runNotificationStatusProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: preview.preview.approval_id,
  }), /regular private directory|escape private state/);
  assert.deepEqual(await fs.readdir(outsideBindings), []);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outsideProfiles, { recursive: true, force: true });
  await fs.rm(outsideBindings, { recursive: true, force: true });
});

test("disabled profiles and wrong approvals block before credential or network access", async () => {
  const { root, profilePath } = await workspace(statusProfile({ enabled: false }));
  const request = connectorRequest("RUN-STATUS-DISABLED", "2026-08-30T12:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  await importBinding(root, profilePath);
  const binding = buildSanitizedNotificationStatusBinding(statusProfile({ enabled: false }));
  let credentialReads = 0;
  let networkCalls = 0;
  await assert.rejects(runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    probe: true,
    approvalId: notificationStatusApprovalId(request, binding),
    environment: new Proxy({}, { get() { credentialReads += 1; return undefined; } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 200 }); },
  }), /profile is disabled/);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  await assert.rejects(runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    probe: true,
    approvalId: "NSTAT-000000000000000000000000",
  }), /exact preview approval/);
  await fs.rm(root, { recursive: true, force: true });
});

test("an exact probe performs one bounded read and health reconciles its sanitized observation", async () => {
  const { root, state, profilePath } = await workspace();
  const request = connectorRequest("RUN-STATUS-SUCCESS", "2026-08-30T12:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const { preview } = await importBinding(root, profilePath);
  let networkCalls = 0;
  let captured;
  const result = await runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    probe: true,
    approvalId: notificationStatusApprovalId(request, preview.preview.binding),
    now: "2026-08-30T12:02:00.000Z",
    environment: { SYNTHETIC_STATUS_BEARER: "synthetic-status-token-value" },
    fetchImpl: async (endpoint, options) => {
      networkCalls += 1;
      captured = { endpoint, options };
      return new Response(JSON.stringify({
        schema_version: 1,
        request_id: request.request_id,
        delivery_status: "delivered",
        observed_at: "2026-08-30T12:01:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(networkCalls, 1);
  assert.equal(result.network_attempts, 1);
  assert.equal(result.external_delivery_performed, false);
  assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.headers["idempotency-key"], result.preview.approval_id);
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(Object.keys(body).sort(), ["operation", "request_id", "request_sha256", "schema_version"]);
  assert.equal(body.operation, "notifications.status.read");
  validateNotificationStatusObservation(result.observation);
  const serialized = JSON.stringify(result.observation);
  assert.equal(serialized.includes(statusProfile().endpoint), false);
  assert.equal(serialized.includes("synthetic-status-token-value"), false);
  assert.equal(serialized.includes("Fictional Status Systems"), false);
  const health = await inspectNotificationDeliveryHealth({
    stateDirectory: state,
    asOf: "2026-08-30T13:00:00.000Z",
  });
  assert.equal(health.schema_version, 2);
  assert.equal(health.counts.confirmed, 1);
  assert.equal(health.requests[0].delivery_evidence, "provider_observation");
  assert.equal(health.requests[0].provider_status, "delivered");
  assert.equal(health.safety.network_accessed, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("provider observations deterministically reconcile rejected, pending, stale, and unknown states", () => {
  const binding = buildSanitizedNotificationStatusBinding(statusProfile());
  const cases = [
    ["REJECTED", "2026-08-30T09:00:00.000Z", "rejected"],
    ["PENDING", "2026-08-30T11:30:00.000Z", "pending"],
    ["STALE", "2026-08-30T08:00:00.000Z", "pending"],
    ["UNKNOWN", "2026-08-30T10:00:00.000Z", "unknown"],
  ];
  const requests = cases.map(([name, observedAt]) => connectorRequest(`RUN-STATUS-${name}`, observedAt));
  const observations = requests.map((request, index) => buildNotificationStatusObservation({
    request,
    binding,
    providerResponse: {
      schema_version: 1,
      request_id: request.request_id,
      delivery_status: cases[index][2],
      observed_at: cases[index][1],
    },
    recordedAt: cases[index][1],
    httpStatus: 200,
  }));
  const report = buildNotificationDeliveryHealthReport({
    requests,
    statusObservations: observations,
    asOf: "2026-08-30T12:00:00.000Z",
    staleAfterHours: 2,
  });
  assert.equal(report.counts.rejected, 1);
  assert.equal(report.counts.queued, 1);
  assert.equal(report.counts.stale, 1);
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.requests.find((item) => item.provider_status === "rejected").recovery_action, "review_provider_status");
  assert.equal(report.requests.find((item) => item.provider_status === "pending" && item.status === "queued").recovery_action, "none");
  assert.equal(report.requests.find((item) => item.status === "stale").recovery_action, "review_provider_status");
  const conflicting = buildNotificationStatusObservation({
    request: requests[0],
    binding,
    providerResponse: {
      schema_version: 1,
      request_id: requests[0].request_id,
      delivery_status: "delivered",
      observed_at: cases[0][1],
    },
    recordedAt: cases[0][1],
    httpStatus: 200,
  });
  const conflicted = buildNotificationDeliveryHealthReport({
    requests: [requests[0]],
    statusObservations: [observations[0], conflicting],
    asOf: "2026-08-30T12:00:00.000Z",
  });
  assert.equal(conflicted.counts.artifact_issues, 1);
  assert.equal(conflicted.artifact_issues[0].issue_code, "status_observation_conflict");
});

test("confirmed probe recovery persists without another network call and remains redacted", async () => {
  const { root, state, profilePath } = await workspace();
  const request = connectorRequest("RUN-STATUS-RECOVERY", "2026-08-30T14:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const { preview } = await importBinding(root, profilePath);
  const approvalId = notificationStatusApprovalId(request, preview.preview.binding);
  let networkCalls = 0;
  await assert.rejects(runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    probe: true,
    approvalId,
    now: "2026-08-30T14:02:00.000Z",
    environment: { SYNTHETIC_STATUS_BEARER: "synthetic-status-token-value" },
    fetchImpl: async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({
        schema_version: 1,
        request_id: request.request_id,
        delivery_status: "rejected",
        observed_at: "2026-08-30T14:01:00.000Z",
      }), { status: 200 });
    },
    beforeObservationCommit: async () => { throw new Error("Synthetic observation commit failure"); },
  }), /sanitized observation could not be committed/);
  const marker = path.join(state, `pending-notification-status-${request.request_id}.json`);
  const markerText = await fs.readFile(marker, "utf8");
  assert.equal(markerText.includes(statusProfile().endpoint), false);
  assert.equal(markerText.includes("synthetic-status-token-value"), false);
  assert.equal(markerText.includes("Fictional Status Systems"), false);
  const pending = await inspectPending({ stateDirectory: state });
  assert.equal(pending.marker_count, 1);
  assert.match(pending.markers[0].recovery.steps[0], /probe_notification_status\.mjs/);
  assert.match(pending.markers[0].recovery.steps[0], /--probe/);
  const recovered = await runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    recoverPath: marker,
    probe: true,
    approvalId,
    now: "2026-08-30T14:03:00.000Z",
    environment: new Proxy({}, { get() { throw new Error("credential must not be read during confirmed recovery"); } }),
    fetchImpl: async () => { networkCalls += 1; throw new Error("network must not be used during confirmed recovery"); },
  });
  assert.equal(networkCalls, 1);
  assert.equal(recovered.network_attempts, 0);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.observation.delivery_status, "rejected");
  await assert.rejects(fs.access(marker), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("provider failures perform no retry and health reports only redacted unknown recovery", async () => {
  const { root, state, profilePath } = await workspace();
  const request = connectorRequest("RUN-STATUS-UNKNOWN", "2026-08-30T15:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const { preview } = await importBinding(root, profilePath);
  let networkCalls = 0;
  await assert.rejects(runNotificationStatusProbe({
    projectRoot: root,
    requestPath,
    profilePath,
    probe: true,
    approvalId: notificationStatusApprovalId(request, preview.preview.binding),
    now: "2026-08-30T15:02:00.000Z",
    environment: { SYNTHETIC_STATUS_BEARER: "synthetic-status-token-value" },
    fetchImpl: async () => {
      networkCalls += 1;
      return new Response("private provider failure body", { status: 503 });
    },
  }), /returned HTTP 503/);
  assert.equal(networkCalls, 1);
  const markerPath = path.join(state, `pending-notification-status-${request.request_id}.json`);
  const markerText = await fs.readFile(markerPath, "utf8");
  assert.equal(markerText.includes("private provider failure body"), false);
  assert.equal(markerText.includes(statusProfile().endpoint), false);
  assert.equal(markerText.includes("synthetic-status-token-value"), false);
  const health = await inspectNotificationDeliveryHealth({
    stateDirectory: state,
    asOf: "2026-08-30T16:00:00.000Z",
  });
  assert.equal(health.counts.unknown, 1);
  assert.equal(health.requests[0].delivery_evidence, "status_recovery_marker");
  assert.equal(health.requests[0].recovery_action, "run_pending_inspection");
  assert.equal(health.safety.network_accessed, false);
  await fs.rm(root, { recursive: true, force: true });
});
