import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { descriptionHash } from "../scripts/job_tracker_lib.mjs";
import { createFixtureWorkbook, FIXTURE_LEAD_ID, FIXTURE_URL } from "./test_fixture.mjs";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourceWorkbook = process.env.TRACKER_FIXTURE ?? await createFixtureWorkbook();

function run(script, args) {
  return spawnSync(process.execPath, [path.join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

function activeCheck() {
  const description = "Own backend systems and lead a broader platform modernization program.";
  return {
    lead_id: FIXTURE_LEAD_ID,
    canonical_url: FIXTURE_URL,
    listing_status: "Active",
    evidence: "Canonical vacancy is active and publishes the captured fields.",
    location: "Lahore, Pakistan",
    work_type: "Remote",
    job_description: description,
    description_hash: descriptionHash(description),
    compensation: { published: true, text: "USD 100,000-120,000" },
    eligibility: "Eligible",
    eligibility_evidence: "The vacancy explicitly includes Pakistan.",
    eligibility_evidence_ids: ["fixture-pakistan-block"],
  };
}

test("monitors material changes and routes fresh registry conflicts into Eligibility Review", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-monitor-change-"));
  const workbookPath = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const inputPath = path.join(tempDir, "monitor.json");
  const registryPath = path.join(tempDir, "eligibility.json");
  await fs.copyFile(sourceWorkbook, workbookPath);
  let result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "shortlist", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    entries: [{
      id: "fixture-pakistan-block",
      topic: "Hiring country",
      applies_to: { companies: ["Fixture Company"], locations: ["Pakistan"] },
      conclusion: "Blocks",
      statement: "The employer policy says this role cannot hire in Pakistan.",
      source_url: "https://policy.example.test/hiring-countries",
      observed_at: "2026-08-01",
      expires_at: "2026-10-01",
      confidence: "High",
      status: "Active"
    }],
  }));
  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-MONITOR-001",
    started_at: "2026-08-29T08:00:00+05:00",
    completed_at: "2026-08-29T08:05:00+05:00",
    notes: "Monitor shortlisted roles.",
    checks: [activeCheck()],
  }));
  result = run("monitor_leads.mjs", [
    "--workbook", workbookPath, "--input", inputPath, "--eligibility-registry", registryPath, "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const firstResult = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.deepEqual(firstResult.outcomes[0].change_types, ["Location", "Description", "Compensation", "Eligibility"]);
  assert.equal(firstResult.reviews[0].outcome, "Added");

  let workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  let leads = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  const lead = leads.find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(lead[5], "Lahore, Pakistan");
  assert.equal(lead[11], "Needs Human Review");
  assert.match(lead[12], /Registry evidence status: Conflict/);
  assert.match(lead[33], /Compensation published/);
  const monitor = workbook.worksheets.getItem("Lead Monitor").tables.getItem("LeadMonitorTable").getDataRows()
    .find((row) => row[1] === FIXTURE_LEAD_ID);
  assert.equal(monitor[11], true);
  assert.equal(monitor[12], "USD 100,000-120,000");
  assert.match(monitor[16], /Location/);
  const review = workbook.worksheets.getItem("Eligibility Review").tables.getItem("EligibilityReviewTable").getDataRows()
    .find((row) => row[1] === FIXTURE_LEAD_ID);
  assert.equal(review[9], "Registry conflict");
  assert.match(review[10], /fixture-pakistan-block/);

  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-MONITOR-002",
    started_at: "2026-08-30T08:00:00+05:00",
    completed_at: "2026-08-30T08:05:00+05:00",
    notes: "Repeat monitor.",
    checks: [activeCheck()],
  }));
  result = run("monitor_leads.mjs", [
    "--workbook", workbookPath, "--input", inputPath, "--eligibility-registry", registryPath, "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const repeated = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(repeated.outcomes[0].changed, false);
  workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  leads = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  assert.equal((String(leads.find((row) => row[0] === FIXTURE_LEAD_ID)[33]).match(/Compensation published/g) ?? []).length, 1);
});

test("an unavailable prepared role stops preparation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-monitor-expiry-"));
  const workbookPath = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const inputPath = path.join(tempDir, "monitor.json");
  await fs.copyFile(sourceWorkbook, workbookPath);
  let result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-MONITOR-EXPIRED",
    started_at: "2026-08-29T08:00:00+05:00",
    completed_at: "2026-08-29T08:05:00+05:00",
    notes: "Monitor prepared roles.",
    checks: [{
      lead_id: FIXTURE_LEAD_ID,
      canonical_url: FIXTURE_URL,
      listing_status: "Expired",
      evidence: "Canonical page says applications are closed.",
    }],
  }));
  result = run("monitor_leads.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const lead = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows()
    .find((row) => row[0] === FIXTURE_LEAD_ID);
  const application = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows()
    .find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(lead[26], "Expired");
  assert.equal(lead[11], "Ineligible");
  assert.equal(application[20], "Not applying");
  assert.match(application[21], /unavailable/i);
});

test("an unavailable role never regresses an application beyond Preparing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-monitor-applied-"));
  const workbookPath = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const inputPath = path.join(tempDir, "monitor.json");
  await fs.copyFile(sourceWorkbook, workbookPath);
  let result = run("manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  let workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const applicationRows = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  const applicationIndex = applicationRows.findIndex((row) => row[0] === FIXTURE_LEAD_ID);
  workbook.worksheets.getItem("Applications").getRange(`U${4 + applicationIndex}`).values = [["Applied"]];
  await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);
  await fs.writeFile(inputPath, JSON.stringify({
    run_id: "TEST-MONITOR-APPLIED",
    started_at: "2026-08-29T08:00:00+05:00",
    completed_at: "2026-08-29T08:05:00+05:00",
    notes: "Monitor later-stage applications.",
    checks: [{
      lead_id: FIXTURE_LEAD_ID,
      canonical_url: FIXTURE_URL,
      listing_status: "Expired",
      evidence: "Canonical page says applications are closed.",
    }],
  }));
  result = run("monitor_leads.mjs", ["--workbook", workbookPath, "--input", inputPath, "--state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const application = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows()
    .find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(application[20], "Applied");
});
