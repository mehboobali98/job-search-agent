import test from "node:test";
import assert from "node:assert/strict";
import { buildRunDiagnostics, validateQueryAttempts } from "../scripts/run_diagnostics.mjs";

function attempt(queryId, finder = "backend_finder", overrides = {}) {
  return {
    query_id: queryId,
    finder,
    source: "linkedin_public",
    lane: "remote_recent",
    role_family: "Backend / Platform",
    status: "Completed",
    ...overrides,
  };
}

function candidate(queryId = "Q-1") {
  return {
    discovery_query_id: queryId,
    finder: "backend_finder",
    company: "Example Co",
    title: "Senior Backend Engineer",
    location: "Worldwide remote",
    canonical_url: "https://jobs.example.test/one",
    job_id: "ONE",
    eligibility: "Eligible",
    confidence: "High",
    listing_status: "Active",
    final_score: 86,
    judge_status: "Judged",
    unsupported_evidence: false,
  };
}

function scanEvent(index, queryId = "Q-2", overrides = {}) {
  return {
    discovery_query_id: queryId,
    finder: "backend_finder",
    company: "Scanned Co " + index,
    title: "Backend Engineer " + index,
    location: "Remote",
    canonical_url: `https://jobs.example.test/scan-${index}`,
    counts_toward_unique: true,
    deep_evaluated: false,
    outcome: "Hard Blocked",
    eligibility: "Ineligible",
    ...overrides,
  };
}

test("derives attributed query metrics and flags thin deep-evaluation coverage", () => {
  const run = {
    queries: 2,
    query_attempts: [attempt("Q-1"), attempt("Q-2")],
    found: 6,
    unique: 6,
    evaluated: 1,
    judged: 1,
    candidates: [candidate()],
    scan_events: Array.from({ length: 5 }, (_, index) => scanEvent(index)),
  };
  const diagnostics = buildRunDiagnostics(run, {
    maxDeepEvaluations: 20,
    alertThreshold: 80,
    leadThreshold: 60,
    alertCount: 1,
  });

  assert.equal(diagnostics.coverage.status, "Thin");
  assert.equal(diagnostics.coverage.is_thin, true);
  assert.equal(diagnostics.rates.evaluation_rate, 0.1667);
  assert.equal(diagnostics.funnel.priority, 1);
  assert.equal(diagnostics.funnel.alerted, 1);
  assert.equal(diagnostics.query_metrics.find((metric) => metric.query_id === "Q-1").priority, 1);
  assert.equal(diagnostics.query_metrics.find((metric) => metric.query_id === "Q-2").hard_blocked, 5);
  assert.equal(diagnostics.role_metrics[0].role_family, "Backend / Platform");
  assert.match(diagnostics.summary, /Thin coverage/);
  assert.ok(diagnostics.warnings.some((warning) => /deeply evaluated/.test(warning)));
});

test("retains aggregate diagnostics for legacy payloads without query attempts", () => {
  const diagnostics = buildRunDiagnostics({
    queries: 2,
    found: 0,
    unique: 0,
    evaluated: 0,
    judged: 0,
    candidates: [],
    scan_events: [],
  }, { maxDeepEvaluations: 20, alertThreshold: 80, leadThreshold: 60 });

  assert.equal(diagnostics.query_metrics_available, false);
  assert.equal(diagnostics.coverage.status, "No discoveries");
  assert.ok(diagnostics.warnings.some((warning) => /query_attempts/.test(warning)));
  assert.ok(diagnostics.warnings.some((warning) => /does not establish/.test(warning)));
});

test("rejects duplicate attempts and unattributed results", () => {
  assert.throws(() => validateQueryAttempts({
    queries: 2,
    query_attempts: [attempt("Q-1"), attempt("Q-1")],
    candidates: [],
    scan_events: [],
  }), /Duplicate query_attempts query_id/);

  assert.throws(() => validateQueryAttempts({
    queries: 1,
    query_attempts: [attempt("Q-1")],
    candidates: [candidate("Q-UNKNOWN")],
    scan_events: [],
  }), /unknown discovery_query_id/);
});

test("keeps unavailable listings separate from eligibility blockers", () => {
  const diagnostics = buildRunDiagnostics({
    queries: 1,
    query_attempts: [attempt("Q-1")],
    found: 2,
    unique: 2,
    evaluated: 0,
    judged: 0,
    candidates: [],
    scan_events: [
      scanEvent(1, "Q-1", { outcome: "Expired", eligibility: "Ineligible" }),
      scanEvent(2, "Q-1", { outcome: "Inaccessible", eligibility: "Ineligible" }),
    ],
  }, { maxDeepEvaluations: 20, alertThreshold: 80, leadThreshold: 60 });
  const metric = diagnostics.query_metrics[0];
  assert.equal(metric.expired, 1);
  assert.equal(metric.inaccessible, 1);
  assert.equal(metric.hard_blocked, 0);
});
