import test from "node:test";
import assert from "node:assert/strict";
import { Workbook } from "@oai/artifact-tool";
import { appendApplicationOutcome, ensureApplicationOutcomesSheet } from "../scripts/application_outcomes_sheet.mjs";

test("creates an append-only idempotent application outcome table", () => {
  const workbook = Workbook.create();
  const { sheet, table, changed } = ensureApplicationOutcomesSheet(workbook);
  assert.equal(changed, true);
  const values = ["OUT-1", "L-1", new Date(), "Acme", "Engineer", "Applied", "Applied", null, null, true, 85, "Backend / Platform", "job:acme:1", new Date()];
  assert.equal(appendApplicationOutcome({ sheet, table, values }).outcome, "Recorded");
  assert.equal(appendApplicationOutcome({ sheet, table, values }).outcome, "Already recorded");
  assert.equal(table.getDataRows().filter((row) => row[0] === "OUT-1").length, 1);
  assert.equal(ensureApplicationOutcomesSheet(workbook).changed, false);
});
