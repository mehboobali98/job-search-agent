import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { extractHistoricalRecords, runHistoricalTrackerImport } from "../scripts/import_tracker_history.mjs";
import { createFixtureWorkbook, FIXTURE_LEAD_ID, FIXTURE_URL } from "./test_fixture.mjs";

async function hash(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-import-"));
  const target = path.join(root, "Tracker.xlsx");
  const source = path.join(root, "Historical.xlsx");
  const state = path.join(root, "state");
  const mapping = path.join(root, "mapping.json");
  await fs.copyFile(await createFixtureWorkbook(), target);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("History");
  sheet.getRange("A1:H5").values = [
    ["Company", "Role", "Location", "Job URL", "Date Applied", "Status", "Stage", "Notes"],
    ["Atlas Example", "Platform Engineer", "Dubai, UAE", "https://jobs.ashbyhq.com/atlas-example/role-1?utm_source=old", "2026-02-01", "Applied", "Applied", "Synthetic imported note"],
    ["Atlas Example", "Platform Engineer", "Dubai, UAE", "https://jobs.ashbyhq.com/atlas-example/role-1?utm_source=old", "2026-02-01", "Applied", "Applied", "Synthetic imported note"],
    ["Fixture Company", "Senior Backend Engineer", "Worldwide remote", FIXTURE_URL, "2026-03-01", "Screening", "Recruiter Screen", "Synthetic existing-lead application"],
    [null, "Missing company", "Remote", "https://jobs.example.test/malformed", null, "Draft", "Interested", null],
  ];
  await (await SpreadsheetFile.exportXlsx(workbook)).save(source);
  await fs.writeFile(mapping, JSON.stringify({
    schema_version: 1,
    import_id: "synthetic-history-apply",
    imported_at: "2026-08-30T09:00:00Z",
    sheets: [{
      sheet_name: "History",
      record_type: "application",
      header_row: 1,
      columns: {
        company: "Company", title: "Role", location: "Location", canonical_url: "Job URL",
        date_applied: "Date Applied", application_status: "Status", current_stage: "Stage", notes: "Notes",
      },
    }],
  }, null, 2));
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify({
    version: 5,
    candidate_name: "Example Candidate",
    timezone: "Etc/UTC",
    target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx",
    candidate_profile_path: "profile/candidate-profile.md",
    search_terms_path: "profile/search-terms.json",
    eligibility_evidence_path: "profile/eligibility-evidence.json",
    resumes_directory: "profile/resumes",
    state_directory: "state",
    application_packages_directory: "application-packages",
    reliability: { require_preflight: true, pending_retention_days: 30, query_recommendation_window: 20, query_recommendation_min_attempts: 5 },
    gmail_job_alerts: { enabled: false, read_only: true, query: "newer_than:7d", freshness_hours: 168, max_messages: 50, max_links_per_message: 20, sender_allowlist: [] },
  }, null, 2));
  return { root, target, source, state, mapping };
}

test("preview is private and read-only; apply is atomic and idempotent", async () => {
  const paths = await setup();
  const before = await hash(paths.target);
  const preview = await runHistoricalTrackerImport({
    projectRoot: paths.root, sourcePath: paths.source, mappingPath: paths.mapping,
  });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.applied, false);
  assert.equal(preview.diagnostics.leads_to_add, 1);
  assert.equal(preview.diagnostics.applications_to_add, 2);
  assert.equal(preview.diagnostics.classification_counts.duplicate_in_source, 1);
  assert.equal(preview.diagnostics.classification_counts.malformed_row, 1);
  assert.equal(preview.diagnostics.classification_counts.application_linked_to_existing_lead, 1);
  assert.equal(await hash(paths.target), before);
  assert.doesNotMatch(JSON.stringify(preview), /Synthetic imported note|Atlas Example|Platform Engineer/);

  const applied = await runHistoricalTrackerImport({
    projectRoot: paths.root, sourcePath: paths.source, mappingPath: paths.mapping, apply: true,
  });
  assert.equal(applied.applied, true);
  const after = await hash(paths.target);
  assert.notEqual(after, before);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(paths.target));
  const leads = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows().filter((row) => row[0]);
  const applications = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows().filter((row) => row[0]);
  const runs = workbook.worksheets.getItem("Run Log").tables.getItem("RunLogTable").getDataRows().filter((row) => row[0]);
  assert.equal(leads.length, 2);
  assert.equal(applications.length, 2);
  assert.ok(applications.some((row) => row[0] === FIXTURE_LEAD_ID && row[11] === "Screening"));
  assert.ok(runs.some((row) => row[0] === "HIST-synthetic-history-apply"));
  const repeated = await runHistoricalTrackerImport({
    projectRoot: paths.root, sourcePath: paths.source, mappingPath: paths.mapping, apply: true,
  });
  assert.equal(repeated.already_committed, true);
  assert.equal(await hash(paths.target), after);
});

