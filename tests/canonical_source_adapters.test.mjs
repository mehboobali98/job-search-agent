import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_SOURCE_ADAPTERS,
  canonicalAtsSites,
  canonicalSourceAdapterPlan,
  identifyCanonicalSource,
} from "../scripts/canonical_source_adapters.mjs";

test("publishes a stable public read-only adapter registry", () => {
  assert.deepEqual(CANONICAL_SOURCE_ADAPTERS.map((adapter) => adapter.id), [
    "ashby", "greenhouse", "workable", "lever", "smartrecruiters",
  ]);
  assert.ok(canonicalAtsSites().includes("jobs.ashbyhq.com"));
  assert.ok(canonicalAtsSites().includes("boards.greenhouse.io"));
  for (const adapter of canonicalSourceAdapterPlan()) {
    assert.equal(adapter.access, "public_read_only");
    assert.match(adapter.rules.join(" "), /Never use private APIs/);
  }
});

test("identifies canonical sources, strips tracking, and infers published job IDs", () => {
  assert.deepEqual(identifyCanonicalSource("https://job-boards.greenhouse.io/acme/jobs/12345?utm_source=x"), {
    recognized: true,
    adapter_id: "greenhouse",
    adapter_name: "Greenhouse",
    canonical_url: "https://job-boards.greenhouse.io/acme/jobs/12345",
    inferred_job_id: "12345",
  });
  assert.equal(identifyCanonicalSource("https://jobs.ashbyhq.com/acme/abc-def").inferred_job_id, "abc-def");
  assert.equal(identifyCanonicalSource("https://apply.workable.com/acme/j/ABC123/").inferred_job_id, "ABC123");
  assert.equal(identifyCanonicalSource("https://jobs.lever.co/acme/uuid").inferred_job_id, "uuid");
});

test("leaves employer-hosted sources recognized as outside the adapter registry", () => {
  const source = identifyCanonicalSource("https://careers.example.com/jobs/42?ref=linkedin");
  assert.equal(source.recognized, false);
  assert.equal(source.adapter_id, null);
  assert.equal(source.canonical_url, "https://careers.example.com/jobs/42");
  assert.equal(source.inferred_job_id, null);
});
