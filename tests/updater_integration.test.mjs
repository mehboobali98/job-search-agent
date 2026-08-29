import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { candidateIdentityKeys, descriptionHash } from "../scripts/job_tracker_lib.mjs";
import { workbookInspectionPath, workbookTemporaryPath } from "../scripts/workbook_io.mjs";
import { createFixtureWorkbook } from "./test_fixture.mjs";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const nodeBinary = process.execPath;
const sourceWorkbook = process.env.TRACKER_FIXTURE ?? await createFixtureWorkbook();

const baseScores = {
  responsibilities: 23,
  technical: 18,
  seniority: 13,
  evidence: 13,
  domain: 8,
  location: 9,
  compensation: 3,
};

function candidate(overrides = {}) {
  const value = {
    finder: "backend_finder",
    company: "Global Example",
    title: "Senior Backend Engineer",
    location: "Worldwide remote",
    work_type: "Remote",
    source: "Employer careers",
    canonical_url: "https://jobs.example.test/backend-1",
    job_id: "BE-1",
    posted_date: "2026-08-24",
    job_description: "Build reliable backend services for a global product.",
    eligibility: "Eligible",
    finder_eligibility: "Eligible",
    judge_eligibility: "Eligible",
    eligibility_evidence: "Worldwide remote is explicitly stated.",
    finder_eligibility_evidence: "Worldwide remote is explicitly stated.",
    judge_eligibility_evidence: "Worldwide remote is explicitly stated.",
    confidence: "High",
    listing_status: "Active",
    best_resume: "Backend / Platform",
    scores: baseScores,
    strengths: ["Verified backend ownership", "Ruby and PostgreSQL fit"],
    gaps: ["Compensation is unpublished"],
    unsupported_evidence: false,
    judge_status: "Judged",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "description_hash")) {
    value.description_hash = descriptionHash(value.job_description ?? value.description ?? "");
  }
  if (value.scores) value.final_score = Object.values(value.scores).reduce((sum, score) => sum + score, 0);
  return value;
}

function runPayload(overrides = {}) {
  const candidates = overrides.candidates ?? [];
  const scanEvents = overrides.scan_events ?? [];
  const seen = new Set();
  const judgedSeen = new Set();
  let uniqueCandidates = 0;
  let judgedCandidates = 0;
  for (const item of candidates) {
    const keys = candidateIdentityKeys(item);
    if (!keys.some((key) => seen.has(key))) uniqueCandidates += 1;
    for (const key of keys) seen.add(key);
    if (item.judge_status === "Judged" && !keys.some((key) => judgedSeen.has(key))) judgedCandidates += 1;
    if (item.judge_status === "Judged") for (const key of keys) judgedSeen.add(key);
  }
  return {
    run_id: "TEST-RUN-001",
    started_at: "2026-08-24T08:00:00+05:00",
    completed_at: "2026-08-24T08:05:00+05:00",
    status: "Completed",
    agents: { backend_finder: "Completed", ai_product_finder: "Completed", job_judge: "Completed" },
    queries: 0,
    found: candidates.length + scanEvents.length,
    unique: uniqueCandidates + scanEvents.filter((item) => item.counts_toward_unique === true).length,
    evaluated: uniqueCandidates + scanEvents.filter((item) => item.deep_evaluated === true).length,
    judged: judgedCandidates,
    errors: [],
    notes: "",
    scan_events: scanEvents,
    candidates,
    ...overrides,
  };
}

function runUpdater(workbook, stateDir, payloadPath) {
  return spawnSync(nodeBinary, [
    path.join(projectRoot, "scripts/update_tracker.mjs"),
    "--workbook", workbook,
    "--input", payloadPath,
    "--state-dir", stateDir,
  ], { cwd: projectRoot, encoding: "utf8" });
}

async function workbookRows(workbookPath, sheetName, tableName) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  return workbook.worksheets.getItem(sheetName).tables.getItem(tableName).getDataRows();
}

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