test("forced apply failure preserves the workbook and recovery replays exact inputs", async () => {
  const paths = await setup();
  const before = await hash(paths.target);
  await assert.rejects(runHistoricalTrackerImport({
    projectRoot: paths.root,
    sourcePath: paths.source,
    mappingPath: paths.mapping,
    apply: true,
    beforePromote: async () => { throw new Error("synthetic promotion failure"); },
  }), /synthetic promotion failure/);
  assert.equal(await hash(paths.target), before);
  const markerName = (await fs.readdir(paths.state)).find((name) => name.startsWith("pending-history-import-"));
  assert.ok(markerName);
  const recovered = await runHistoricalTrackerImport({
    projectRoot: paths.root,
    recoverPath: path.join(paths.state, markerName),
    apply: true,
  });
  assert.equal(recovered.applied, true);
  assert.equal((await fs.readdir(paths.state)).some((name) => name.startsWith("pending-history-import-")), false);
  assert.notEqual(await hash(paths.target), before);
});

test("automatic mapping imports a compatible tracker and never modifies the source", async () => {
  const paths = await setup();
  const compatibleSource = await createFixtureWorkbook();
  const sourceBefore = await hash(compatibleSource);
  const result = await runHistoricalTrackerImport({
    projectRoot: paths.root,
    sourcePath: compatibleSource,
  });
  assert.equal(result.mode, "preview");
  assert.equal(result.diagnostics.source_records, 1);
  assert.equal(result.diagnostics.classification_counts.duplicate_lead_in_tracker, 1);
  assert.equal(await hash(compatibleSource), sourceBefore);
});

test("bounded extraction rejects over-wide historical sheets", () => {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("History");
  sheet.getRangeByIndexes(0, 0, 2, 101).values = [
    Array.from({ length: 101 }, (_, index) => index === 0 ? "Company" : index === 1 ? "Role" : `Extra ${index}`),
    Array.from({ length: 101 }, (_, index) => index === 0 ? "Example" : index === 1 ? "Engineer" : null),
  ];
  assert.throws(() => extractHistoricalRecords(workbook, {
    schema_version: 1,
    import_id: "synthetic-wide",
    imported_at: "2026-08-30T09:00:00Z",
    sheets: [{ sheet_name: "History", record_type: "lead", header_row: 1, columns: { company: "Company", title: "Role" } }],
  }), /100-column/);
});

test("concurrent tracker changes are detected and never overwritten", async () => {
  const paths = await setup();
  let concurrentHash = null;
  await assert.rejects(runHistoricalTrackerImport({
    projectRoot: paths.root,
    sourcePath: paths.source,
    mappingPath: paths.mapping,
    apply: true,
    beforePromote: async () => {
      const current = await SpreadsheetFile.importXlsx(await FileBlob.load(paths.target));
      current.worksheets.getItem("Search Config").getRange("F30").values = [["Synthetic concurrent change"]];
      await (await SpreadsheetFile.exportXlsx(current)).save(paths.target);
      concurrentHash = await hash(paths.target);
    },
  }), /Current tracker changed during import/);
  assert.equal(await hash(paths.target), concurrentHash);
  const markerName = (await fs.readdir(paths.state)).find((name) => name.startsWith("pending-history-import-"));
  await assert.rejects(runHistoricalTrackerImport({
    projectRoot: paths.root,
    recoverPath: path.join(paths.state, markerName),
    apply: true,
  }), /Current tracker changed after the failed import/);
  assert.equal(await hash(paths.target), concurrentHash);
});
