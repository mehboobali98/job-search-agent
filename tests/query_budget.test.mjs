import assert from "node:assert/strict";
import test from "node:test";
import { queryMetricRecordsFromArchive, recommendQueryBudget, validateApplicableRecommendation } from "../scripts/query_budget_lib.mjs";

const currentBudget = {
  "Backend / Platform": 6,
  "Staff / Principal / Tech Lead": 2,
  "Applied AI / LLM": 2,
  "Developer Productivity / AI Enablement": 1,
  "Full-stack / Product": 1,
};

function records(role, count, values = {}) {
  return Array.from({ length: count }, (_, index) => ({
    run_id: "SYNTHETIC", query_id: role + index, role_family: role, status: "Completed",
    found: 1, unique: 1, evaluated: 1, reviewable: 0, priority: 0, ...values,
  }));
}

test("budget guidance requires enough attributed evidence", () => {
  const result = recommendQueryBudget({ records: records("Backend / Platform", 1), currentBudget });
  assert.equal(result.status, "Insufficient evidence");
  assert.equal(result.applied, false);
  assert.equal(result.requires_explicit_approval, true);
});

test("budget guidance recommends at most one evidence-backed transfer", () => {
  const input = [
    ...records("Backend / Platform", 5, { reviewable: 1, priority: 1 }),
    ...records("Staff / Principal / Tech Lead", 5, { found: 0, unique: 0, evaluated: 0 }),
  ];
  const result = recommendQueryBudget({ records: input, currentBudget });
  assert.equal(result.status, "Recommendation");
  assert.equal(result.proposed_budget["Backend / Platform"], 7);
  assert.equal(result.proposed_budget["Staff / Principal / Tech Lead"], 1);
  assert.equal(Object.values(result.proposed_budget).reduce((sum, value) => sum + value, 0), 12);
  assert.deepEqual(validateApplicableRecommendation(result, result.recommendation_id, currentBudget), result.proposed_budget);
  assert.throws(() => validateApplicableRecommendation(result, "wrong", currentBudget), /exactly match/);
  const changedTotal = { ...result, total_queries: 11 };
  assert.throws(() => validateApplicableRecommendation(changedTotal, result.recommendation_id, currentBudget), /content does not match/);
});

test("budget guidance rejects malformed archive metrics", () => {
  assert.throws(() => recommendQueryBudget({
    records: [{ role_family: "Backend / Platform", status: "Completed", found: -1 }], currentBudget,
  }), /non-negative integer/);
});

test("archive extraction uses query-plan role attribution for legacy metrics", () => {
  const extracted = queryMetricRecordsFromArchive({
    run_id: "SYNTHETIC",
    replay_context: { query_plan: [{ query_id: "Q-1", role_family: "Applied AI / LLM" }] },
  }, {
    run_id: "SYNTHETIC",
    diagnostics: { query_metrics: [{ query_id: "Q-1", status: "Completed", found: 2, unique: 1 }] },
  });
  assert.equal(extracted.unattributed, 0);
  assert.equal(extracted.records[0].role_family, "Applied AI / LLM");
});
