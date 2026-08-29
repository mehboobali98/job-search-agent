import assert from "node:assert/strict";
import test from "node:test";
import { inspectTrackerContract, TRACKER_SHEETS, TRACKER_TABLES } from "../scripts/tracker_contract.mjs";

function workbookFixture({ detailReference = null, extraSheets = [] } = {}) {
  const worksheets = TRACKER_SHEETS.map((name) => {
    const expected = TRACKER_TABLES[name];
    const rows = [];
    if (name === "Leads" && detailReference) {
      const row = Array(expected.headers.length).fill(null);
      row[expected.headers.indexOf("Detail Sheet")] = detailReference;
      rows.push(row);
    }
    return {
      name,
      tables: {
        items: expected ? [{
          name: expected.name,
          getHeaderRowRange: () => ({ values: [expected.headers] }),
          getDataRows: () => rows,
        }] : [],
      },
    };
  });
  worksheets.push(...extraSheets.map((name) => ({ name, tables: { items: [] } })));
  return { worksheets: { items: worksheets } };
}

test("tracker contract accepts only detail sheets referenced by a tracker table", () => {
  const contract = inspectTrackerContract(workbookFixture({
    detailReference: "Fixture Role Detail",
    extraSheets: ["Fixture Role Detail"],
  }));
  assert.equal(contract.valid, true);
  assert.equal(contract.core_sheet_count, TRACKER_SHEETS.length);
  assert.equal(contract.detail_sheet_count, 1);
  assert.deepEqual(contract.extra_sheets, []);
  assert.deepEqual(contract.missing_detail_sheets, []);
});

test("tracker contract rejects unreferenced and missing detail sheets", () => {
  const unreferenced = inspectTrackerContract(workbookFixture({ extraSheets: ["Unknown Sheet"] }));
  assert.equal(unreferenced.valid, false);
  assert.deepEqual(unreferenced.extra_sheets, ["Unknown Sheet"]);

  const missing = inspectTrackerContract(workbookFixture({ detailReference: "Missing Detail" }));
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.missing_detail_sheets, ["Missing Detail"]);
});
