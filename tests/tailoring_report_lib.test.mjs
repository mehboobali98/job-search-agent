import test from "node:test";
import assert from "node:assert/strict";
import { extractCandidateEvidence, renderTailoringReportMarkdown, validateTailoringReport } from "../scripts/tailoring_report_lib.mjs";

function packet() {
  return {
    schema_version: 1,
    generated_at: "2026-08-29T10:00:00Z",
    job: { lead_id: "L-1", company: "Acme", role: "Backend Engineer", canonical_url: "https://example.test/job", description_hash: "a".repeat(64) },
    resume_version: "Backend / Platform",
    requirements: [{ requirement_id: "R-1", text: "Build Rails services", keywords: ["Ruby on Rails", "PostgreSQL"], source_evidence: "Canonical job description paragraph 2" }],
    keyword_coverage: [
      { keyword: "Ruby on Rails", requirement_ids: ["R-1"], status: "Covered", evidence_ids: ["E-BE-01"] },
      { keyword: "PostgreSQL", requirement_ids: ["R-1"], status: "Transferable", evidence_ids: ["E-BE-02"] },
    ],
    bullet_recommendations: [{ bullet_id: "B-1", action: "Reframe", text: "Built Rails services with PostgreSQL.", candidate_evidence_ids: ["E-BE-01", "E-BE-02"], source_resume: "Backend resume bullet 2", rationale: "Matches the primary requirement." }],
    gaps: [],
    prohibited_claims: ["Do not claim Kubernetes ownership."],
    review: { agent: "job_judge", status: "Completed", decision: "Approved", reviewed_at: "2026-08-29T10:05:00Z", supported_bullet_ids: ["B-1"], unsupported_bullet_ids: [] },
  };
}

test("validates and renders independently approved evidence-backed tailoring", () => {
  const evidence = extractCandidateEvidence("- **E-BE-01** — Built Rails services.\n- `E-BE-02` — Used PostgreSQL.\n");
  const report = validateTailoringReport(packet(), evidence);
  const markdown = renderTailoringReportMarkdown(report, evidence);
  assert.match(markdown, /ATS keyword coverage/);
  assert.match(markdown, /E-BE-01/);
  assert.match(markdown, /does not modify a resume/);
});

test("rejects unknown evidence and false approval", () => {
  const evidence = extractCandidateEvidence("- **E-BE-01** — Built Rails services.\n- **E-BE-02** — Used PostgreSQL.\n");
  const unknown = packet();
  unknown.bullet_recommendations[0].candidate_evidence_ids = ["E-MISSING"];
  assert.throws(() => validateTailoringReport(unknown, evidence), /unknown candidate evidence ID/);
  const unsupported = packet();
  unsupported.review.unsupported_bullet_ids = ["B-1"];
  assert.throws(() => validateTailoringReport(unsupported, evidence), /Approved tailoring reports/);
});