test("mixed run enforces judging, eligibility, dedupe, partial coverage, and alert rules", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-mixed-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);

  const payload = runPayload({
    run_id: "TEST-MIXED-001",
    started_at: "2026-08-24T08:00:00+05:00",
    completed_at: "2026-08-24T08:10:00+05:00",
    status: "Partial",
    agents: { backend_finder: "Failed", ai_product_finder: "Completed", job_judge: "Completed" },
    queries: 8,
    errors: ["Backend finder failed after partial results"],
    scan_events: [{
      finder: "ai_product_finder",
      examined_at: "2026-08-24T08:07:00+05:00",
      company: "Duplicate Example",
      title: "Backend Engineer",
      canonical_url: "https://aggregator.example.test/job-9",
      source: "Public aggregator",
      counts_toward_unique: false,
      deep_evaluated: false,
      outcome: "Duplicate",
      reason: "Canonical employer copy was retained.",
      destination: "Scan Log",
    }],
    candidates: [
      candidate({
        notes: "Canonical vacancy verified.",
        interview_process_signal: "Listed by Hiring Without Whiteboards; verify the current interview process",
      }),
      candidate({
        canonical_url: "https://jobs.example.test/backend-1?utm_source=linkedin",
        job_id: null,
        notes: "Canonical vacancy verified.",
        interview_process_signal: "Listed by Hiring Without Whiteboards; verify the current interview process",
      }),
      candidate({
        company: "Blocked Example", title: "Platform Lead", canonical_url: "https://jobs.example.test/blocked",
        job_id: "BLOCK-1", eligibility: "Ineligible", finder_eligibility: "Ineligible", judge_eligibility: "Ineligible",
        eligibility_evidence: "Applicants must already reside in the United States.",
        finder_eligibility_evidence: "Applicants must already reside in the United States.",
        judge_eligibility_evidence: "Applicants must already reside in the United States.",
        scores: { ...baseScores, location: 2 },
      }),
      candidate({
        company: "Unclear Example", title: "Staff Engineer", canonical_url: "https://jobs.example.test/unclear",
        job_id: "UNCLEAR-1", eligibility: "Unclear", finder_eligibility: "Unclear", judge_eligibility: "Unclear",
        eligibility_evidence: "Remote is stated but sponsorship is not addressed.",
        finder_eligibility_evidence: "Remote is stated but sponsorship is not addressed.",
        judge_eligibility_evidence: "Remote is stated but sponsorship is not addressed.",
        confidence: "Medium", scores: { ...baseScores, responsibilities: 22, domain: 6, location: 6 },
      }),
      candidate({
        company: "Evidence Example", title: "AI Backend Engineer", canonical_url: "https://jobs.example.test/evidence",
        job_id: "EVID-1", scores: { ...baseScores, responsibilities: 25, technical: 20 }, unsupported_evidence: true,
        unsupported_evidence_details: "Finder claimed Kubernetes production ownership absent from the profile.",
      }),
      candidate({
        company: "Disagreement Example", title: "Technical Lead", canonical_url: "https://jobs.example.test/disagree",
        job_id: "DISAGREE-1", finder_eligibility: "Eligible", judge_eligibility: "Unclear", eligibility: "Unclear",
        finder_eligibility_evidence: "Finder interpreted worldwide remote as eligible.",
        judge_eligibility_evidence: "Judge found sponsorship and country coverage unspecified.",
      }),
      candidate({
        company: "Pending Example", title: "Senior Ruby Engineer", canonical_url: "https://jobs.example.test/pending",
        job_id: "PENDING-1", eligibility: "Needs Judge", finder_eligibility: "Unclear", judge_eligibility: null,
        finder_eligibility_evidence: "Remote is stated but country coverage is unclear.",
        judge_status: "Needs Judge", confidence: "Low",
        preliminary_score: 76, scores: undefined,
      }),
    ],
  });
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);

  const persistedWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbook));
  const leadsSheet = persistedWorkbook.worksheets.getItem("Leads");
  const leads = leadsSheet.tables.getItem("LeadsTable").getDataRows();
  const byCompany = new Map(leads.map((row) => [row[3], row]));
  assert.equal(leads.filter((row) => row[3] === "Global Example").length, 1, "canonical duplicates must produce one lead");
  assert.equal(byCompany.has("Blocked Example"), false, "hard location blocker must be suppressed");
  assert.equal(byCompany.get("Global Example")[14], "Backend / Platform", "the selected resume must be persisted with the lead");
  assert.match(byCompany.get("Global Example")[24], /^• Verified backend ownership\n• Ruby and PostgreSQL fit$/);
  assert.match(byCompany.get("Global Example")[25], /^• Compensation is unpublished$/);
  assert.match(byCompany.get("Global Example")[33], /Interview-process signal: Listed by Hiring Without Whiteboards/);
  assert.match(byCompany.get("Global Example")[33], /does not affect the fit score/);
  assert.equal(byCompany.get("Unclear Example")[11], "Unclear");
  assert.equal(byCompany.get("Evidence Example")[11], "Needs Human Review");
  assert.equal(byCompany.get("Disagreement Example")[11], "Needs Human Review");
  assert.equal(byCompany.get("Pending Example")[31], "Needs Judge");
  assert.equal(byCompany.get("Pending Example")[22], null);

  const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.equal(lastRun.alerts.length, 2, "only judged strong and unclear matches should alert");
  assert.deepEqual(new Set(lastRun.alerts.map((item) => item.company)), new Set(["Global Example", "Unclear Example"]));
  assert.equal(lastRun.reviews.length, 3, "strong unclear and human-review roles should enter the persistent inbox");
  const reviewRows = persistedWorkbook.worksheets.getItem("Eligibility Review").tables.getItem("EligibilityReviewTable").getDataRows();
  const reviewsByCompany = new Map(reviewRows.filter((row) => row[0]).map((row) => [row[5], row]));
  assert.deepEqual(new Set(reviewsByCompany.keys()), new Set(["Unclear Example", "Evidence Example", "Disagreement Example"]));
  assert.equal(reviewsByCompany.get("Evidence Example")[9], "Evidence");
  assert.equal(reviewsByCompany.get("Disagreement Example")[9], "Eligibility disagreement");
  assert.equal(reviewsByCompany.get("Unclear Example")[12], "Open");

  const runSheet = persistedWorkbook.worksheets.getItem("Run Log");
  const runRows = runSheet.tables.getItem("RunLogTable").getDataRows();
  const logged = runRows.find((row) => row[0] === "TEST-MIXED-001");
  assert.equal(logged[3], "Partial");
  assert.equal(logged[4], "Failed");
  assert.equal(logged[15], 2);
  const scanSheet = persistedWorkbook.worksheets.getItem("Scan Log");
  const scanRows = scanSheet.tables.getItem("ScanLogTable").getDataRows();
  assert.equal(scanRows.find((row) => row[3] === "Duplicate Example")[6], "Duplicate");

  for (const [sheet, rowNumber] of [
    [leadsSheet, 4 + leads.findIndex((row) => row[3] === "Global Example")],
    [scanSheet, 4 + scanRows.findIndex((row) => row[3] === "Duplicate Example")],
    [runSheet, 4 + runRows.findIndex((row) => row[0] === "TEST-MIXED-001")],
  ]) {
    const inspection = await persistedWorkbook.inspect({
      kind: "computedStyle", sheetId: sheet.name, range: "A" + rowNumber, maxChars: 4000,
    });
    const style = JSON.parse(inspection.ndjson.trim()).style;
    assert.equal(style.font.typeface, "Arial");
    assert.equal(style.font.fontSize, 9);
    assert.equal(style.wrapText, true);
    assert.equal(style.border.bottom.style, "thin");
  }
  await assert.rejects(fs.access(workbookInspectionPath(workbookTemporaryPath(workbook, "update-tmp"))), /ENOENT/);
});

