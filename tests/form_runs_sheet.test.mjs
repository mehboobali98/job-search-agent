import test from "node:test";
import assert from "node:assert/strict";
import { applyFormRunRowRules } from "../scripts/form_runs_sheet.mjs";

test("applies formats and validations to Form Runs rows beyond the template range", () => {
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
  applyFormRunRowRules(sheet, 204);
  assert.equal(calls.get("C204").numberFormat, "yyyy-mm-dd hh:mm");
  assert.equal(calls.get("S204").numberFormat, "yyyy-mm-dd hh:mm");
  assert.equal(calls.get("K204:N204").numberFormat, "0");
  assert.deepEqual(calls.get("O204").validation.rule.values, ["Required", "Optional", "Absent", "Unclear"]);
  assert.deepEqual(calls.get("R204").validation.rule.values, ["Ready", "Needs User Input"]);
});
