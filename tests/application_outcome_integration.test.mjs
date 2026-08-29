import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { createFixtureWorkbook, FIXTURE_LEAD_ID } from "./test_fixture.mjs";

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("records a user-confirmed outcome, advances the application, and remains idempotent", async () => {
  const workbookPath = await createFixtureWorkbook();
  const directory = path.dirname(workbookPath);
  const stateDir = path.join(directory, "state");
  assert.equal(run(["scripts/manage_lead.mjs", "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir]).status, 0);
  assert.equal(run(["scripts/manage_lead.mjs", "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "applied", "--applied-at", "2026-08-20", "--state-dir", stateDir]).status, 0);
  const inputPath = path.join(directory, "outcome.json");
  await fs.writeFile(inputPath, JSON.stringify({
    schema_version: 1,
    event_id: "OUT-FIXTURE-SCREEN",
    lead_id: FIXTURE_LEAD_ID,
    occurred_at: "2026-08-29T09:00:00Z",
    outcome: "Screening",
    stage: "Recruiter Screen",
    reason_category: "Recruiter response",
    notes: "Initial recruiter call scheduled.",
    user_confirmed: true,
  }));
  const first = run(["scripts/record_application_outcome.mjs", "--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(first.status, 0, first.stderr);
  const repeated = run(["scripts/record_application_outcome.mjs", "--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Already recorded/);

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const application = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows().find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(application[11], "Screening");
  assert.equal(application[20], "Recruiter Screen");
  const outcomes = workbook.worksheets.getItem("Application Outcomes").tables.getItem("ApplicationOutcomesTable").getDataRows().filter((row) => row[0] === "OUT-FIXTURE-SCREEN");
  assert.equal(outcomes.length, 1);
  const actions = workbook.worksheets.getItem("Action Dashboard").tables.getItem("ActionDashboardTable").getDataRows();
  assert.ok(actions.some((row) => row[2] === "Follow-up" && row[7] === "Open"));

  const calibration = run(["scripts/calibrate_outcomes.mjs", "--workbook", workbookPath]);
  assert.equal(calibration.status, 0, calibration.stderr);
  assert.match(calibration.stdout, /policy_mutation/);
});