test("only alerts inside the configured digest cap are stamped as alerted", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-cap-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const candidates = Array.from({ length: 6 }, (_, index) => candidate({
    company: "Cap Example " + index,
    title: "Backend Engineer " + index,
    canonical_url: "https://jobs.example.test/cap-" + index,
    job_id: "CAP-" + index,
    scores: { ...baseScores, responsibilities: 25 - index },
  }));
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-CAP-001", candidates })));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
  const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.equal(lastRun.alerts.length, 5);
  const leads = await workbookRows(workbook, "Leads", "LeadsTable");
  const lowest = leads.find((row) => row[3] === "Cap Example 5");
  assert.equal(lowest[27], null, "a qualifying lead outside the digest cap must remain alertable later");
});

test("repeat alerts require a threshold, eligibility, or material description trigger", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-repeat-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  await fs.copyFile(sourceWorkbook, workbook);

  const payloads = [
    { run_id: "TEST-REPEAT-001", candidate: candidate() },
    { run_id: "TEST-REPEAT-002", candidate: candidate() },
    { run_id: "TEST-REPEAT-003", candidate: candidate({
      job_description: "Materially changed description with broader technical leadership.",
      scores: { ...baseScores, responsibilities: 25, technical: 20, seniority: 15 },
    }) },
  ];
  const alertCounts = [];
  for (const item of payloads) {
    const payloadPath = path.join(tempDir, item.run_id + ".json");
    await fs.writeFile(payloadPath, JSON.stringify(runPayload({
      run_id: item.run_id,
      completed_at: "2026-08-24T09:00:00+05:00",
      candidates: [item.candidate],
    })));
    const result = runUpdater(workbook, stateDir, payloadPath);
    assert.equal(result.status, 0, result.stderr);
    const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
    alertCounts.push(lastRun.alerts.length);
  }
  assert.deepEqual(alertCounts, [1, 0, 1]);
});

