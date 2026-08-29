import crypto from "node:crypto";
import { ELIGIBILITY_DECISIONS, LISTING_STATUS, SCORE_MAXIMA, scoreTotal } from "./job_tracker_lib.mjs";

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(label + " must be non-empty");
  return text;
}

function validateRange(value, label, maximum = null) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(label + " must be [minimum, maximum]");
  const range = value.map(Number);
  if (range.some((item) => !Number.isFinite(item)) || range[0] < 0 || range[1] < range[0] || (maximum !== null && range[1] > maximum)) {
    throw new Error(label + " is invalid");
  }
  return range;
}

export function validateCalibrationFixtures(raw) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1 || !Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
    throw new Error("Calibration fixtures require schema_version 1 and a non-empty fixtures[]");
  }
  const fixtures = raw.fixtures.map((fixture, index) => {
    const label = `fixtures[${index}]`;
    const fixtureId = requiredText(fixture.fixture_id, label + ".fixture_id");
    const expected = fixture.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error(label + ".expected is required");
    const scoreRanges = {};
    for (const [component, maximum] of Object.entries(SCORE_MAXIMA)) {
      scoreRanges[component] = validateRange(expected.score_ranges?.[component], `${label}.expected.score_ranges.${component}`, maximum);
    }
    const baselineTotal = scoreTotal(expected.baseline_scores);
    const totalRange = validateRange(expected.total_range, label + ".expected.total_range", 100);
    if (baselineTotal < totalRange[0] || baselineTotal > totalRange[1]) throw new Error(label + " baseline total is outside total_range");
    for (const [component, range] of Object.entries(scoreRanges)) {
      const baseline = Number(expected.baseline_scores[component]);
      if (baseline < range[0] || baseline > range[1]) throw new Error(`${label}.expected.baseline_scores.${component} is outside its score range`);
    }
    const allowedListing = (expected.allowed_listing_statuses ?? []).map((item) => requiredText(item, label + ".allowed_listing_statuses"));
    const allowedEligibility = (expected.allowed_eligibility ?? []).map((item) => requiredText(item, label + ".allowed_eligibility"));
    if (!allowedListing.length || allowedListing.some((item) => !LISTING_STATUS.has(item))) throw new Error(label + " has invalid allowed listing statuses");
    if (!allowedEligibility.length || allowedEligibility.some((item) => !ELIGIBILITY_DECISIONS.has(item))) throw new Error(label + " has invalid allowed eligibility values");
    const suppliedEvidenceIds = new Set([
      ...(fixture.candidate_evidence ?? []), ...(fixture.eligibility_evidence ?? []), ...(fixture.job?.source_evidence ?? []),
    ].map((item) => requiredText(item?.id, label + ".evidence.id")));
    const requiredEvidenceIds = (expected.required_evidence_ids ?? []).map((item) => requiredText(item, label + ".required_evidence_ids"));
    for (const evidenceId of requiredEvidenceIds) {
      if (!suppliedEvidenceIds.has(evidenceId)) throw new Error(label + " requires an evidence ID that is not supplied: " + evidenceId);
    }
    return {
      ...fixture,
      fixture_id: fixtureId,
      expected: {
        ...expected,
        score_ranges: scoreRanges,
        baseline_scores: Object.fromEntries(Object.keys(SCORE_MAXIMA).map((key) => [key, Number(expected.baseline_scores[key])])),
        baseline_total: baselineTotal,
        total_range: totalRange,
        allowed_listing_statuses: allowedListing,
        allowed_eligibility: allowedEligibility,
        required_evidence_ids: requiredEvidenceIds,
        forbidden_claims: (expected.forbidden_claims ?? []).map((item) => requiredText(item, label + ".forbidden_claims").toLowerCase()),
        unsupported_evidence: expected.unsupported_evidence === true,
      },
    };
  });
  if (new Set(fixtures.map((fixture) => fixture.fixture_id)).size !== fixtures.length) throw new Error("Calibration fixtures contain duplicate fixture IDs");
  return { schema_version: 1, fixtures };
}

export function calibrationId(fixtures) {
  const validated = validateCalibrationFixtures(fixtures);
  return "JCAL-" + crypto.createHash("sha256").update(JSON.stringify(validated)).digest("hex").slice(0, 16).toUpperCase();
}

export function prepareCalibrationPacket(fixtures) {
  const validated = validateCalibrationFixtures(fixtures);
  return {
    schema_version: 1,
    task_mode: "calibration",
    calibration_id: calibrationId(validated),
    scoring_maxima: SCORE_MAXIMA,
    instructions: [
      "Judge every synthetic fixture independently and return exactly one result per fixture.",
      "Cite only supplied stable evidence IDs; job requirements are not candidate evidence.",
      "Do not infer missing experience, eligibility, listing activity, or compensation.",
    ],
    fixtures: validated.fixtures.map(({ fixture_id, candidate_evidence, eligibility_evidence, job }) => ({
      fixture_id, candidate_evidence, eligibility_evidence, job,
    })),
  };
}

