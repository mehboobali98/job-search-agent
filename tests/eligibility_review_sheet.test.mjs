import test from "node:test";
import assert from "node:assert/strict";
import { Workbook } from "@oai/artifact-tool";
import { ensureEligibilityReviewSheet, syncEligibilityReview } from "../scripts/eligibility_review_sheet.mjs";

function reviewCandidate(overrides = {}) {
  return {
    lead_id: "L-TEST-REVIEW",
    company: "Example",
    title: "Staff Engineer",
    final_score: 84,
    eligibility: "Unclear",
    eligibility_evidence: "Country coverage is not stated.",
    canonical_url: "https://jobs.example.test/role",
    description_hash: "a".repeat(64),
    ...overrides,
  };
}

test("creates, updates, and resolves a persistent eligibility review without overwriting manual fields", () => {
  const workbook = Workbook.create();
  const { sheet, table } = ensureEligibilityReviewSheet(workbook);
  const first = syncEligibilityReview({
    sheet, table, candidate: reviewCandidate(), runId: "RUN-1", now: new Date("2026-08-29T08:00:00Z"),
    shouldReview: true, reviewType: "Eligibility clarification", reviewReason: "Strong role is unclear.",
    canonicalSource: "Employer-hosted / unrecognized", sourceStatus: "Verified Active",
  });
  assert.equal(first.outcome, "Added");
  let row = table.getDataRows().find((value) => value[1] === "L-TEST-REVIEW");
  assert.equal(row[12], "Open");

  const index = table.getDataRows().findIndex((value) => value[1] === "L-TEST-REVIEW");
  sheet.getRange(`M${4 + index}:N${4 + index}`).values = [["Dismissed", "User reviewed this case."]];
  const updated = syncEligibilityReview({
    sheet, table, candidate: reviewCandidate({ final_score: 86 }), runId: "RUN-2", now: new Date("2026-08-30T08:00:00Z"),
    shouldReview: true, reviewType: "Eligibility clarification", reviewReason: "Still unclear.",
    canonicalSource: "Employer-hosted / unrecognized", sourceStatus: "Verified Active",
  });
  assert.equal(updated.outcome, "Updated");
  row = table.getDataRows().find((value) => value[1] === "L-TEST-REVIEW");
  assert.equal(row[12], "Dismissed");
  assert.equal(row[13], "User reviewed this case.");

  sheet.getRange(`M${4 + index}:N${4 + index}`).values = [["Open", null]];
  const resolved = syncEligibilityReview({
    sheet, table, candidate: reviewCandidate({ eligibility: "Eligible" }), runId: "RUN-3", now: new Date("2026-08-31T08:00:00Z"),
    shouldReview: false, reviewType: null, reviewReason: null,
    canonicalSource: "Employer-hosted / unrecognized", sourceStatus: "Verified Active",
  });
  assert.equal(resolved.outcome, "Resolved");
  row = table.getDataRows().find((value) => value[1] === "L-TEST-REVIEW");
  assert.equal(row[12], "Resolved");
  assert.match(row[13], /Eligibility resolved as Eligible/);
});
