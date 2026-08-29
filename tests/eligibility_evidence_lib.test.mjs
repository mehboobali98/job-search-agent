import test from "node:test";
import assert from "node:assert/strict";
import {
  assessEligibilityEvidence,
  eligibilityRegistrySnapshot,
  validateEligibilityRegistry,
} from "../scripts/eligibility_evidence_lib.mjs";

function registry(entries) {
  return { version: 1, entries };
}

function entry(overrides = {}) {
  return {
    id: "acme-pakistan-hiring",
    topic: "Hiring country",
    applies_to: { companies: ["Acme"], locations: ["Pakistan"] },
    conclusion: "Supports",
    statement: "Acme explicitly lists Pakistan as an eligible hiring country.",
    source_url: "https://careers.example.test/remote-policy",
    observed_at: "2026-08-01",
    expires_at: "2026-11-01",
    confidence: "High",
    status: "Active",
    ...overrides,
  };
}

test("validates scoped, cited, expiring eligibility evidence", () => {
  const validated = validateEligibilityRegistry(registry([entry()]));
  assert.equal(validated.entries[0].source_url, "https://careers.example.test/remote-policy");
  assert.throws(() => validateEligibilityRegistry(registry([entry({ source_url: "http://example.test" })])), /must use https/);
  assert.throws(() => validateEligibilityRegistry(registry([entry({ expires_at: "2026-07-01" })])), /cannot precede observed_at/);
  assert.throws(() => validateEligibilityRegistry(registry([entry({ applies_to: { global: true, companies: ["Acme"] } })])), /cannot combine global/);
});

test("separates active, expired, and superseded evidence and honors expiring human overrides", () => {
  const snapshot = eligibilityRegistrySnapshot(registry([
    entry(),
    entry({ id: "expired", expires_at: "2026-08-15" }),
    entry({ id: "superseded", status: "Superseded" }),
    entry({
      id: "override",
      conclusion: "Blocks",
      override: {
        conclusion: "Supports",
        reason: "Candidate confirmed an employer-specific exception.",
        confirmed_at: "2026-08-20",
        expires_at: "2026-09-20",
      },
    }),
  ]), { asOf: "2026-08-29" });
  assert.deepEqual(snapshot.active_entries.map((value) => value.id), ["acme-pakistan-hiring", "override"]);
  assert.equal(snapshot.active_entries.find((value) => value.id === "override").effective_conclusion, "Supports");
  assert.equal(snapshot.active_entries.find((value) => value.id === "override").override_applied, true);
  assert.deepEqual(snapshot.expired_entries.map((value) => value.id), ["expired"]);
  assert.deepEqual(snapshot.superseded_entries.map((value) => value.id), ["superseded"]);
});

test("uses only fresh in-scope references and routes conflicts to review without deciding eligibility", () => {
  const raw = registry([
    entry({ id: "active-block", conclusion: "Blocks" }),
    entry({ id: "stale-support", expires_at: "2026-08-15" }),
    entry({ id: "other-company", applies_to: { companies: ["Other"] } }),
  ]);
  const assessment = assessEligibilityEvidence(raw, {
    company: "Acme",
    location: "Lahore, Pakistan",
    source: "Employer careers",
    canonical_url: "https://careers.example.test/jobs/1",
    listing_status: "Active",
    eligibility: "Eligible",
  }, ["active-block", "stale-support", "other-company"], { asOf: "2026-08-29" });
  assert.equal(assessment.status, "Conflict");
  assert.equal(assessment.conflict, true);
  assert.deepEqual(assessment.active.map((value) => value.id), ["active-block"]);
  assert.deepEqual(assessment.stale.map((value) => value.id), ["stale-support"]);
  assert.deepEqual(assessment.mismatched.map((value) => value.id), ["other-company"]);
  assert.match(assessment.citations[0], /valid through 2026-11-01/);
  assert.throws(() => assessEligibilityEvidence(raw, {}, ["missing"], { asOf: "2026-08-29" }), /Unknown eligibility evidence ID/);
});
