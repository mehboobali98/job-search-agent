import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeNotificationConnectorRequest,
  buildNotificationConnectorReceipt,
  buildSanitizedNotificationConnectorBinding,
  notificationConnectorProfilePreview,
  validateNotificationConnectorProfile,
} from "../scripts/notification_connector_runtime.mjs";
import { renderNotificationConnectorRequest } from "../scripts/notification_connector_renderer.mjs";
import { buildJobDigest, planNotificationDeliveries } from "../scripts/notification_delivery_lib.mjs";

function profile(overrides = {}) {
  return {
    schema_version: 1,
    profile_id: "fictional-slack",
    enabled: false,
    connection_ref: "fictional-workspace",
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_CONNECTOR_BEARER" },
    allowed_destinations: [{ destination_id: "slack-jobs", channel: "slack" }],
    request_policy: {
      timeout_ms: 4_000,
      max_request_bytes: 65_536,
      max_response_bytes: 8_192,
      max_attempts: 3,
      retry_delays_ms: [250, 1_000],
    },
    idempotency: { required: true, header: "Idempotency-Key" },
    ...overrides,
  };
}

function nativeProfile(overrides = {}) {
  return profile({
    schema_version: 2,
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      rendering: { renderer: "slack_blocks_v1", target: "C0123456789" },
    }],
    ...overrides,
  });
}

