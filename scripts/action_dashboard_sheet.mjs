import { deriveActionDashboard } from "./action_dashboard_lib.mjs";

const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const BORDER = "#D9E2F3";

export const ACTION_DASHBOARD_HEADERS = [
  "Action ID", "Priority", "Category", "Lead ID", "Company", "Role / Title", "Due Date", "Status", "Action",
  "Source Sheet", "Source ID", "Canonical URL", "Updated At",
];

const BODY_FORMAT = {
  font: { name: "Arial", size: 9, color: "#262626" }, verticalAlignment: "top", wrapText: true,
  borders: { preset: "all", style: "thin", color: "#E6EAF0" },
};

function existingSheet(workbook, name) {
  return workbook.worksheets.items.find((sheet) => sheet.name === name) ?? null;
}

function setWidths(sheet, widths) {
  for (let index = 0; index < widths.length; index += 1) sheet.getCell(2, index).format.columnWidth = widths[index];
}

export function applyActionDashboardRowRules(sheet, rowNumber) {
  sheet.getRange(`G${rowNumber}`).setNumberFormat("yyyy-mm-dd");
  sheet.getRange(`M${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`B${rowNumber}`).dataValidation = { rule: { type: "list", values: ["High", "Medium", "Low"] } };
  sheet.getRange(`H${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Open", "Resolved"] } };
}

export function ensureActionDashboardSheet(workbook) {
  let sheet = existingSheet(workbook, "Action Dashboard");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Action Dashboard");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:M1");
    title.merge();
    title.values = [["Action Dashboard"]];
    title.format = { fill: NAVY, font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" }, verticalAlignment: "center" };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:M2");
    subtitle.merge();
    subtitle.values = [["Derived queue for eligibility reviews, manual submissions, due follow-ups, and stale leads. All external actions remain manual."]];
    subtitle.format = { fill: PALE_BLUE, font: { name: "Arial", size: 9, italic: true, color: "#595959" }, verticalAlignment: "center", wrapText: true };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:M3").values = [ACTION_DASHBOARD_HEADERS];
    sheet.getRange("A3:M3").format = {
      fill: NAVY, font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center",
      verticalAlignment: "center", wrapText: true, borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:M3").format.rowHeight = 34;
    sheet.getRange("A4:M4").values = [Array(ACTION_DASHBOARD_HEADERS.length).fill(null)];
    sheet.getRange("A4:M4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:M4", true, "ActionDashboardTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyActionDashboardRowRules(sheet, 4);
    setWidths(sheet, [34, 12, 22, 18, 24, 34, 14, 14, 52, 20, 24, 38, 19]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "ActionDashboardTable");
    if (!table) throw new Error("Action Dashboard exists but ActionDashboardTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== ACTION_DASHBOARD_HEADERS.join("\u0000")) throw new Error("ActionDashboardTable headers do not match the current schema");
  }
  return { sheet, table: sheet.tables.getItem("ActionDashboardTable"), changed };
}

function actionValues(item) {
  return [item.action_id, item.priority, item.category, item.lead_id, item.company, item.role, item.due_date,
    item.status, item.action, item.source_sheet, item.source_id, item.canonical_url, item.updated_at];
}

export function refreshActionDashboard(workbook, { asOf = new Date() } = {}) {
  const { sheet, table, changed } = ensureActionDashboardSheet(workbook);
  const tableRows = (name, tableName) => {
    const source = existingSheet(workbook, name);
    return source?.tables.items.find((item) => item.name === tableName)?.getDataRows() ?? [];
  };
  const actions = deriveActionDashboard({
    leads: tableRows("Leads", "LeadsTable"),
    applications: tableRows("Applications", "ApplicationsTable"),
    eligibilityReviews: tableRows("Eligibility Review", "EligibilityReviewTable"),
    asOf,
  });
  const currentRows = table.getDataRows();
  const currentById = new Map(currentRows.map((row, index) => [String(row[0] ?? ""), { row, index }]).filter(([id]) => id));
  const activeIds = new Set(actions.map((item) => item.action_id));
  let added = 0;
  let updated = 0;
  let resolved = 0;
  for (const item of actions) {
    const existing = currentById.get(item.action_id);
    if (existing) {
      const rowNumber = 4 + existing.index;
      sheet.getRange(`A${rowNumber}:M${rowNumber}`).values = [actionValues(item)];
      applyActionDashboardRowRules(sheet, rowNumber);
      updated += 1;
    } else {
      table.rows.add(null, [actionValues(item)]);
      const rowNumber = 3 + table.getDataRows().length;
      sheet.getRange(`A${rowNumber}:M${rowNumber}`).format = BODY_FORMAT;
      sheet.getRange(`A${rowNumber}:M${rowNumber}`).format.rowHeight = 48;
      applyActionDashboardRowRules(sheet, rowNumber);
      added += 1;
    }
  }
  for (const { row, index } of currentById.values()) {
    if (activeIds.has(String(row[0])) || String(row[7] ?? "") !== "Open") continue;
    const rowNumber = 4 + index;
    const values = [...row];
    values[7] = "Resolved";
    values[12] = asOf;
    sheet.getRange(`A${rowNumber}:M${rowNumber}`).values = [values];
    applyActionDashboardRowRules(sheet, rowNumber);
    resolved += 1;
  }
  return { changed, open: actions.length, added, updated, resolved };
}
