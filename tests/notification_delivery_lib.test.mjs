import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNotificationSafe,
  buildJobDigest,
  isInsideQuietHours,
  notificationNotBefore,
  planNotificationDeliveries,
} from "../scripts/notification_delivery_lib.mjs";
import { buildNotificationConnectorPlan } from "../scripts/notification_connector_contract.mjs";

const source = {
  run_id: "RUN-SYNTHETIC-NOTIFY-1",
  completed_at: "2026-08-30T23:30:00.000Z",
  replay: { replay_hash: "a".repeat(64) },
  alerts: [
    {
      lead_id: "L-EXAMPLE-002", company: "Example Robotics", title: "Principal Platform Engineer", final_score: 91,
      canonical_url: "https://jobs.example.com/roles/002?utm_source=fixture&token=private-value", location: "Remote",
      eligibility: "Eligible", strengths: ["Distributed systems"], gaps: ["Timezone overlap"], posted_date: "2026-08-29",
      best_resume: "Staff / Principal / Tech Lead",
    },
    {
      lead_id: "L-EXAMPLE-001", company: "Fictional Labs", title: "Backend Engineer", final_score: 84,
      canonical_url: "https://careers.example.org/jobs/001", location: "London",
      eligibility: "Unclear", strengths: ["API design"], gaps: ["Relocation evidence"], posted_date: "2026-08-28",
      best_resume: "Backend / Platform",
    },
    {
      lead_id: "L-EXAMPLE-003", company: "Sample Systems", title: "AI Enablement Engineer", final_score: 78,
      canonical_url: "https://jobs.example.net/openings/003", location: "Hybrid",
      eligibility: "Eligible", strengths: ["Developer tooling"], gaps: [], posted_date: null,
      best_resume: "Developer Productivity / AI Enablement",
    },
  ],
};

const notifications = {
  enabled: true,
  max_items_per_digest: 3,
  quiet_hours: { enabled: true, start: "22:00", end: "08:00" },
  destinations: [
    {
      id: "local-review", enabled: true, adapter: "private_file", channel: "local", minimum_score: 80,
      max_items: 2, include_resume: false,
    },
    {
      id: "slack-jobs", enabled: true, adapter: "connector", channel: "slack", connection_ref: "workspace-jobs",
      minimum_score: 90, max_items: 1, include_resume: true,
    },
  ],
};

test("builds a deterministic privacy-minimized digest from updater alerts", () => {
  const first = buildJobDigest(source, { generatedAt: source.completed_at, timezone: "Etc/UTC", maxItems: 2 });
  const second = buildJobDigest(source, { generatedAt: source.completed_at, timezone: "Etc/UTC", maxItems: 2 });
  assert.equal(first.digest.digest_id, second.digest.digest_id);
  assert.deepEqual(first.digest.items.map((item) => item.lead_id), ["L-EXAMPLE-002", "L-EXAMPLE-001"]);
  assert.equal(first.omitted_count, 1);
  assert.equal(first.digest.items[0].canonical_url.includes("token"), false);
  assert.equal(first.digest.items[0].canonical_url.includes("utm_"), false);
  assert.equal(JSON.stringify(first.digest).includes("private-value"), false);
  assert.equal(first.digest.privacy.candidate_identity_included, false);
});

test("applies per-destination score, item, resume, and quiet-hour policy", () => {
  const { digest } = buildJobDigest(source, { generatedAt: source.completed_at, timezone: "Etc/UTC", maxItems: 3 });
  const plan = planNotificationDeliveries(digest, notifications);
  assert.match(plan.approval_id, /^NAPP-[A-F0-9]{24}$/);
  assert.equal(plan.requests.length, 2);
  const local = plan.requests.find((request) => request.destination.id === "local-review");
  const connector = plan.requests.find((request) => request.destination.id === "slack-jobs");
  assert.equal(local.items.length, 2);
  assert.equal(local.items.every((item) => item.best_resume === null), true);
  assert.equal(connector.items.length, 1);
  assert.equal(connector.items[0].best_resume, "Staff / Principal / Tech Lead");
  assert.equal(local.policy.deferred, true);
  assert.equal(local.not_before, "2026-08-31T08:00:00.000Z");
  assert.equal(plan.classifications.some((item) => item.code === "quiet_hours_deferred"), true);
  assert.equal(plan.classifications.some((item) => item.code === "connector_required"), true);
});

test("handles cross-midnight and daytime quiet windows deterministically", () => {
  const overnight = { enabled: true, start: "22:00", end: "08:00" };
  assert.equal(isInsideQuietHours("2026-08-30T23:00:00Z", "Etc/UTC", overnight), true);
  assert.equal(isInsideQuietHours("2026-08-30T12:00:00Z", "Etc/UTC", overnight), false);
  assert.equal(notificationNotBefore("2026-08-30T23:58:00Z", "Etc/UTC", overnight), "2026-08-31T08:00:00.000Z");
  const daytime = { enabled: true, start: "12:00", end: "13:30" };
  assert.equal(notificationNotBefore("2026-08-30T12:45:00Z", "Etc/UTC", daytime), "2026-08-30T13:30:00.000Z");
});

test("connector boundary requires exact approval and never invokes a connector", () => {
  const { digest } = buildJobDigest(source, { generatedAt: source.completed_at, timezone: "Etc/UTC", maxItems: 3 });
  const plan = planNotificationDeliveries(digest, notifications);
  const request = plan.requests.find((item) => item.destination.adapter === "connector");
  assert.throws(() => buildNotificationConnectorPlan(request, { approvalId: "NAPP-000000000000000000000000" }), /exact notification approval/);
  const deferred = buildNotificationConnectorPlan(request, { approvalId: plan.approval_id, now: "2026-08-30T23:31:00Z" });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.connector_invoked, false);
  assert.equal(deferred.application_submission_allowed, false);
  const ready = buildNotificationConnectorPlan(request, { approvalId: plan.approval_id, now: request.not_before });
  assert.equal(ready.status, "ready");
  assert.equal(ready.requires_explicit_send_flag, true);
  assert.equal(ready.authenticated_private_profile_required, true);
  assert.equal(ready.destination_allowlist_required, true);
  assert.equal(ready.idempotency_key, request.request_id);
});

test("notification contracts reject private addresses, paths, and credential keys", () => {
  const privateAddress = ["person", "private.example.biz"].join("@");
  const privatePath = ["", "Users", "private", "profile", "resume.pdf"].join("/");
  const credentialKey = ["to", "ken"].join("");
  assert.throws(() => assertNotificationSafe({ recipient: privateAddress }), /email address/);
  assert.throws(() => assertNotificationSafe({ note: privatePath }), /private home path/);
  assert.throws(() => assertNotificationSafe({ [credentialKey]: "synthetic-value" }), /forbidden/);
});