test("empty runs succeed and locked-write failures preserve the workbook with a pending payload", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-lock-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const emptyPath = path.join(tempDir, "empty.json");
  await fs.copyFile(sourceWorkbook, workbook);
  await fs.writeFile(emptyPath, JSON.stringify(runPayload({ run_id: "TEST-EMPTY-001", candidates: [], notes: "No matches" })));
  let result = runUpdater(workbook, stateDir, emptyPath);
  assert.equal(result.status, 0, result.stderr);
  const emptyRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.deepEqual(emptyRun.alerts, []);

  const lockPath = workbookTemporaryPath(workbook, "update-tmp");
  await fs.mkdir(lockPath);
  const before = await sha256(workbook);
  const lockedPath = path.join(tempDir, "locked.json");
  await fs.writeFile(lockedPath, JSON.stringify(runPayload({ run_id: "TEST-LOCK-001", candidates: [candidate()] })));
  result = runUpdater(workbook, stateDir, lockedPath);
  assert.notEqual(result.status, 0);
  assert.equal(await sha256(workbook), before, "main workbook must remain byte-for-byte unchanged");
  const pending = JSON.parse(await fs.readFile(path.join(stateDir, "pending-TEST-LOCK-001.json"), "utf8"));
  assert.equal(pending.payload.run_id, "TEST-LOCK-001");
});

test("a later duplicate clears an earlier queued alert when final state needs review", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-stale-alert-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const first = candidate({ company: "Duplicate State Example", job_id: "DUP-STATE-1", canonical_url: "https://jobs.example.test/dup-state" });
  const final = candidate({
    company: "Duplicate State Example",
    job_id: "DUP-STATE-1",
    canonical_url: "https://jobs.example.test/dup-state?utm_source=feed",
    unsupported_evidence: true,
    unsupported_evidence_details: "The candidate profile does not support the claimed production Kubernetes ownership.",
  });
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-STALE-ALERT-001", candidates: [first, final] })));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
  const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.equal(lastRun.alerts.length, 0);
  const leads = await workbookRows(workbook, "Leads", "LeadsTable");
  const lead = leads.find((row) => row[3] === "Duplicate State Example");
  assert.equal(lead[11], "Needs Human Review");
  assert.equal(lead[27], null);
});

test("only listing-unavailability disagreements bypass human review", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-disagreement-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const locationDisagreement = candidate({
    company: "Authorization Disagreement",
    canonical_url: "https://jobs.example.test/auth-disagreement",
    job_id: "AUTH-DISAGREE-1",
    finder_eligibility: "Eligible",
    finder_eligibility_evidence: "Finder interpreted the role as worldwide remote.",
    judge_eligibility: "Ineligible",
    judge_eligibility_evidence: "Applicants must already be authorized to work in the United States.",
  });
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-DISAGREEMENT-001", candidates: [locationDisagreement] })));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
  const leads = await workbookRows(workbook, "Leads", "LeadsTable");
  assert.equal(leads.find((row) => row[3] === "Authorization Disagreement")[11], "Needs Human Review");
  const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.equal(lastRun.alerts.length, 0);
});

test("incomplete run envelopes are rejected before workbook mutation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-schema-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const before = await sha256(workbook);
  await fs.writeFile(payloadPath, JSON.stringify({ run_id: "TEST-SCHEMA-001", candidates: [] }));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.notEqual(result.status, 0);
  assert.equal(await sha256(workbook), before);
});

test("impossible counts and config-cap overruns are rejected", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-counts-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const payload = runPayload({ run_id: "TEST-COUNTS-001", candidates: [candidate()] });
  payload.judged = 2;
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  let result = runUpdater(workbook, stateDir, payloadPath);
  assert.notEqual(result.status, 0);
  const overCap = runPayload({ run_id: "TEST-CAP-OVERRUN-001", queries: 13, candidates: [] });
  await fs.writeFile(payloadPath, JSON.stringify(overCap));
  result = runUpdater(workbook, stateDir, payloadPath);
  assert.notEqual(result.status, 0);

  const failedAttempt = runPayload({
    run_id: "TEST-FAILED-ATTEMPT-001",
    queries: 1,
    query_attempts: [{
      query_id: "Q-FAILED-1",
      finder: "backend_finder",
      source: "canonical_web",
      lane: "canonical",
      status: "Failed",
      error: "Source timed out",
    }],
  });
  await fs.writeFile(payloadPath, JSON.stringify(failedAttempt));
  result = runUpdater(workbook, stateDir, payloadPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed query attempt must have status Partial/);
});

