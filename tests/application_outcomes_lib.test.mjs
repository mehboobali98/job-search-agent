import test from "node:test";
import assert from "node:assert/strict";
import { buildOutcomeCalibration, validateApplicationOutcome } from "../scripts/application_outcomes_lib.mjs";

test("validates explicit user-confirmed application outcomes", () => {
  const outcome = validateApplicationOutcome({
    schema_version: 1,
    event_id: "OUT-L-1-SCREEN",
    lead_id: "L-1",
    occurred_at: "2026-08-29T10:00:00Z",
    outcome: "Screening",
    stage: "Recruiter Screen",
    reason_category: "Recruiter response",
    user_confirmed: true,
  });
  assert.equal(outcome.outcome, "Screening");
  assert.throws(() => validateApplicationOutcome({ ...outcome, user_confirmed: false }), /user_confirmed/);
  assert.throws(() => validateApplicationOutcome({ ...outcome, outcome: "Maybe" }), /Invalid outcome/);
  assert.throws(() => validateApplicationOutcome({ ...outcome, stage: "Offer" }), /incompatible/);
});

test("builds advisory calibration without mutating policy", () => {
  const rows = [
    { lead_id: "L-1", outcome: "Applied", final_score: 85, resume_version: "Backend / Platform" },
    { lead_id: "L-1", outcome: "Screening", final_score: 85, resume_version: "Backend / Platform" },
    { lead_id: "L-2", outcome: "Applied", final_score: 75, resume_version: "Applied AI / LLM" },
    { lead_id: "L-2", outcome: "Rejected", final_score: 75, resume_version: "Applied AI / LLM" },
  ];
  const report = buildOutcomeCalibration(rows);
  assert.equal(report.policy_mutation, false);
  assert.equal(report.overall.applications, 2);
  assert.equal(report.overall.screening, 1);
  assert.equal(report.overall.screening_rate, 0.5);
  assert.match(report.recommendation, /never changed automatically/);
});
