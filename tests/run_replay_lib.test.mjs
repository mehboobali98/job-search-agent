import test from "node:test";
import assert from "node:assert/strict";
import { buildReplaySnapshot, compareReplaySnapshots } from "../scripts/run_replay_lib.mjs";

function run(id, query, score) {
  return {
    run_id: id,
    started_at: "2026-08-29T08:00:00Z",
    completed_at: "2026-08-29T08:01:00Z",
    status: "Completed",
    agents: { backend_finder: "Completed" },
    queries: 1, found: 1, unique: 1, evaluated: 1, judged: 1,
    replay_context: { query_plan: [{ query_id: "Q-1", finder: "backend_finder", source: "web", lane: "backend", query }], filters: { country: "Worldwide" }, config: { alert_threshold: 80 }, evidence: { profile_hash: "abc" } },
    candidates: [{ company: "Acme", title: "Engineer", location: "Remote", canonical_url: "https://example.test/job", final_score: score, recommendation: score >= 80 ? "Strong match" : "Review", eligibility: "Eligible", confidence: "High", judge_status: "Judged", listing_status: "Active", best_resume: "Backend / Platform", candidate_evidence_ids: ["E-1"] }],
    scan_events: [], errors: [],
  };
}

test("produces stable replay hashes and explains material run differences", () => {
  const first = buildReplaySnapshot(run("RUN-1", "backend engineer", 79));
  const repeated = buildReplaySnapshot(run("RUN-1", "backend engineer", 79));
  assert.equal(first.replay_hash, repeated.replay_hash);
  const second = buildReplaySnapshot(run("RUN-2", "principal backend engineer", 85));
  const comparison = compareReplaySnapshots(first, second);
  assert.equal(comparison.identical, false);
  assert.equal(comparison.queries.changed.length, 1);
  assert.ok(comparison.candidates.changed[0].changes.some((change) => change.field === "final_score"));
  assert.match(comparison.explanations.join(" "), /query set changed/i);
});
