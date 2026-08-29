import test from "node:test";
import assert from "node:assert/strict";
import { Workbook } from "@oai/artifact-tool";
import { ensureLeadMonitorSheet, leadMonitorSnapshotFromRow, upsertLeadMonitor } from "../scripts/lead_monitor_sheet.mjs";

test("upserts one latest monitored snapshot per lead", () => {
  const workbook = Workbook.create();
  const { sheet, table } = ensureLeadMonitorSheet(workbook);
  const lead = ["L-1", null, null, "Acme", "Staff Engineer", null, null, null, "https://jobs.example.test/1"];
  const base = {
    listing_status: "Active", location: "Remote", work_type: "Remote", description_hash: "a".repeat(64),
    compensation_published: false, compensation: null, eligibility: "Eligible", eligibility_evidence: "Worldwide remote.",
  };
  assert.equal(upsertLeadMonitor({
    sheet, table, lead, snapshot: base, evidenceIds: [], comparison: { change_types: [], summary: "No material change" },
    sourceEvidence: "Canonical page active.", runId: "RUN-1", now: new Date("2026-08-29T08:00:00Z"),
  }).outcome, "Added");
  assert.equal(upsertLeadMonitor({
    sheet, table, lead, snapshot: { ...base, compensation_published: true, compensation: "USD 100,000" },
    evidenceIds: ["policy-1"], comparison: { change_types: ["Compensation"], summary: "Compensation published" },
    sourceEvidence: "Canonical page updated.", runId: "RUN-2", now: new Date("2026-08-30T08:00:00Z"),
  }).outcome, "Updated");
  const rows = table.getDataRows().filter((row) => row[1] === "L-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0][15], "policy-1");
  assert.equal(leadMonitorSnapshotFromRow(rows[0]).compensation, "USD 100,000");
});
