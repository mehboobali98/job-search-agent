import { ACTION_DASHBOARD_HEADERS } from "./action_dashboard_sheet.mjs";
import { APPLICATION_OUTCOME_HEADERS } from "./application_outcomes_sheet.mjs";
import { APPLICATION_HEADERS, LEAD_HEADERS, RUN_HEADERS, SCAN_HEADERS } from "./tracker_headers.mjs";
import { ELIGIBILITY_REVIEW_HEADERS } from "./eligibility_review_sheet.mjs";
import { FORM_RUN_HEADERS } from "./form_runs_sheet.mjs";
import { LEAD_MONITOR_HEADERS } from "./lead_monitor_sheet.mjs";
import { QUERY_METRIC_HEADERS } from "./query_metrics_sheet.mjs";

export const TRACKER_SHEETS = Object.freeze([
  "Dashboard", "Search Config", "Leads", "Applications", "Scan Log", "Run Log", "Form Runs", "Query Metrics",
  "Eligibility Review", "Lead Monitor", "Application Outcomes", "Action Dashboard",
]);

export const TRACKER_TABLES = Object.freeze({
  Leads: { name: "LeadsTable", headers: LEAD_HEADERS },
  Applications: { name: "ApplicationsTable", headers: APPLICATION_HEADERS },
  "Scan Log": { name: "ScanLogTable", headers: SCAN_HEADERS },
  "Run Log": { name: "RunLogTable", headers: RUN_HEADERS },
  "Form Runs": { name: "FormRunsTable", headers: FORM_RUN_HEADERS },
  "Query Metrics": { name: "QueryMetricsTable", headers: QUERY_METRIC_HEADERS },
  "Eligibility Review": { name: "EligibilityReviewTable", headers: ELIGIBILITY_REVIEW_HEADERS },
  "Lead Monitor": { name: "LeadMonitorTable", headers: LEAD_MONITOR_HEADERS },
  "Application Outcomes": { name: "ApplicationOutcomesTable", headers: APPLICATION_OUTCOME_HEADERS },
  "Action Dashboard": { name: "ActionDashboardTable", headers: ACTION_DASHBOARD_HEADERS },
});

const DETAIL_SHEET_TABLES = Object.freeze(["Leads", "Applications", "Scan Log"]);

function referencedDetailSheets(workbook) {
  const references = new Set();
  for (const sheetName of DETAIL_SHEET_TABLES) {
    const expected = TRACKER_TABLES[sheetName];
    const detailSheetIndex = expected.headers.indexOf("Detail Sheet");
    const sheet = workbook.worksheets.items.find((item) => item.name === sheetName);
    const table = sheet?.tables.items.find((item) => item.name === expected.name);
    if (!table || detailSheetIndex < 0) continue;
    for (const row of table.getDataRows()) {
      const name = String(row[detailSheetIndex] ?? "").trim();
      if (name) references.add(name);
    }
  }
  return references;
}

export function inspectTrackerContract(workbook) {
  const actualSheets = workbook.worksheets.items.map((sheet) => sheet.name);
  const missingSheets = TRACKER_SHEETS.filter((name) => !actualSheets.includes(name));
  const detailSheetReferences = referencedDetailSheets(workbook);
  const detailSheets = actualSheets.filter((name) => !TRACKER_SHEETS.includes(name) && detailSheetReferences.has(name));
  const missingDetailSheets = [...detailSheetReferences].filter((name) => !actualSheets.includes(name));
  const extraSheets = actualSheets.filter((name) => !TRACKER_SHEETS.includes(name) && !detailSheetReferences.has(name));
  const tableErrors = [];
  for (const [sheetName, expected] of Object.entries(TRACKER_TABLES)) {
    const sheet = workbook.worksheets.items.find((item) => item.name === sheetName);
    if (!sheet) continue;
    const table = sheet.tables.items.find((item) => item.name === expected.name);
    if (!table) {
      tableErrors.push(`${sheetName}: missing ${expected.name}`);
      continue;
    }
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== expected.headers.join("\u0000")) {
      tableErrors.push(`${sheetName}: ${expected.name} headers do not match`);
    }
  }
  return {
    valid: missingSheets.length === 0 && missingDetailSheets.length === 0 && extraSheets.length === 0 && tableErrors.length === 0,
    sheet_count: actualSheets.length,
    core_sheet_count: TRACKER_SHEETS.length,
    detail_sheet_count: detailSheets.length,
    missing_sheets: missingSheets,
    missing_detail_sheets: missingDetailSheets,
    extra_sheets: extraSheets,
    table_errors: tableErrors,
  };
}