test("deep scan evaluations must also count as unique vacancies", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-scan-invariant-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const scanEvent = {
    finder: "backend_finder",
    examined_at: "2026-08-24T08:02:00+05:00",
    company: "Duplicate Example",
    title: "Backend Engineer",
    canonical_url: "https://jobs.example.test/duplicate",
    counts_toward_unique: false,
    deep_evaluated: true,
    outcome: "Duplicate",
    reason: "Already retained through the canonical employer page.",
    destination: "Scan Log",
  };
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-SCAN-INVARIANT", scan_events: [scanEvent] })));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be deep_evaluated when counts_toward_unique is false/);
});

test("reads Search Config run limits by label instead of row position", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-keyed-config-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  const edited = await SpreadsheetFile.importXlsx(await FileBlob.load(workbook));
  const configRange = edited.worksheets.getItem("Search Config").getRange("A5:B13");
  configRange.values = [...configRange.values].reverse();
  await (await SpreadsheetFile.exportXlsx(edited)).save(workbook);
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-KEYED-CONFIG", candidates: [candidate()] })));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
});

test("retrying a committed run id is a no-op with no repeated digest", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-idempotent-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);
  await fs.writeFile(payloadPath, JSON.stringify(runPayload({ run_id: "TEST-IDEMPOTENT-001", candidates: [candidate()] })));
  let result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
  result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);
  const retry = JSON.parse(result.stdout);
  assert.equal(retry.already_committed, true);
  assert.deepEqual(retry.alerts, []);
  const runs = await workbookRows(workbook, "Run Log", "RunLogTable");
  assert.equal(runs.filter((row) => row[0] === "TEST-IDEMPOTENT-001").length, 1);
});

test("persists attributed query metrics and returns funnel diagnostics", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-updater-metrics-"));
  const workbook = path.join(tempDir, "Tracker.xlsx");
  const stateDir = path.join(tempDir, "state");
  const payloadPath = path.join(tempDir, "run.json");
  await fs.copyFile(sourceWorkbook, workbook);

  const attributedCandidate = candidate({ discovery_query_id: "Q-BACKEND-1" });
  const duplicateEvent = {
    discovery_query_id: "Q-AI-1",
    finder: "ai_product_finder",
    examined_at: "2026-08-24T08:03:00+05:00",
    company: "Duplicate Metrics Example",
    title: "Product Engineer",
    canonical_url: "https://jobs.example.test/metrics-duplicate",
    counts_toward_unique: false,
    deep_evaluated: false,
    outcome: "Duplicate",
    reason: "The canonical vacancy was already attributed to another query.",
    destination: "Scan Log",
  };
  const payload = runPayload({
    run_id: "TEST-METRICS-001",
    queries: 2,
    query_attempts: [
      { query_id: "Q-BACKEND-1", finder: "backend_finder", source: "linkedin_public", lane: "remote_recent", status: "Completed" },
      { query_id: "Q-AI-1", finder: "ai_product_finder", source: "canonical_web", lane: "canonical", status: "Completed" },
    ],
    candidates: [attributedCandidate],
    scan_events: [duplicateEvent],
  });
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  const result = runUpdater(workbook, stateDir, payloadPath);
  assert.equal(result.status, 0, result.stderr);

  const lastRun = JSON.parse(await fs.readFile(path.join(stateDir, "last-run.json"), "utf8"));
  assert.equal(lastRun.diagnostics.query_metrics_available, true);
  assert.equal(lastRun.diagnostics.funnel.attempts_completed, 2);
  assert.equal(lastRun.diagnostics.funnel.found, 2);
  assert.equal(lastRun.diagnostics.query_metrics.find((metric) => metric.query_id === "Q-AI-1").duplicates, 1);

  const queryRows = (await workbookRows(workbook, "Query Metrics", "QueryMetricsTable")).filter((row) => row[0]);
  assert.equal(queryRows.length, 2);
  assert.equal(queryRows.find((row) => row[2] === "Q-BACKEND-1")[14], 1);
  assert.equal(queryRows.find((row) => row[2] === "Q-AI-1")[15], 1);
  const runRows = await workbookRows(workbook, "Run Log", "RunLogTable");
  assert.match(runRows.find((row) => row[0] === "TEST-METRICS-001")[17], /Adequate coverage/);
});
