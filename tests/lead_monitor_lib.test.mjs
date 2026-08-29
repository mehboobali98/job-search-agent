import test from "node:test";
import assert from "node:assert/strict";
import { descriptionHash } from "../scripts/job_tracker_lib.mjs";
import { compareLeadSnapshots, validateLeadMonitorCheck } from "../scripts/lead_monitor_lib.mjs";

const lead = [
  "L-1", null, null, "Acme", "Staff Engineer", "Worldwide remote", "Remote", "Employer", "https://jobs.example.test/1",
];

test("validates complete active monitor snapshots and exact description hashes", () => {
  const description = "Build reliable backend systems.";
  const check = validateLeadMonitorCheck({
    lead_id: "L-1",
    canonical_url: "https://jobs.example.test/1?utm_source=x",
    listing_status: "Active",
    evidence: "Canonical page was read successfully.",
    location: "Pakistan remote",
    work_type: "Remote",
    job_description: description,
    description_hash: descriptionHash(description),
    compensation: { published: true, text: "USD 100,000-120,000" },
    eligibility: "Unclear",
    eligibility_evidence: "Pakistan is listed but sponsorship is not addressed.",
    eligibility_evidence_ids: ["acme-pakistan"],
  }, lead);
  assert.equal(check.canonical_url, "https://jobs.example.test/1");
  assert.equal(check.compensation_published, true);
  assert.throws(() => validateLeadMonitorCheck({
    ...check,
    job_description: description,
    description_hash: "a".repeat(64),
    compensation: { published: true, text: check.compensation },
  }, lead), /does not match/);
});

test("detects only material monitored-lead changes", () => {
  const previous = {
    listing_status: "Active", location: "Worldwide remote", work_type: "Remote", description_hash: "a",
    compensation_published: null, compensation: null, eligibility: "Eligible",
  };
  const changed = compareLeadSnapshots(previous, {
    listing_status: "Active", location: "Pakistan remote", work_type: "Hybrid", description_hash: "b",
    compensation_published: true, compensation: "USD 100,000", eligibility: "Unclear",
  });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.change_types, ["Location", "Work Type", "Description", "Compensation", "Eligibility"]);
  const stable = compareLeadSnapshots(previous, { ...previous, compensation_published: false });
  assert.equal(stable.changed, false);
});
