import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { createFixtureWorkbook, FIXTURE_LEAD_ID } from "./test_fixture.mjs";

function action(workbook, stateDir, name, extra = []) {
  return spawnSync(process.execPath, [
    "scripts/manage_lead.mjs", "--workbook", workbook, "--lead-id", FIXTURE_LEAD_ID,
    "--action", name, "--state-dir", stateDir, ...extra,
  ], { encoding: "utf8" });
}

function trailingJson(output) {
  const match = String(output).match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error("Script did not return a JSON result: " + output);
  return JSON.parse(match[0]);
}

test("applied records submission details and is non-destructive when repeated", async () => {
  const workbookPath = await createFixtureWorkbook();
  const stateDir = path.join(path.dirname(workbookPath), "state");
  assert.equal(action(workbookPath, stateDir, "prepare").status, 0);
  const first = action(workbookPath, stateDir, "applied", [
    "--applied-at", "2026-01-05", "--salary", "USD 4,000/month, negotiable", "--cover-letter", "Not requested",
  ]);
  assert.equal(first.status, 0, first.stderr);
  let workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  let applications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  let row = applications.find((item) => item[0] === FIXTURE_LEAD_ID);
  assert.equal(row[11], "Applied");
  assert.equal(row[20], "Applied");
  assert.equal(row[10], "USD 4,000/month, negotiable");
  assert.equal(row[17], "Not requested");
  assert.equal(Number(row[12]) - Number(row[1]), 7);
  assert.match(row[13], /Application submitted 2026-01-05/);

  const rowNumber = 4 + applications.findIndex((item) => item[0] === FIXTURE_LEAD_ID);
  workbook.worksheets.getItem("Applications").getRange("V" + rowNumber).values = [["Custom follow-up plan"]];
  await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);
  const before = await fs.readFile(workbookPath);
  const repeated = action(workbookPath, stateDir, "applied");
  assert.equal(repeated.status, 0, repeated.stderr);
  workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  applications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  row = applications.find((item) => item[0] === FIXTURE_LEAD_ID);
  assert.equal(row[21], "Custom follow-up plan");
  assert.equal(trailingJson(repeated.stdout).application_changed, false);
  assert.ok((await fs.readFile(workbookPath)).length >= before.length * 0.9, "repeated action must preserve workbook content");
});

test("applied requires a prepared application and preserves the workbook on failure", async () => {
  const workbookPath = await createFixtureWorkbook();
  const stateDir = path.join(path.dirname(workbookPath), "state");
  const before = await fs.readFile(workbookPath);
  const result = action(workbookPath, stateDir, "applied", ["--applied-at", "2026-01-05"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run prepare first/);
  assert.deepEqual(await fs.readFile(workbookPath), before);
});
