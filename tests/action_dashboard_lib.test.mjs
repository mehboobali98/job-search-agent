import test from "node:test";
import assert from "node:assert/strict";
import { deriveActionDashboard } from "../scripts/action_dashboard_lib.mjs";

test("derives review, submission, follow-up, and stale-lead actions", () => {
  const lead = Array(37).fill(null);
  Object.assign(lead, { 0: "L-1", 2: new Date("2026-08-01T00:00:00Z"), 3: "Acme", 4: "Engineer", 8: "https://example.test/job", 26: "Shortlisted" });
  const preparing = Array(29).fill(null);
  Object.assign(preparing, { 0: "L-2", 2: "Beta", 3: "Staff Engineer", 6: "Backend / Platform", 8: "https://example.test/beta", 11: "Draft", 20: "Preparing", 21: "Review package" });
  const applied = Array(29).fill(null);
  Object.assign(applied, { 0: "L-3", 2: "Gamma", 3: "Principal Engineer", 8: "https://example.test/gamma", 11: "Applied", 12: new Date("2026-08-20T00:00:00Z"), 20: "Applied" });
  const review = Array(18).fill(null);
  Object.assign(review, { 0: "REV-L-4", 1: "L-4", 5: "Delta", 6: "AI Engineer", 7: 90, 10: "Confirm sponsorship", 12: "Open", 14: "https://example.test/delta" });
  const actions = deriveActionDashboard({ leads: [lead], applications: [preparing, applied], eligibilityReviews: [review], asOf: new Date("2026-08-29T00:00:00Z") });
  assert.deepEqual(new Set(actions.map((item) => item.category)), new Set(["Eligibility Review", "Manual Submission", "Follow-up", "Stale Lead"]));
  assert.equal(actions[0].priority, "High");
});
