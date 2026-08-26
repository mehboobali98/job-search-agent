import test from "node:test";
import assert from "node:assert/strict";
import { styleTrackerRow } from "../scripts/tracker_rows.mjs";

test("applies tracker formats, validation, and conditional formatting beyond row 203", () => {
  const calls = new Map();
  const sheet = {
    getRange(address) {
      if (!calls.has(address)) calls.set(address, { format: null, numberFormat: null, validation: null, conditional: [] });
      const entry = calls.get(address);
      return {
        set format(value) { entry.format = value; },
        get format() {
          return {
            autofitRows() { entry.autofit = true; },
            set rowHeight(value) { entry.rowHeight = value; },
          };
        },
        setNumberFormat(value) { entry.numberFormat = value; },
        set dataValidation(value) { entry.validation = value; },
        conditionalFormats: { add(type, options) { entry.conditional.push({ type, options }); } },
      };
    },
  };

  styleTrackerRow(sheet, 204, "AK", {
    numberFormats: { B: "yyyy-mm-dd", "P:W": "0" },
    validations: { L: ["Eligible", "Unclear"] },
    conditionalFormats: [{ column: "W", type: "colorScale", options: { thresholds: ["min", "50%", "max"] } }],
  });

  assert.equal(calls.get("A204:AK204").format.font.name, "Arial");
  assert.equal(calls.get("A204:AK204").format.font.size, 9);
  assert.equal(calls.get("B204").numberFormat, "yyyy-mm-dd");
  assert.equal(calls.get("P204:W204").numberFormat, "0");
  assert.deepEqual(calls.get("L204").validation.rule.values, ["Eligible", "Unclear"]);
  assert.equal(calls.get("W204").conditional[0].type, "colorScale");
});
