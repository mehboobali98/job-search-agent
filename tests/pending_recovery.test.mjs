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
