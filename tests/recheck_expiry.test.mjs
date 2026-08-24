import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { createFixtureWorkbook, FIXTURE_LEAD_ID, FIXTURE_URL } from "./test_fixture.mjs";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourceWorkbook = process.env.TRACKER_FIXTURE ?? await createFixtureWorkbook();

function run(script, args) {
  return spawnSync(process.execPath, [path.join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("Friday expiry recheck expires a moved lead and stops preparation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-expiry-"));
  const workbookPath = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const inputPath = path.join(tempDir, "recheck.json");
  await fs.copyFile(sourceWorkbook, workbookPath);

  let result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);

  let preparedWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const preparedRows = preparedWorkbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  const preparedIndex = preparedRows.findIndex((row) => row[0] === FIXTURE_LEAD_ID);
  const preparedApplication = preparedRows[preparedIndex];
  assert.equal(preparedApplication[6], "Backend / Platform");
  assert.match(preparedApplication[16], /Use the Backend \/ Platform resume/);
  assert.match(preparedApplication[21], /Tailor the Backend \/ Platform resume/);
  const preparedRowNumber = 4 + preparedIndex;
  const styleInspection = await preparedWorkbook.inspect({
    kind: "computedStyle",
    sheetId: "Applications",
    range: "A" + preparedRowNumber,
    maxChars: 4000,
  });
  const preparedStyle = JSON.parse(styleInspection.ndjson.trim()).style;
  assert.equal(preparedStyle.font.typeface, "Arial");
  assert.equal(preparedStyle.font.fontSize, 9);
  assert.equal(preparedStyle.wrapText, true);
  assert.equal(preparedStyle.border.bottom.style, "thin");
  preparedWorkbook.worksheets.getItem("Applications").getRange("V" + (4 + preparedIndex)).values = [["Custom manual review note"]];
  const leadRows = preparedWorkbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  const leadIndex = leadRows.findIndex((row) => row[0] === FIXTURE_LEAD_ID);
  preparedWorkbook.worksheets.getItem("Leads").getRange("AI" + (4 + leadIndex)).values = [["Custom lead next action"]];
  await (await SpreadsheetFile.exportXlsx(preparedWorkbook)).save(workbookPath);
  result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"application_changed": false/);
  preparedWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const idempotentRows = preparedWorkbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  assert.equal(idempotentRows.find((row) => row[0] === FIXTURE_LEAD_ID)[21], "Custom manual review note");
  const idempotentLeads = preparedWorkbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  assert.equal(idempotentLeads.find((row) => row[0] === FIXTURE_LEAD_ID)[34], "Custom lead next action");

  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-RECHECK-001",
    started_at: "2026-08-28T08:00:00+05:00",
    completed_at: "2026-08-28T08:30:00+05:00",
    notes: "Friday active-lead expiry recheck.",
    checks: [{
      lead_id: FIXTURE_LEAD_ID,
      result: "Expired",
      canonical_url: FIXTURE_URL,
      evidence: "Canonical listing reports that the job is no longer accepting applications.",
    }],
  }));
  result = run("recheck_expiry.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  result = run("recheck_expiry.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"already_committed": true/);

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const leads = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  const applications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  const scans = workbook.worksheets.getItem("Scan Log").tables.getItem("ScanLogTable").getDataRows();
  const runs = workbook.worksheets.getItem("Run Log").tables.getItem("RunLogTable").getDataRows();
  assert.equal(leads.find((row) => row[0] === FIXTURE_LEAD_ID)[26], "Expired");
  const application = applications.find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(application[20], "Not applying");
  assert.match(application[21], /expired/i);
  assert.equal(scans.find((row) => row[0] === "TEST-RECHECK-001")[6], "Expired");
  assert.equal(scans.filter((row) => row[0] === "TEST-RECHECK-001").length, 1);
  assert.equal(runs.find((row) => row[0] === "TEST-RECHECK-001")[3], "Completed");
  assert.equal(runs.filter((row) => row[0] === "TEST-RECHECK-001").length, 1);
});

test("Friday expiry recheck requires source evidence and never regresses an applied application", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-expiry-guard-"));
  const workbookPath = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const inputPath = path.join(tempDir, "recheck.json");
  await fs.copyFile(sourceWorkbook, workbookPath);

  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-RECHECK-NO-EVIDENCE",
    started_at: "2026-08-28T08:00:00+05:00",
    completed_at: "2026-08-28T08:05:00+05:00",
    notes: "Evidence guard test.",
    checks: [{ lead_id: FIXTURE_LEAD_ID, result: "Expired", canonical_url: FIXTURE_URL }],
  }));
  let result = run("recheck_expiry.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.notEqual(result.status, 0);

  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-RECHECK-WRONG-URL",
    started_at: "2026-08-28T08:00:00+05:00",
    completed_at: "2026-08-28T08:05:00+05:00",
    notes: "URL binding guard test.",
    checks: [{
      lead_id: FIXTURE_LEAD_ID, result: "Expired", canonical_url: "https://example.test/different-job",
      evidence: "This different listing is closed.",
    }],
  }));
  result = run("recheck_expiry.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.notEqual(result.status, 0, "evidence for another URL must not expire the lead");

  result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  let workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const beforeApplications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  const preparedIndex = beforeApplications.findIndex((row) => row[0] === FIXTURE_LEAD_ID);
  workbook.worksheets.getItem("Applications").getRange("U" + (4 + preparedIndex)).values = [["Applied"]];
  await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);

  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-RECHECK-APPLIED",
    started_at: "2026-08-28T08:00:00+05:00",
    completed_at: "2026-08-28T08:30:00+05:00",
    notes: "Applied-stage regression guard.",
    checks: [{
      lead_id: FIXTURE_LEAD_ID, result: "Expired", canonical_url: FIXTURE_URL,
      evidence: "Canonical listing reports that the job is closed.",
    }],
  }));
  result = run("recheck_expiry.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const applications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  assert.equal(applications.find((row) => row[0] === FIXTURE_LEAD_ID)[20], "Applied", "expiry must not regress an application beyond Preparing");
});
