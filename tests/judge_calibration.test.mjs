import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { calibrationId, evaluateJudgeCalibration, prepareCalibrationPacket, validateCalibrationFixtures } from "../scripts/judge_calibration_lib.mjs";

const fixtures = JSON.parse(await fs.readFile(new URL("../fixtures/judge-calibration.json", import.meta.url), "utf8"));

function baselineResults() {
  const validated = validateCalibrationFixtures(fixtures);
  return {
    schema_version: 1,
    calibration_id: calibrationId(fixtures),
    results: validated.fixtures.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      listing_status: fixture.expected.allowed_listing_statuses[0],
      eligibility: fixture.expected.allowed_eligibility[0],
      scores: fixture.expected.baseline_scores,
      final_score: fixture.expected.baseline_total,
      cited_evidence_ids: fixture.expected.required_evidence_ids,
      strengths: ["Synthetic evidence is cited without adding claims."],
      gaps: ["Only supplied synthetic evidence was considered."],
      unsupported_evidence: fixture.expected.unsupported_evidence,
    })),
  };
}

test("prepared calibration packet is blind to ranges and baselines", () => {
  const packet = prepareCalibrationPacket(fixtures);
  assert.equal(packet.task_mode, "calibration");
  assert.equal(JSON.stringify(packet).includes("baseline_scores"), false);
  assert.equal(JSON.stringify(packet).includes("forbidden_claims"), false);
});

test("baseline fixture results pass with zero score drift", () => {
  const report = evaluateJudgeCalibration(fixtures, baselineResults());
  assert.equal(report.status, "Passed");
  assert.equal(report.policy_changed, false);
  assert.ok(report.score_drift.every((fixture) => fixture.score_drift.total === 0));
});

test("out-of-range scores and missing citations fail calibration", () => {
  const results = baselineResults();
  results.results[0].scores.responsibilities = 1;
  results.results[0].final_score -= 21;
  results.results[0].cited_evidence_ids = [];
  const report = evaluateJudgeCalibration(fixtures, results);
  assert.equal(report.status, "Failed");
  assert.match(report.score_drift[0].failures.join(" "), /outside|Missing required/);
});

test("unknown citations and forbidden claimed strengths fail without penalizing explicit gaps", () => {
  const results = baselineResults();
  results.results[1].cited_evidence_ids.push("CAL-UNKNOWN-01");
  results.results[1].gaps.push("No production LLM ownership is established.");
  let report = evaluateJudgeCalibration(fixtures, results);
  assert.match(report.score_drift[1].failures.join(" "), /Unknown evidence citation/);
  results.results[1].cited_evidence_ids.pop();
  results.results[1].strengths.push("Demonstrates production LLM ownership.");
  report = evaluateJudgeCalibration(fixtures, results);
  assert.match(report.score_drift[1].failures.join(" "), /Forbidden unsupported claim/);
});
