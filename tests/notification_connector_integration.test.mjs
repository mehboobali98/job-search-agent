import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNotificationConnectorDispatch } from "../scripts/dispatch_notifications.mjs";
import { runNotificationConnectorProfile } from "../scripts/manage_notification_connector.mjs";
import { buildJobDigest, planNotificationDeliveries } from "../scripts/notification_delivery_lib.mjs";

function connectorProfile() {
  return {
    schema_version: 1,
    profile_id: "fictional-slack",
    enabled: true,
    connection_ref: "fictional-workspace",
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_CONNECTOR_BEARER" },
    allowed_destinations: [{ destination_id: "slack-jobs", channel: "slack" }],
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

function nativeConnectorProfile() {
  return {
    ...connectorProfile(),
    schema_version: 2,
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      rendering: { renderer: "slack_blocks_v1", target: "C0123456789" },
    }],
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
    reliability: { require_preflight: true, pending_retention_days: 30, query_recommendation_window: 20, query_recommendation_min_attempts: 5 },
    gmail_job_alerts: { enabled: false, read_only: true, query: "newer_than:7d", freshness_hours: 168, max_messages: 50, max_links_per_message: 20, sender_allowlist: [] },
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

function connectorRequest(runId, completedAt, alertCount = 1) {
  const source = {
    run_id: runId,
    completed_at: completedAt,
    replay: { replay_hash: "d".repeat(64) },
    alerts: Array.from({ length: alertCount }, (_, index) => ({
      lead_id: `L-${runId}-${index + 1}`,
      company: `Fictional Systems ${index + 1}`,
      title: "Staff Platform Engineer for Synthetic Distributed Systems",
      final_score: 94 - index,
      canonical_url: `https://jobs.example.test/${runId.toLowerCase()}/${index + 1}`,
      location: "Worldwide Remote Synthetic Region",
      eligibility: "Eligible",
      strengths: ["Synthetic platform reliability and distributed systems evidence"],
      gaps: ["Synthetic compensation and timezone overlap gap"],
      posted_date: "2026-08-29",
      best_resume: "Staff / Principal / Tech Lead",
    })),
  };
  const { digest } = buildJobDigest(source, { generatedAt: completedAt, timezone: "Etc/UTC", maxItems: 5 });
  return planNotificationDeliveries(digest, localConfig().notifications).requests[0];
}

async function workspace(privateProfile = connectorProfile()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-connector-"));
  await fs.mkdir(path.join(root, "state", "notifications", "outbox"), { recursive: true });
  await fs.mkdir(path.join(root, "state", "notification-connectors"), { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const profilePath = path.join(root, "state", "notification-connectors", "fictional-slack.profile.json");
  await fs.writeFile(profilePath, JSON.stringify(privateProfile, null, 2) + "\n");
  return { root, profilePath };
}

test("a disabled private profile blocks before credential lookup or network activity", async () => {
  const { root, profilePath } = await workspace({ ...connectorProfile(), enabled: false });
  const request = connectorRequest("RUN-FICTIONAL-DISABLED", "2026-08-30T11:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let credentialReads = 0;
  let networkCalls = 0;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T11:01:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: new Proxy({}, { get() { credentialReads += 1; return undefined; } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 204 }); },
  }), /profile is disabled/);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

async function writeRequest(root, request) {
  const requestPath = path.join(root, "state", "notifications", "outbox", `${request.request_id}.request.json`);
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2) + "\n");
  return requestPath;
}

test("profile import and connector preview are sanitized and network-free", async () => {
  const { root, profilePath } = await workspace();
  const request = connectorRequest("RUN-FICTIONAL-PREVIEW", "2026-08-30T12:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  assert.equal(profilePreview.mode, "preview");
  assert.equal(profilePreview.persistence.persistent_files_written, 0);
  assert.equal(JSON.stringify(profilePreview).includes(connectorProfile().endpoint), false);
  assert.equal(JSON.stringify(profilePreview).includes(connectorProfile().authentication.environment_variable), false);
  await assert.rejects(runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: "NCON-000000000000000000000000",
  }), /exact preview approval/);
  const imported = await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  assert.equal(imported.persistence.persistent_files_written, 1);
  let credentialReads = 0;
  let networkCalls = 0;
  const preview = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:01:00.000Z",
    environment: new Proxy({}, { get() { credentialReads += 1; return undefined; } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 204 }); },
  });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.network_attempts, 0);
  assert.equal(preview.external_delivery_performed, false);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  assert.equal(JSON.stringify(preview).includes(connectorProfile().endpoint), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("native rendering stays private during preview and is used only for an exactly approved send", async () => {
  const privateProfile = nativeConnectorProfile();
  const { root, profilePath } = await workspace(privateProfile);
  const request = connectorRequest("RUN-FICTIONAL-NATIVE", "2026-08-30T12:30:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  assert.equal(profilePreview.preview.profile_schema_version, 2);
  assert.equal(profilePreview.preview.native_target_included, false);
  assert.equal(JSON.stringify(profilePreview).includes("C0123456789"), false);
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });

  let credentialReads = 0;
  let networkCalls = 0;
  const preview = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:31:00.000Z",
    environment: new Proxy({}, { get() { credentialReads += 1; return undefined; } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 204 }); },
  });
  assert.equal(preview.preview.renderer, "slack_blocks_v1");
  assert.equal(preview.preview.native_rendering, true);
  assert.equal(preview.preview.native_target_included, false);
  assert.equal(preview.preview.rendered_payload_included, false);
  assert.equal(JSON.stringify(preview).includes("C0123456789"), false);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);

  let networkPayload;
  const delivered = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:31:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    fetchImpl: async (_endpoint, options) => {
      networkCalls += 1;
      networkPayload = JSON.parse(options.body);
      return new Response(null, { status: 202 });
    },
  });
  assert.equal(networkCalls, 1);
  assert.equal(networkPayload.channel, "C0123456789");
  assert.equal(networkPayload.blocks[0].type, "header");
  assert.equal(JSON.stringify(delivered).includes("C0123456789"), false);
  assert.equal(JSON.stringify(delivered).includes("Fictional Systems"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("native rendered-body limits block before credential access or network activity", async () => {
  const privateProfile = {
    ...nativeConnectorProfile(),
    request_policy: {
      ...nativeConnectorProfile().request_policy,
      max_request_bytes: 1_024,
    },
  };
  const { root, profilePath } = await workspace(privateProfile);
  const request = connectorRequest("RUN-FICTIONAL-NATIVE-LIMIT", "2026-08-30T12:40:00.000Z", 5);
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let credentialReads = 0;
  let networkCalls = 0;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:41:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: new Proxy({}, { get() { credentialReads += 1; return Array(33).join("x"); } }),
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 202 }); },
  }), /request byte limit/);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("native connector failures retain no rendered content or private target", async () => {
  const privateProfile = {
    ...nativeConnectorProfile(),
    request_policy: {
      ...nativeConnectorProfile().request_policy,
      max_attempts: 1,
      retry_delays_ms: [],
    },
  };
  const { root, profilePath } = await workspace(privateProfile);
  const request = connectorRequest("RUN-FICTIONAL-NATIVE-FAILURE", "2026-08-30T12:50:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let markerPath;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T12:51:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    fetchImpl: async () => new Response("synthetic private provider failure", { status: 503 }),
  }), (error) => {
    markerPath = error.pending_marker;
    return /outcome is unknown/.test(error.message);
  });
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  const serialized = JSON.stringify(marker);
  assert.equal(serialized.includes("C0123456789"), false);
  assert.equal(serialized.includes("Fictional Systems"), false);
  assert.equal(serialized.includes("synthetic private provider failure"), false);
  assert.equal(marker.safety.request_items_included, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("live send requires exact approval, retries deterministically, and is receipt-idempotent", async () => {
  const { root, profilePath } = await workspace();
  const request = connectorRequest("RUN-FICTIONAL-SEND", "2026-08-30T13:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let networkCalls = 0;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T13:01:00.000Z",
    send: true,
    approvalId: "NAPP-000000000000000000000000",
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 204 }); },
  }), /exact notification approval/);
  assert.equal(networkCalls, 0);

  const delays = [];
  const calls = [];
  const delivered = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T13:01:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (endpoint, options) => {
      calls.push({ endpoint, options });
      return calls.length === 1
        ? new Response("retry", { status: 503 })
        : new Response("accepted", { status: 202 });
    },
  });
  assert.equal(delivered.sent, true);
  assert.equal(delivered.network_attempts, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["idempotency-key"], request.request_id);
  assert.equal(calls[1].options.headers["idempotency-key"], request.request_id);
  assert.equal(calls[0].options.body, JSON.stringify(request));
  assert.equal(delivered.receipt.safety.response_body_included, false);
  assert.equal(JSON.stringify(delivered).includes(connectorProfile().endpoint), false);
  assert.equal(JSON.stringify(delivered).includes(Array(33).join("x")), false);

  const repeated = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T13:02:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: {},
    fetchImpl: async () => { networkCalls += 1; return new Response(null, { status: 204 }); },
  });
  assert.equal(repeated.already_delivered, true);
  assert.equal(repeated.network_attempts, 0);
  assert.equal(networkCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("confirmed delivery recovers a sanitized receipt without resending", async () => {
  const { root, profilePath } = await workspace();
  const request = connectorRequest("RUN-FICTIONAL-RECOVERY", "2026-08-30T14:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let markerPath;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T14:01:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    fetchImpl: async () => new Response(null, { status: 204 }),
    beforeReceiptCommit: async () => { throw new Error("Synthetic receipt failure"); },
  }), (error) => {
    markerPath = error.pending_marker;
    return /confirmed/.test(error.message);
  });
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  assert.equal(marker.delivery_state, "confirmed");
  assert.equal(marker.safety.endpoint_included, false);
  assert.equal(JSON.stringify(marker).includes(connectorProfile().endpoint), false);
  let recoveryCalls = 0;
  const recovered = await runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    recoverPath: markerPath,
    now: "2026-08-30T14:02:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: {},
    fetchImpl: async () => { recoveryCalls += 1; return new Response(null, { status: 204 }); },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.network_attempts, 0);
  assert.equal(recoveryCalls, 0);
  await assert.rejects(fs.access(markerPath), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("exhausted retryable responses retain an unknown, redacted recovery state", async () => {
  const { root, profilePath } = await workspace();
  const request = connectorRequest("RUN-FICTIONAL-UNKNOWN", "2026-08-30T15:00:00.000Z");
  const requestPath = await writeRequest(root, request);
  const profilePreview = await runNotificationConnectorProfile({ projectRoot: root, profilePath });
  await runNotificationConnectorProfile({
    projectRoot: root,
    profilePath,
    apply: true,
    approvalId: profilePreview.preview.approval_id,
  });
  let markerPath;
  let calls = 0;
  await assert.rejects(runNotificationConnectorDispatch({
    projectRoot: root,
    requestPath,
    profilePath,
    now: "2026-08-30T15:01:00.000Z",
    send: true,
    approvalId: request.approval_id,
    environment: { SYNTHETIC_CONNECTOR_BEARER: Array(33).join("x") },
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return new Response("private connector response", { status: 503 });
    },
  }), (error) => {
    markerPath = error.pending_marker;
    return error.external_request_attempted === true
      && error.external_delivery_performed === null
      && /outcome is unknown/.test(error.message);
  });
  assert.equal(calls, 2);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  assert.equal(marker.delivery_state, "unknown");
  assert.equal(marker.last_failure.http_status, 503);
  assert.equal(marker.last_failure.retryable, true);
  assert.equal(JSON.stringify(marker).includes("private connector response"), false);
  assert.equal(JSON.stringify(marker).includes(connectorProfile().endpoint), false);
  await fs.rm(root, { recursive: true, force: true });
});
