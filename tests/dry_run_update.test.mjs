import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dryRunUpdate } from "../scripts/dry_run_update.mjs";
import { createFixtureWorkbook } from "./test_fixture.mjs";

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("dry-run validates an update on an isolated workbook without persistent writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-dry-run-test-"));
  const workbook = path.join(root, "Tracker.xlsx");
  const input = path.join(root, "run.json");
  await fs.copyFile(await createFixtureWorkbook(), workbook);
  const payload = {
    run_id: "DRY-RUN-SYNTHETIC-1",
    started_at: "2026-08-29T08:00:00Z",
    completed_at: "2026-08-29T08:01:00Z",
    status: "Completed",
    agents: { backend_finder: "Completed", ai_product_finder: "Completed", job_judge: "Completed" },
    queries: 0, found: 0, unique: 0, evaluated: 0, judged: 0,
    errors: [], notes: "Synthetic dry-run fixture", scan_events: [], candidates: [],
  };
  await fs.writeFile(input, JSON.stringify(payload));
  const before = await fs.readFile(workbook);
  const result = await dryRunUpdate({ workbookPath: workbook, inputPath: input });
  assert.equal(result.valid, true);
  assert.equal(result.workbook_unchanged, true);
  assert.equal(result.persistent_state_written, false);
  assert.equal(result.proposed_result.run_id, payload.run_id);
  assert.equal(checksum(await fs.readFile(workbook)), checksum(before));
  await assert.rejects(fs.access(path.join(root, "state")), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("dry-run rejects invalid payloads while preserving the source workbook", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-dry-run-invalid-"));
  const workbook = path.join(root, "Tracker.xlsx");
  const input = path.join(root, "run.json");
  await fs.copyFile(await createFixtureWorkbook(), workbook);
  await fs.writeFile(input, "{}\n");
  const before = await fs.readFile(workbook);
  const result = await dryRunUpdate({ workbookPath: workbook, inputPath: input });
  assert.equal(result.valid, false);
  assert.equal(result.workbook_unchanged, true);
  assert.deepEqual(await fs.readFile(workbook), before);
  await fs.rm(root, { recursive: true, force: true });
});
