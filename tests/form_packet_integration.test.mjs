import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { createFixtureWorkbook, FIXTURE_LEAD_ID, FIXTURE_URL } from "./test_fixture.mjs";

function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function trailingJson(output) {
  const match = String(output).match(/\{[\s\S]*\}\s*$/);
  if (!match) throw new Error("Script did not return a JSON result: " + output);
  return JSON.parse(match[0]);
}

function packet() {
  return {
    schema_version: 1,
    form: {
      agent: "application_form_agent",
      status: "Completed",
      form_id: "FORM-20260101-FIXTURE-STEP1",
      lead_id: FIXTURE_LEAD_ID,
      captured_at: "2026-01-01T10:00:00Z",
      canonical_job_url: FIXTURE_URL,
      form_url: "https://apply.example.test/fixture-role",
      ats: "Example ATS",
      page_scope: "Current Step",
      step: { index: 1, total: 2, title: "Experience" },
      fields: [{
        field_id: "ownership",
        label: "Describe your backend ownership",
        input_type: "textarea",
        required: true,
        required_evidence: "required attribute",
        classification: "experience",
        options: [],
        character_limit: 500,
        proposed_status: "Ready",
        proposed_response: "I have owned production backend services.\n\nI have also improved their reliability.",
        evidence_ids: ["E-BE-01"],
        confidence: "High",
        user_confirmed: false,
        notes: null,
      }],
      cover_letter: {
        detected: false,
        field_id: null,
        label: null,
        requirement: "Absent",
        requirement_evidence: "No cover-letter field is present",
        input_type: "none",
        accepted_types: [],
        proposed_status: "Not Drafted",
        proposed_text: null,
        evidence_ids: [],
        notes: null,
      },
      submission_control: { detected: false, label: null, interacted: false },
      notes: null,
    },
    review: {
      agent: "job_judge",
      status: "Completed",
      reviewed_at: "2026-01-01T10:05:00Z",
      fields: [{
        field_id: "ownership",
        decision: "Accepted",
        final_response: "I have owned production backend services.\n\nI have also improved their reliability.",
        supported_evidence_ids: ["E-BE-01"],
        unsupported_evidence: false,
        unsupported_details: null,
        notes: null,
      }],
      cover_letter: {
        decision: "Not Applicable",
        final_text: null,
        supported_evidence_ids: [],
        unsupported_evidence: false,
        unsupported_details: null,
        document_path: null,
        notes: null,
      },
      notes: null,
    },
  };
}

test("records a reviewed form packet without changing the application stage", async () => {
  const workbookPath = await createFixtureWorkbook();
  const root = path.dirname(workbookPath);
  const stateDir = path.join(root, "state");
  const packagesDir = path.join(root, "application-packages");
  const inputPath = path.join(root, "form.json");
  const prepare = runScript("scripts/manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(prepare.status, 0, prepare.stderr);
  await fs.writeFile(inputPath, JSON.stringify(packet(), null, 2));
  const first = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath,
    "--state-dir", stateDir, "--packages-dir", packagesDir,
  ]);
  assert.equal(first.status, 0, first.stderr);
  const result = trailingJson(first.stdout);
  assert.equal(result.ready, 1);
  assert.equal(result.cover_letter_status, "Not present");

  let workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  let formRows = workbook.worksheets.getItem("Form Runs").tables.getItem("FormRunsTable").getDataRows();
  assert.equal(formRows.filter((row) => row[0] === packet().form.form_id).length, 1);
  const application = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows()
    .find((row) => row[0] === FIXTURE_LEAD_ID);
  assert.equal(application[17], "Not present");
  assert.equal(application[20], "Preparing");
  assert.match(application[21], /\[Form packet\]/);
  const responsePacket = await fs.readFile(result.response_packet, "utf8");
  assert.match(responsePacket, /Ready to paste/);
  assert.match(responsePacket, /production backend services\.\n\nI have also improved/);

  const repeated = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath,
    "--state-dir", stateDir, "--packages-dir", packagesDir,
  ]);
  assert.equal(repeated.status, 0, repeated.stderr);
  workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  formRows = workbook.worksheets.getItem("Form Runs").tables.getItem("FormRunsTable").getDataRows();
  assert.equal(formRows.filter((row) => row[0] === packet().form.form_id).length, 1, "repeated form IDs must update instead of duplicate");
});

test("rejects a form packet for the wrong canonical job", async () => {
  const workbookPath = await createFixtureWorkbook();
  const root = path.dirname(workbookPath);
  const stateDir = path.join(root, "state");
  const inputPath = path.join(root, "wrong-form.json");
  const prepare = runScript("scripts/manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]);
  assert.equal(prepare.status, 0, prepare.stderr);
  const wrong = packet();
  wrong.form.canonical_job_url = "https://jobs.example.test/a-different-role";
  await fs.writeFile(inputPath, JSON.stringify(wrong, null, 2));
  const result = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath, "--state-dir", stateDir,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match Applications\.Job Posting URL/);
});

test("successful recording clears an earlier lead-only pending marker", async () => {
  const workbookPath = await createFixtureWorkbook();
  const root = path.dirname(workbookPath);
  const stateDir = path.join(root, "state");
  const inputPath = path.join(root, "form.json");
  assert.equal(runScript("scripts/manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]).status, 0);

  await fs.writeFile(inputPath, "{}\n");
  const rejected = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath, "--state-dir", stateDir,
  ]);
  assert.notEqual(rejected.status, 0);
  const leadOnlyPending = path.join(stateDir, `pending-form-${FIXTURE_LEAD_ID}.json`);
  await fs.access(leadOnlyPending);

  await fs.writeFile(inputPath, JSON.stringify(packet(), null, 2));
  const recorded = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath, "--state-dir", stateDir,
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  await assert.rejects(fs.access(leadOnlyPending), /ENOENT/);
});

test("required cover-letter files are scoped to the requested lead", async () => {
  const workbookPath = await createFixtureWorkbook();
  const root = path.dirname(workbookPath);
  const stateDir = path.join(root, "state");
  const packagesDir = path.join(root, "application-packages");
  const otherLeadDirectory = path.join(packagesDir, "OTHER-LEAD");
  const inputPath = path.join(root, "form.json");
  await fs.mkdir(otherLeadDirectory, { recursive: true });
  await fs.writeFile(path.join(otherLeadDirectory, "cover.pdf"), "not a real PDF; access scope is the invariant");
  assert.equal(runScript("scripts/manage_lead.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--action", "prepare", "--state-dir", stateDir,
  ]).status, 0);

  const required = packet();
  required.form.cover_letter = {
    detected: true,
    field_id: "cover_letter",
    label: "Cover letter",
    requirement: "Required",
    requirement_evidence: "required attribute",
    input_type: "file",
    accepted_types: [".pdf"],
    proposed_status: "Ready",
    proposed_text: "Required letter text.",
    evidence_ids: ["E-BE-01"],
    notes: null,
  };
  required.review.cover_letter = {
    decision: "Accepted",
    final_text: "Required letter text.",
    supported_evidence_ids: ["E-BE-01"],
    unsupported_evidence: false,
    unsupported_details: null,
    document_path: "OTHER-LEAD/cover.pdf",
    notes: null,
  };
  await fs.writeFile(inputPath, JSON.stringify(required, null, 2));
  const result = runScript("scripts/record_form_packet.mjs", [
    "--workbook", workbookPath, "--lead-id", FIXTURE_LEAD_ID, "--input", inputPath,
    "--state-dir", stateDir, "--packages-dir", packagesDir,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
});
