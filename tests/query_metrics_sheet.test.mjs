import test from "node:test";
import assert from "node:assert/strict";
import { applyQueryMetricRowRules } from "../scripts/query_metrics_sheet.mjs";

test("applies formats and validation to Query Metrics rows beyond the template range", () => {
  const calls = new Map();
  const sheet = {
    getRange(address) {
      const entry = { numberFormat: null, validation: null };
      calls.set(address, entry);
      return {
        setNumberFormat(value) { entry.numberFormat = value; },
        set dataValidation(value) { entry.validation = value; },
      };
    },
  };
  applyQueryMetricRowRules(sheet, 204);
  assert.equal(calls.get("B204").numberFormat, "yyyy-mm-dd hh:mm");
  assert.equal(calls.get("H204:T204").numberFormat, "0");
  assert.equal(calls.get("U204:W204").numberFormat, "0.0%");
  assert.deepEqual(calls.get("G204").validation.rule.values, ["Completed", "Failed"]);
});
