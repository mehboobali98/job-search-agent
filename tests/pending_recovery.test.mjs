import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyPendingMarker, pendingChecksum, pendingMarkerSummary } from "../scripts/pending_recovery_lib.mjs";
import { inspectPending } from "../scripts/inspect_pending.mjs";

test("pending markers are classified without exposing their payload", () => {
  const raw = { payload: { run_id: "SYNTHETIC-1", candidates: [], scan_events: [] }, error: "Synthetic lock\nprivate stack" };
  assert.equal(classifyPendingMarker("pending-SYNTHETIC-1.json", raw).workflow, "Discovery tracker update");
  const text = JSON.stringify(raw);
  const summary = pendingMarkerSummary({
    filePath: "/tmp/state/pending-SYNTHETIC-1.json", text, raw,
    stat: { mtime: new Date("2026-01-01T00:00:00Z") }, stateDirectory: "/tmp/state", workbookPath: "/tmp/tracker.xlsx",
    now: new Date("2026-02-15T00:00:00Z"), retentionDays: 30, eligibilityRegistryPath: "/tmp/profile/eligibility.json",
  });
  assert.equal(summary.error_summary, "Synthetic lock");
  assert.equal(summary.stale, true);
  assert.equal(summary.recovery.extraction_required, true);
  assert.match(summary.recovery.steps[1], /--eligibility-registry/);
  assert.equal(summary.checksum_sha256, pendingChecksum(text));
  assert.equal(JSON.stringify(summary).includes("candidates"), false);
});

test("sanitized job-alert markers have an explicit apply recovery command", () => {
  const raw = { proposal: { proposal_id: "JAP-SYNTHETIC" }, error: "Synthetic promotion failure" };
  assert.equal(classifyPendingMarker("pending-job-alert-JAP-SYNTHETIC.json", raw).workflow, "Job-alert ingestion");
  const summary = pendingMarkerSummary({
    filePath: "/tmp/state/pending-job-alert-JAP-SYNTHETIC.json",
    text: JSON.stringify(raw), raw, stat: { mtime: new Date("2026-08-30T00:00:00Z") },
    stateDirectory: "/tmp/state", now: new Date("2026-08-30T01:00:00Z"),
  });
  assert.equal(summary.recovery.extraction_required, false);
  assert.match(summary.recovery.steps[0], /--recover/);
  assert.match(summary.recovery.steps[0], /--apply/);
});

test("historical tracker import markers replay atomically with explicit apply", () => {
  const raw = {
    workflow: "historical_tracker_import",
    import_id: "synthetic-history",
    source_path: "/tmp/private-history.xlsx",
    target_path: "/tmp/tracker.xlsx",
    error: "Synthetic promotion failure",
  };
  assert.equal(classifyPendingMarker("pending-history-import-synthetic-history.json", raw).workflow, "Historical tracker import");
  const summary = pendingMarkerSummary({
    filePath: "/tmp/state/pending-history-import-synthetic-history.json",
    text: JSON.stringify(raw), raw, stat: { mtime: new Date("2026-08-30T00:00:00Z") },
    stateDirectory: "/tmp/state", now: new Date("2026-08-30T01:00:00Z"),
  });
  assert.equal(summary.recovery.extraction_required, false);
  assert.match(summary.recovery.steps[0], /import_tracker_history\.mjs/);
  assert.match(summary.recovery.steps[0], /--recover/);
  assert.match(summary.recovery.steps[0], /--apply/);
  assert.equal(JSON.stringify(summary).includes("private-history.xlsx"), false);
});

test("notification markers require exact approved private replay", () => {
  const raw = {
    workflow: "notification_delivery",
    approval_id: "NAPP-AAAAAAAAAAAAAAAAAAAAAAAA",
    requests: [{ request_id: "NREQ-BBBBBBBBBBBBBBBBBBBBBBBB" }],
    error: "Synthetic promotion failure",
  };
  assert.equal(classifyPendingMarker("pending-notification-NAPP-AAAAAAAAAAAAAAAAAAAAAAAA.json", raw).workflow, "Notification delivery");
  const summary = pendingMarkerSummary({
    filePath: "/tmp/state/pending-notification-NAPP-AAAAAAAAAAAAAAAAAAAAAAAA.json",
    text: JSON.stringify(raw), raw, stat: { mtime: new Date("2026-08-30T00:00:00Z") },
    stateDirectory: "/tmp/state", now: new Date("2026-08-30T01:00:00Z"),
  });
  assert.equal(summary.recovery.extraction_required, false);
  assert.match(summary.recovery.steps[0], /deliver_notifications\.mjs/);
  assert.match(summary.recovery.steps[0], /--recover/);
  assert.match(summary.recovery.steps[0], /--apply/);
  assert.match(summary.recovery.steps[0], /--approve/);
  assert.equal(JSON.stringify(summary).includes("requests"), false);
});

test("live connector markers recover with deterministic private paths and explicit send approval", () => {
  const raw = {
    workflow: "notification_connector_dispatch",
    request_id: "NREQ-BBBBBBBBBBBBBBBBBBBBBBBB",
    approval_id: "NAPP-AAAAAAAAAAAAAAAAAAAAAAAA",
    profile_id: "fictional-slack",
    connection_ref: "fictional-workspace",
    binding_id: "NCBIND-CCCCCCCCCCCCCCCCCCCCCCCC",
    error: "Synthetic connector failure",
  };
  assert.equal(classifyPendingMarker("pending-notification-connector-NREQ-BBBBBBBBBBBBBBBBBBBBBBBB.json", raw).workflow, "Notification connector dispatch");
  const summary = pendingMarkerSummary({
    filePath: "/tmp/state/pending-notification-connector-NREQ-BBBBBBBBBBBBBBBBBBBBBBBB.json",
    text: JSON.stringify(raw), raw, stat: { mtime: new Date("2026-08-30T00:00:00Z") },
    stateDirectory: "/tmp/state", now: new Date("2026-08-30T01:00:00Z"),
  });
  assert.match(summary.recovery.steps[0], /dispatch_notifications\.mjs/);
  assert.match(summary.recovery.steps[0], /--send/);
  assert.match(summary.recovery.steps[0], /--approve/);
  assert.match(summary.recovery.steps[0], /fictional-slack\.profile\.json/);
  assert.equal(JSON.stringify(summary).includes("fictional-workspace"), false);
});

test("inspection is read-only by default and extraction is explicit and private", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pending-recovery-"));
  const marker = "pending-SYNTHETIC-2.json";
  const raw = { payload: { run_id: "SYNTHETIC-2", candidates: [], scan_events: [] }, error: "Synthetic lock" };
  await fs.writeFile(path.join(stateDir, marker), JSON.stringify(raw));
  const inspected = await inspectPending({ stateDirectory: stateDir });
  assert.equal(inspected.marker_count, 1);
  assert.equal(inspected.extracted, null);
  const output = path.join(stateDir, "recovery", "payload.json");
  const extracted = await inspectPending({ stateDirectory: stateDir, marker, extractPath: output });
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), raw.payload);
  assert.equal(extracted.destructive_actions_taken, false);
  assert.equal(await fs.readFile(path.join(stateDir, marker), "utf8"), JSON.stringify(raw));
  await fs.rm(stateDir, { recursive: true, force: true });
});
