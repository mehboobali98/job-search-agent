import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalKey,
  candidateIdentityKeys,
  descriptionHash,
  isAlertable,
  normalizeUrl,
  recommendationBand,
  scoreTotal,
  shouldRepeatAlert,
  validateJudgedCandidate,
  allocateLargestRemainder,
} from "../scripts/job_tracker_lib.mjs";

const strong = {
  company: "Example",
  title: "Senior Backend Engineer",
  canonical_url: "https://jobs.example.com/123?utm_source=linkedin",
  eligibility: "Eligible",
  confidence: "High",
  listing_status: "Active",
  source: "Employer careers",
  location: "Worldwide remote",
  work_type: "Remote",
  job_description: "Build and operate backend services.",
  eligibility_evidence: "Worldwide remote is explicitly stated.",
  best_resume: "Backend / Platform",
  strengths: ["Verified backend fit"],
  gaps: ["Compensation unpublished"],
  judge_status: "Judged",
  unsupported_evidence: false,
  scores: { responsibilities: 23, technical: 18, seniority: 13, evidence: 13, domain: 7, location: 9, compensation: 3 },
  final_score: 86,
};

test("normalizes tracking parameters from URLs", () => {
  assert.equal(normalizeUrl(strong.canonical_url), "https://jobs.example.com/123");
});

test("canonical key prefers employer job id", () => {
  assert.equal(canonicalKey({ company: "Example", job_id: "ABC-1", canonical_url: "https://elsewhere.test" }), "job:example:abc-1");
});

test("all dedupe identities are retained for cross-source matching", () => {
  const keys = candidateIdentityKeys({ company: "Example", title: "Engineer", location: "Remote", job_id: "ABC-1", canonical_url: "https://jobs.example.test/1" });
  assert.deepEqual(keys, [
    "job:example:abc-1",
    "url:https://jobs.example.test/1",
    canonicalKey({ company: "Example", title: "Engineer", location: "Remote" }),
  ]);
});

test("largest-remainder allocation is deterministic and uses the full budget", () => {
  const allocated = allocateLargestRemainder(12, {
    "Backend / Platform": 0.5,
    "Staff / Principal / Tech Lead": 0.2,
    "Applied AI / LLM": 0.15,
    "Developer Productivity / AI Enablement": 0.1,
    "Full-stack / Product": 0.05,
  });
  assert.deepEqual(Object.values(allocated), [6, 2, 2, 1, 1]);
  assert.throws(() => allocateLargestRemainder(12, { backend: 1.1, ai: -0.1 }), /non-negative/);
});

test("score total enforces the rubric maxima", () => {
  assert.equal(scoreTotal(strong.scores), 86);
  assert.throws(() => scoreTotal({ ...strong.scores, technical: 21 }), /Invalid score/);
});

test("judge validation derives final score and recommendation", () => {
  const validated = validateJudgedCandidate(strong);
  assert.equal(validated.final_score, 86);
  assert.equal(validated.recommendation, "Strong match");
  assert.match(validated.canonical_key, /^url:/);
  assert.throws(() => validateJudgedCandidate({ ...strong, listing_status: "Expired" }), /must be Ineligible/);
});

test("hard eligibility blocks alerts", () => {
  assert.equal(isAlertable({ ...strong, final_score: 95 }), true);
  assert.equal(isAlertable({ ...strong, final_score: 95, eligibility: "Ineligible" }), false);
  assert.equal(recommendationBand(95, "Ineligible"), "Suppressed");
});

test("unsupported evidence blocks alerts", () => {
  assert.equal(isAlertable({ ...strong, final_score: 90, unsupported_evidence: true }), false);
});

test("unjudged and failed-judge candidates cannot alert", () => {
  assert.equal(isAlertable({ ...strong, final_score: 90, judge_status: "Failed" }), false);
  assert.throws(() => validateJudgedCandidate({ ...strong, judge_status: "Failed" }), /judge_status Judged/);
  const missingFlag = { ...strong };
  delete missingFlag.unsupported_evidence;
  assert.throws(() => validateJudgedCandidate(missingFlag), /unsupported_evidence/);
});

test("repeat alerts require a material trigger", () => {
  const current = { ...strong, final_score: 86, description_hash: descriptionHash("new") };
  assert.equal(shouldRepeatAlert({ last_alerted: "2026-08-24", final_score: 86, eligibility: "Eligible", description_hash: current.description_hash }, current), false);
  assert.equal(shouldRepeatAlert({ last_alerted: "2026-08-24", final_score: 78, eligibility: "Eligible", description_hash: descriptionHash("old") }, current), true);
  assert.equal(shouldRepeatAlert({ last_alerted: "2026-08-24", final_score: 80, eligibility: "Unclear", description_hash: current.description_hash }, current), true);
});

test("needs-judge and human-review bands are never alertable", () => {
  assert.equal(recommendationBand(92, "Needs Judge"), "Needs Judge");
  assert.equal(recommendationBand(92, "Needs Human Review"), "Needs Human Review");
  assert.equal(isAlertable({ ...strong, final_score: 92, eligibility: "Needs Judge" }), false);
  assert.equal(isAlertable({ ...strong, final_score: 92, eligibility: "Needs Human Review" }), false);
});
