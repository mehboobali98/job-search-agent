import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoricalImportPlan,
  HISTORICAL_IMPORT_CLASSIFICATIONS,
  normalizeHistoricalRecord,
  publicHistoricalImportSummary,
  validateHistoricalImportSpec,
} from "../scripts/historical_tracker_import_lib.mjs";
import { candidateIdentityKeys } from "../scripts/job_tracker_lib.mjs";

const SOURCE_HASH = "a".repeat(64);

function spec(overrides = {}) {
  return {
    schema_version: 1,
    import_id: "synthetic-history-1",
    imported_at: "2026-08-30T09:00:00Z",
    sheets: [{
      sheet_name: "History",
      record_type: "application",
      header_row: 1,
      columns: { company: "Company", title: "Role", canonical_url: "URL" },
    }],
    ...overrides,
  };
}

function record(overrides = {}, options = {}) {
  return normalizeHistoricalRecord({
    company: "Northstar Example",
    title: "Backend Engineer",
    location: "Remote",
    canonical_url: "https://jobs.example.test/northstar?utm_source=old-sheet",
    date_applied: "2026-01-10",
    application_status: "Applied",
    current_stage: "Applied",
    ...overrides,
  }, {
    importId: "synthetic-history-1",
    importedAt: "2026-08-30T09:00:00Z",
    sheetName: "History",
    rowNumber: options.rowNumber ?? 2,
    recordType: options.recordType ?? "application",
  });
}

test("validates a strict versioned mapping and rejects ambiguity", () => {
  const normalized = validateHistoricalImportSpec(spec());
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.imported_at, "2026-08-30T09:00:00.000Z");
  assert.throws(() => validateHistoricalImportSpec({ ...spec(), secret: "no" }), /unsupported field/);
  assert.throws(() => validateHistoricalImportSpec(spec({ import_id: "not allowed" })), /opaque slug/);
  assert.throws(() => validateHistoricalImportSpec(spec({
    sheets: [{
      sheet_name: "History", record_type: "lead", header_row: 1,
      columns: { company: "Same", title: "Same" },
    }],
  })), /same header more than once/);
  assert.throws(() => validateHistoricalImportSpec(spec({
    sheets: Array.from({ length: 21 }, (_, index) => ({
      sheet_name: `History ${index}`, record_type: "lead", header_row: 1,
      columns: { company: "Company", title: "Title" },
    })),
  })), /1-20/);
});

test("normalizes URL, choices, dates, and privacy-safe row references", () => {
  const normalized = record({ best_resume: "backend / platform", eligibility: "unclear", confidence: "low" });
  assert.equal(normalized.canonical_url, "https://jobs.example.test/northstar");
  assert.equal(normalized.best_resume, "Backend / Platform");
  assert.equal(normalized.eligibility, "Unclear");
  assert.equal(normalized.date_applied, "2026-01-10T12:00:00.000Z");
  assert.match(normalized.source_ref, /^HREF-[a-f0-9]{24}$/);
  assert.doesNotMatch(normalized.source_ref, /History|Northstar/);
  assert.throws(() => record({ canonical_url: "javascript:alert(1)" }), /HTTP\(S\)/);
  assert.throws(() => record({ application_status: "Maybe someday" }), /unsupported/);
  assert.throws(() => record({ notes: "x".repeat(20_001) }), /exceeds 20000/);
});

test("deduplicates exact source rows and emits one lead and application", () => {
  const first = record({}, { rowNumber: 2 });
  const duplicate = record({}, { rowNumber: 3 });
  const plan = buildHistoricalImportPlan({ spec: spec(), records: [first, duplicate], sourceSha256: SOURCE_HASH });
  assert.equal(plan.operations.leads_to_add.length, 1);
  assert.equal(plan.operations.applications_to_add.length, 1);
  assert.equal(plan.diagnostics.classification_counts.duplicate_in_source, 1);
  assert.equal(plan.operations.leads_to_add[0].lead_id, "L-20260110-001");
});

test("quarantines conflicting duplicate source rows instead of choosing a winner", () => {
  const first = record({}, { rowNumber: 2 });
  const conflict = record({ current_stage: "Technical" }, { rowNumber: 3 });
  const plan = buildHistoricalImportPlan({ spec: spec(), records: [first, conflict], sourceSha256: SOURCE_HASH });
  assert.equal(plan.operations.leads_to_add.length, 0);
  assert.equal(plan.operations.applications_to_add.length, 0);
  assert.equal(plan.diagnostics.classification_counts.conflict_in_source, 2);
});

test("keeps current tracker rows authoritative and links only missing applications", () => {
  const imported = record();
  const targetLead = {
    lead_id: "L-20250101-007",
    canonical_key: imported.canonical_key,
    identity_keys: candidateIdentityKeys(imported),
  };
  const linked = buildHistoricalImportPlan({
    spec: spec(), records: [imported], targetLeads: [targetLead], sourceSha256: SOURCE_HASH,
  });
  assert.equal(linked.operations.leads_to_add.length, 0);
  assert.equal(linked.operations.applications_to_add.length, 1);
  assert.equal(linked.operations.applications_to_add[0].lead_id, targetLead.lead_id);
  assert.equal(linked.diagnostics.classification_counts.application_linked_to_existing_lead, 1);

  const targetApplication = { ...targetLead };
  const duplicate = buildHistoricalImportPlan({
    spec: spec(), records: [imported], targetLeads: [targetLead], targetApplications: [targetApplication], sourceSha256: SOURCE_HASH,
  });
  assert.equal(duplicate.operations.applications_to_add.length, 0);
  assert.equal(duplicate.diagnostics.classification_counts.duplicate_application_in_tracker, 1);

  const orphaned = buildHistoricalImportPlan({
    spec: spec(), records: [imported],
    targetApplications: [{ lead_id: "L-MISSING", canonical_key: imported.canonical_key, identity_keys: imported.identity_keys }],
    sourceSha256: SOURCE_HASH,
  });
  assert.equal(orphaned.operations.leads_to_add.length, 0);
  assert.equal(orphaned.operations.applications_to_add.length, 0);
  assert.equal(orphaned.diagnostics.classification_counts.conflict_in_tracker, 1);
});

test("public preview omits normalized operations and private row content", () => {
  const plan = buildHistoricalImportPlan({ spec: spec(), records: [record({ notes: "Private interview notes" })], sourceSha256: SOURCE_HASH });
  const preview = publicHistoricalImportSummary(plan);
  const serialized = JSON.stringify(preview);
  assert.equal(preview.mode, "preview");
  assert.equal(preview.applied, false);
  assert.equal("operations" in preview, false);
  assert.doesNotMatch(serialized, /Private interview notes|Northstar Example|Backend Engineer/);
});

test("retains explicit extraction classifications in deterministic diagnostics", () => {
  const malformed = { code: HISTORICAL_IMPORT_CLASSIFICATIONS.MALFORMED_ROW, source_ref: "HREF-abc", reason: "company and title are required" };
  const plan = buildHistoricalImportPlan({
    spec: spec(), records: [], sourceSha256: SOURCE_HASH, sourceClassifications: [malformed],
  });
  assert.equal(plan.diagnostics.classification_counts.malformed_row, 1);
  assert.deepEqual(plan.classifications, [malformed]);
});