function connectorRequest() {
  const source = {
    run_id: "RUN-FICTIONAL-CONNECTOR",
    completed_at: "2026-08-30T12:00:00.000Z",
    replay: { replay_hash: "c".repeat(64) },
    alerts: [{
      lead_id: "L-FICTIONAL-CONNECTOR",
      company: "Fictional Systems",
      title: "Platform Engineer",
      final_score: 92,
      canonical_url: "https://jobs.example.test/platform",
      location: "Remote",
      eligibility: "Eligible",
      strengths: ["Synthetic reliability evidence"],
      gaps: ["Synthetic timezone risk"],
      posted_date: "2026-08-29",
      best_resume: "Backend / Platform",
    }],
  };
  const { digest } = buildJobDigest(source, {
    generatedAt: source.completed_at,
    timezone: "Etc/UTC",
    maxItems: 1,
  });
  return planNotificationDeliveries(digest, {
    enabled: true,
    max_items_per_digest: 1,
    quiet_hours: { enabled: false, start: "22:00", end: "08:00" },
    destinations: [{
      id: "slack-jobs",
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

test("private connector profiles produce deterministic sanitized bindings", () => {
  const privateProfile = profile();
  const first = notificationConnectorProfilePreview(privateProfile);
  const second = notificationConnectorProfilePreview(privateProfile);
  assert.deepEqual(first.binding, second.binding);
  assert.match(first.approval_id, /^NCON-[A-F0-9]{24}$/);
  assert.equal(first.enabled, false);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(privateProfile.endpoint), false);
  assert.equal(serialized.includes(privateProfile.authentication.environment_variable), false);
  assert.equal(first.binding.safety.destination_allowlist_required, true);
  assert.equal(first.binding.safety.explicit_send_required, true);
});

test("profile validation enforces HTTPS, fixed idempotency, and bounded deterministic retries", () => {
  assert.throws(() => validateNotificationConnectorProfile(profile({ endpoint: "http://connector.example.test/notifications" })), /HTTPS/);
  assert.throws(() => validateNotificationConnectorProfile(profile({ endpoint: "https://connector.example.test/notifications?auth=private" })), /query/);
  assert.throws(() => validateNotificationConnectorProfile(profile({
    idempotency: { required: false, header: "Idempotency-Key" },
  })), /must require/);
  assert.throws(() => validateNotificationConnectorProfile(profile({
    request_policy: { ...profile().request_policy, max_attempts: 2, retry_delays_ms: [1_000, 2_000] },
  })), /one delay/);
  assert.throws(() => validateNotificationConnectorProfile(profile({
    request_policy: { ...profile().request_policy, retry_delays_ms: [1_000, 500] },
  })), /non-decreasing/);
});

test("version-2 profiles bind native rendering without exporting the private target", () => {
  const privateProfile = nativeProfile();
  const preview = notificationConnectorProfilePreview(privateProfile);
  assert.equal(preview.profile_schema_version, 2);
  assert.equal(preview.allowed_destinations[0].renderer, "slack_blocks_v1");
  assert.equal(preview.allowed_destinations[0].native_target_included, false);
  assert.equal(preview.binding.schema_version, 2);
  assert.equal(preview.binding.allowed_destinations[0].renderer, "slack_blocks_v1");
  assert.match(preview.binding.allowed_destinations[0].target_sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.binding.safety.native_target_included, false);
  assert.equal(JSON.stringify(preview).includes("C0123456789"), false);

  assert.throws(() => validateNotificationConnectorProfile(nativeProfile({
    allowed_destinations: [{
      destination_id: "email-jobs",
      channel: "email",
      rendering: { renderer: "slack_blocks_v1", target: "C0123456789" },
    }],
  })), /Slack destination/);
  assert.throws(() => validateNotificationConnectorProfile(nativeProfile({
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      rendering: { renderer: "adapter_neutral_json_v1", target: "C0123456789" },
    }],
  })), /cannot include a native target/);
});

test("approved bindings authorize only the exact outbox destination tuple", () => {
  const request = connectorRequest();
  const privateProfile = profile();
  const binding = buildSanitizedNotificationConnectorBinding(privateProfile);
  assert.equal(authorizeNotificationConnectorRequest(request, privateProfile, binding).request, request);
  const otherProfile = profile({ allowed_destinations: [{ destination_id: "different-destination", channel: "slack" }] });
  const otherBinding = buildSanitizedNotificationConnectorBinding(otherProfile);
  assert.throws(() => authorizeNotificationConnectorRequest(request, otherProfile, otherBinding), /not allowlisted/);
  assert.throws(() => authorizeNotificationConnectorRequest(request, { ...privateProfile, enabled: true }, binding), /does not match/);
});

test("Slack rendering is deterministic, bounded, and separate from the adapter-neutral request", () => {
  const request = connectorRequest();
  const privateProfile = nativeProfile();
  const binding = buildSanitizedNotificationConnectorBinding(privateProfile);
  const authorization = authorizeNotificationConnectorRequest(request, privateProfile, binding);
  const first = renderNotificationConnectorRequest(request, authorization.destinationPolicy);
  const second = renderNotificationConnectorRequest(request, authorization.destinationPolicy);
  assert.deepEqual(first, second);
  assert.equal(first.renderer, "slack_blocks_v1");
  assert.equal(first.native_rendering, true);
  assert.equal(first.target_included_in_network_payload, true);
  assert.equal(first.body_bytes, Buffer.byteLength(first.body));
  const payload = JSON.parse(first.body);
  assert.equal(payload.channel, "C0123456789");
  assert.match(payload.text, /1 approved role$/);
  assert.equal(payload.blocks[0].type, "header");
  assert.match(payload.blocks[1].text.text, /Fictional Systems/);
  assert.notDeepEqual(payload, request);

  const neutral = renderNotificationConnectorRequest(request);
  assert.equal(neutral.renderer, "adapter_neutral_json_v1");
  assert.equal(neutral.body, JSON.stringify(request));
  assert.equal(neutral.target_included_in_network_payload, false);
});

test("connector receipts are sanitized and retain the stable idempotency key", () => {
  const request = connectorRequest();
  const binding = buildSanitizedNotificationConnectorBinding(profile());
  const receipt = buildNotificationConnectorReceipt({
    request,
    binding,
    deliveredAt: "2026-08-30T12:01:00.000Z",
    httpStatus: 202,
    attempts: 2,
  });
  assert.equal(receipt.idempotency_key, request.request_id);
  assert.equal(receipt.safety.endpoint_included, false);
  assert.equal(receipt.safety.credential_included, false);
  assert.equal(JSON.stringify(receipt).includes("Fictional Systems"), false);
});
