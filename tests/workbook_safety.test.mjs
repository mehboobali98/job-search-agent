import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { argumentValue, validateProjectConfig } from "../scripts/project_config.mjs";
import { createTracker } from "../scripts/create_tracker.mjs";
import { resolveXlsxWorkbookPath, workbookInspectionPath, workbookTemporaryPath } from "../scripts/workbook_io.mjs";

test("strict arguments reject a flag without a value", () => {
  assert.throws(() => argumentValue(["node", "script", "--salary"], "--salary"), /requires a value/);
  assert.throws(() => argumentValue(["node", "script", "--salary", "--cover-letter"], "--salary"), /requires a value/);
});

test("local configuration v3 accepts a private eligibility registry path", () => {
  const config = validateProjectConfig({
    version: 3,
    candidate_name: "Example",
    timezone: "Etc/UTC",
    target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx",
    candidate_profile_path: "profile/candidate-profile.md",
    search_terms_path: "profile/search-terms.json",
    eligibility_evidence_path: "profile/eligibility-evidence.json",
    resumes_directory: "profile/resumes",
    state_directory: "state",
  });
  assert.equal(config.eligibility_evidence_path, "profile/eligibility-evidence.json");
  assert.throws(() => validateProjectConfig({ ...config, eligibility_evidence_path: "" }), /must be non-empty/);
});

test("workbook paths require xlsx and always derive a distinct temporary path", () => {
  assert.throws(() => resolveXlsxWorkbookPath("Tracker"), /must end with \.xlsx/);
  const workbook = resolveXlsxWorkbookPath("Tracker.XLSX");
  const temporary = workbookTemporaryPath(workbook, "test");
  assert.notEqual(temporary, workbook);
  assert.match(temporary, /\.test\.xlsx$/);
});

test("every workbook writer rejects a non-xlsx target without changing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-workbook-safety-"));
  const workbook = path.join(directory, "Tracker");
  const state = path.join(directory, "state");
  const input = path.join(directory, "input.json");
  const original = Buffer.from("sentinel workbook bytes");
  await fs.writeFile(workbook, original);
  await fs.writeFile(input, "{}\n");
  const commands = [
    ["scripts/manage_lead.mjs", "--workbook", workbook, "--lead-id", "L-TEST", "--action", "prepare", "--state-dir", state],
    ["scripts/record_form_packet.mjs", "--workbook", workbook, "--lead-id", "L-TEST", "--input", input, "--state-dir", state],
    ["scripts/update_tracker.mjs", "--workbook", workbook, "--input", input, "--state-dir", state],
    ["scripts/recheck_expiry.mjs", "--workbook", workbook, "--input", input, "--state-dir", state],
    ["scripts/migrate_tracker.mjs", "--workbook", workbook, "--state-dir", state],
    ["scripts/monitor_leads.mjs", "--workbook", workbook, "--input", input, "--state-dir", state],
    ["scripts/record_application_outcome.mjs", "--workbook", workbook, "--input", input, "--state-dir", state],
    ["scripts/refresh_actions.mjs", "--workbook", workbook, "--state-dir", state],
    ["scripts/refresh_dashboard.mjs", workbook],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(result.status, 0, args[0] + " must reject the unsafe target");
    assert.match(result.stderr, /must end with \.xlsx/, args[0]);
    assert.deepEqual(await fs.readFile(workbook), original, args[0] + " must preserve the target");
  }
});

test("tracker creation rejects a non-xlsx output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-create-safety-"));
  const output = path.join(directory, "Tracker");
  await assert.rejects(createTracker({
    outputPath: output,
    candidateName: "Example Candidate",
    timezone: "Etc/UTC",
    targetGeography: "Worldwide remote",
  }), /must end with \.xlsx/);
  await assert.rejects(fs.access(output), /ENOENT/);
});

test("dashboard refresh commits through a distinct verified workbook", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-dashboard-refresh-"));
  const workbookPath = path.join(directory, "Tracker.xlsx");
  await createTracker({
    outputPath: workbookPath,
    candidateName: "Example Candidate",
    timezone: "Etc/UTC",
    targetGeography: "Worldwide remote",
  });
  await assert.rejects(fs.access(workbookInspectionPath(workbookPath)), /ENOENT/);
  const stale = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  stale.worksheets.getItem("Search Config").getRange("B28").values = [["Judged | Needs Judge | Failed"]];
  await (await SpreadsheetFile.exportXlsx(stale)).save(workbookPath);
  const result = spawnSync(process.execPath, ["scripts/refresh_dashboard.mjs", workbookPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const dashboard = workbook.worksheets.getItem("Dashboard");
  assert.match(dashboard.getRange("C5:D6").formulas[0][0], /^=COUNTIFS/);
  assert.match(dashboard.getRange("C5:D6").formulas[0][0], /LeadsTable\[Final Score\]/);
  assert.doesNotMatch(dashboard.getRange("C5:D6").formulas[0][0], /\$203/);
  assert.match(dashboard.getRange("H10").formulas[0][0], /LeadsTable\[Canonical URL\]/);
  assert.match(workbook.worksheets.getItem("Search Config").getRange("B28").values[0][0], /Legacy \/ unjudged/);
  await assert.rejects(fs.access(workbookTemporaryPath(workbookPath, "dashboard-tmp")), /ENOENT/);
  await assert.rejects(fs.access(workbookInspectionPath(workbookTemporaryPath(workbookPath, "dashboard-tmp"))), /ENOENT/);
});
