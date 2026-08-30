import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNotificationDelivery } from "../scripts/deliver_notifications.mjs";

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
      max_items_per_digest: 10,
      quiet_hours: { enabled: false, start: "22:00", end: "08:00" },
      destinations: [
        { id: "local", enabled: true, adapter: "private_file", channel: "local", minimum_score: 80, max_items: 10, include_resume: false },
        { id: "slack", enabled: true, adapter: "connector", channel: "slack", connection_ref: "synthetic-jobs", minimum_score: 90, max_items: 5, include_resume: true },
      ],
    },
  };
}

function source(runId, completedAt = "2026-08-30T12:00:00.000Z") {
  return {
    run_id: runId,
    completed_at: completedAt,
    replay: { replay_hash: "b".repeat(64) },
    alerts: [
      {
        lead_id: "L-FICTIONAL-1", company: "Fictional Systems", title: "Staff Backend Engineer", final_score: 94,
        canonical_url: "https://jobs.example.com/staff-backend", location: "Remote", eligibility: "Eligible",
        strengths: ["Platform ownership"], gaps: ["No published compensation"], posted_date: "2026-08-29",
        best_resume: "Staff / Principal / Tech Lead",
      },
    ],
  };
}

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-delivery-"));
  await fs.mkdir(path.join(root, "state", "runs"), { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  return root;
}

test("preview is read-only; exact apply is private, atomic, and idempotent", async () => {
  const root = await createWorkspace();
  const input = path.join(root, "state", "runs", "RUN-SYNTHETIC.result.json");
  await fs.writeFile(input, JSON.stringify(source("RUN-SYNTHETIC"), null, 2) + "\n");
  const before = (await fs.readdir(path.join(root, "state"))).sort();
  const preview = await runNotificationDelivery({ projectRoot: root, inputPath: input });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.persistent_state_written, false);
  assert.equal(preview.external_delivery_performed, false);
  assert.equal(preview.delivery_requests.length, 2);
  assert.deepEqual((await fs.readdir(path.join(root, "state"))).sort(), before);
  await assert.rejects(
    runNotificationDelivery({ projectRoot: root, inputPath: input, apply: true, approvalId: "NAPP-000000000000000000000000" }),
    /exact approval ID/,
  );
  const applied = await runNotificationDelivery({
    projectRoot: root, inputPath: input, apply: true, approvalId: preview.preview.approval_id,
  });
  assert.equal(applied.persistence.persistent_files_written, 2);
  assert.equal(applied.external_delivery_performed, false);
  assert.equal((await fs.readdir(path.join(root, "state", "notifications", "local"))).length, 1);
  assert.equal((await fs.readdir(path.join(root, "state", "notifications", "outbox"))).length, 1);
  const repeated = await runNotificationDelivery({
    projectRoot: root, inputPath: input, apply: true, approvalId: preview.preview.approval_id,
  });
  assert.equal(repeated.persistence.already_applied, true);
  assert.equal(repeated.persistence.persistent_files_written, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("failed promotion preserves requests for exact private recovery", async () => {
  const root = await createWorkspace();
  const input = path.join(root, "state", "runs", "RUN-FAILURE.result.json");
  await fs.writeFile(input, JSON.stringify(source("RUN-FAILURE", "2026-08-30T13:00:00.000Z"), null, 2) + "\n");
  const preview = await runNotificationDelivery({ projectRoot: root, inputPath: input });
  let marker;
  await assert.rejects(
    runNotificationDelivery({
      projectRoot: root,
      inputPath: input,
      apply: true,
      approvalId: preview.preview.approval_id,
      beforeCommit: async () => { throw new Error("Synthetic promotion failure at " + ["", "Users", "private", "workspace"].join("/")); },
    }),
    (error) => { marker = error.pending_marker; return /Synthetic promotion failure/.test(error.message); },
  );
  assert.equal((await fs.readdir(path.join(root, "state", "notifications", "local"))).length, 0);
  assert.equal((await fs.readdir(path.join(root, "state", "notifications", "outbox"))).length, 0);
  const markerText = await fs.readFile(marker, "utf8");
  assert.equal(markerText.includes(["", "Users", "private"].join("/")), false);
  const recovered = await runNotificationDelivery({
    projectRoot: root,
    recoverPath: marker,
    apply: true,
    approvalId: preview.preview.approval_id,
  });
  assert.equal(recovered.recovery.recovered, true);
  assert.equal(recovered.recovery.persistent_files_written, 2);
  await assert.rejects(fs.access(marker), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("disabled notifications still provide a read-only digest preview", async () => {
  const root = await createWorkspace();
  const configPath = path.join(root, ".job-search.local.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.notifications.enabled = false;
  config.notifications.destinations = [];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const input = path.join(root, "state", "runs", "RUN-DISABLED.result.json");
  await fs.writeFile(input, JSON.stringify(source("RUN-DISABLED"), null, 2) + "\n");
  const preview = await runNotificationDelivery({ projectRoot: root, inputPath: input });
  assert.equal(preview.enabled, false);
  assert.equal(preview.digest.items.length, 1);
  assert.equal(preview.delivery_requests.length, 0);
  assert.equal(preview.preview.classifications.some((item) => item.code === "notifications_disabled"), true);
  await assert.rejects(
    runNotificationDelivery({ projectRoot: root, inputPath: input, apply: true, approvalId: "NAPP-000000000000000000000000" }),
    /disabled/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
