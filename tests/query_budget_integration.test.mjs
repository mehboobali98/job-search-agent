import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { recommendQueryBudget } from "../scripts/query_budget_lib.mjs";
import { readSearchBudget } from "../scripts/search_budget_workbook.mjs";
import { createFixtureWorkbook } from "./test_fixture.mjs";

const currentBudget = {
  "Backend / Platform": 6,
  "Staff / Principal / Tech Lead": 2,
  "Applied AI / LLM": 2,
  "Developer Productivity / AI Enablement": 1,
  "Full-stack / Product": 1,
};

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("query-budget writer requires exact approval and commits one verified transfer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "query-budget-apply-"));
  const workbook = path.join(root, "Tracker.xlsx");
  const recommendationPath = path.join(root, "recommendation.json");
  await fs.copyFile(await createFixtureWorkbook(), workbook);
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    records.push({ query_id: `B-${index}`, role_family: "Backend / Platform", status: "Completed", found: 1, unique: 1, evaluated: 1, reviewable: 1, priority: 1 });
    records.push({ query_id: `S-${index}`, role_family: "Staff / Principal / Tech Lead", status: "Completed", found: 0, unique: 0, evaluated: 0, reviewable: 0, priority: 0 });
  }
  const recommendation = recommendQueryBudget({ records, currentBudget });
  await fs.writeFile(recommendationPath, JSON.stringify(recommendation, null, 2));
  const before = await fs.readFile(workbook);
  const rejected = spawnSync(process.execPath, [
    "scripts/apply_query_budget.mjs", "--workbook", workbook, "--recommendation", recommendationPath,
    "--approve", "QBUD-WRONG", "--state-dir", path.join(root, "rejected-state"),
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.equal(hash(await fs.readFile(workbook)), hash(before));
  await assert.rejects(fs.access(path.join(root, "rejected-state")), /ENOENT/);

  const applied = spawnSync(process.execPath, [
    "scripts/apply_query_budget.mjs", "--workbook", workbook, "--recommendation", recommendationPath,
    "--approve", recommendation.recommendation_id, "--state-dir", path.join(root, "state"),
  ], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(workbook));
  assert.deepEqual(readSearchBudget(verified).role_query_budget, recommendation.proposed_budget);
  await fs.rm(root, { recursive: true, force: true });
});