export function evaluateJudgeCalibration(fixturesRaw, resultsRaw) {
  const validated = validateCalibrationFixtures(fixturesRaw);
  const expectedCalibrationId = calibrationId(validated);
  if (!resultsRaw || typeof resultsRaw !== "object" || resultsRaw.schema_version !== 1 || !Array.isArray(resultsRaw.results)) {
    throw new Error("Judge calibration results require schema_version 1 and results[]");
  }
  if (resultsRaw.calibration_id !== expectedCalibrationId) throw new Error("Judge calibration_id does not match the current fixture set");
  const resultIds = resultsRaw.results.map((result, index) => requiredText(result.fixture_id, `results[${index}].fixture_id`));
  if (new Set(resultIds).size !== resultIds.length) throw new Error("Judge calibration results contain duplicate fixture IDs");
  const expectedIds = new Set(validated.fixtures.map((fixture) => fixture.fixture_id));
  const extraResults = resultIds.filter((id) => !expectedIds.has(id));
  const fixtureResults = validated.fixtures.map((fixture) => {
    const actual = resultsRaw.results.find((result) => result.fixture_id === fixture.fixture_id);
    const failures = [];
    const drift = {};
    if (!actual) return { fixture_id: fixture.fixture_id, passed: false, failures: ["Missing judge result"], score_drift: null };
    if (!fixture.expected.allowed_listing_statuses.includes(actual.listing_status)) failures.push("listing_status is outside the allowed set");
    if (!fixture.expected.allowed_eligibility.includes(actual.eligibility)) failures.push("eligibility is outside the allowed set");
    let total = null;
    try {
      total = scoreTotal(actual.scores);
      if (Number(actual.final_score) !== total) failures.push("final_score does not equal the component total");
      for (const [component, range] of Object.entries(fixture.expected.score_ranges)) {
        const value = Number(actual.scores[component]);
        if (value < range[0] || value > range[1]) failures.push(`${component} score ${value} is outside ${range[0]}-${range[1]}`);
        drift[component] = value - fixture.expected.baseline_scores[component];
      }
      if (total < fixture.expected.total_range[0] || total > fixture.expected.total_range[1]) failures.push(`total score ${total} is outside ${fixture.expected.total_range.join("-")}`);
      drift.total = total - fixture.expected.baseline_total;
    } catch (error) {
      failures.push(error.message);
    }
    const cited = new Set((actual.cited_evidence_ids ?? []).map(String));
    const suppliedEvidenceIds = new Set([
      ...(fixture.candidate_evidence ?? []), ...(fixture.eligibility_evidence ?? []), ...(fixture.job?.source_evidence ?? []),
    ].map((item) => item.id));
    for (const evidenceId of cited) {
      if (!suppliedEvidenceIds.has(evidenceId)) failures.push("Unknown evidence citation: " + evidenceId);
    }
    for (const evidenceId of fixture.expected.required_evidence_ids) {
      if (!cited.has(evidenceId)) failures.push("Missing required evidence citation: " + evidenceId);
    }
    if (actual.unsupported_evidence !== fixture.expected.unsupported_evidence) failures.push("unsupported_evidence does not match the fixture expectation");
    if (!Array.isArray(actual.strengths) || actual.strengths.length === 0) failures.push("strengths must be a non-empty array");
    if (!Array.isArray(actual.gaps)) failures.push("gaps must be an array");
    const rendered = JSON.stringify(actual.strengths ?? []).toLowerCase();
    for (const claim of fixture.expected.forbidden_claims) {
      if (rendered.includes(claim)) failures.push("Forbidden unsupported claim appeared: " + claim);
    }
    return {
      fixture_id: fixture.fixture_id,
      passed: failures.length === 0,
      failures,
      score_drift: total === null ? null : drift,
      actual_total: total,
      baseline_total: fixture.expected.baseline_total,
    };
  });
  if (extraResults.length) fixtureResults.push({ fixture_id: null, passed: false, failures: ["Unexpected fixture results: " + extraResults.join(", ")], score_drift: null });
  return {
    schema_version: 1,
    calibration_id: expectedCalibrationId,
    status: fixtureResults.every((result) => result.passed) ? "Passed" : "Failed",
    fixture_count: validated.fixtures.length,
    passed: fixtureResults.filter((result) => result.passed).length,
    failed: fixtureResults.filter((result) => !result.passed).length,
    score_drift: fixtureResults,
    policy_changed: false,
  };
}
