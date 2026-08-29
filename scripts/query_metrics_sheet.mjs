const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const BORDER = "#D9E2F3";
const TEXT = "#262626";

export const QUERY_METRIC_HEADERS = [
  "Run ID", "Completed At", "Query ID", "Finder", "Source", "Lane", "Status", "Found", "Unique", "Evaluated",
  "Judged", "Eligible", "Reviewable", "Needs Review", "Priority", "Duplicates", "Hard Blocked", "Expired",
  "Inaccessible", "Shallow Rejected", "Unique Yield", "Evaluation Rate", "Priority Yield", "Error",
];

const BODY_FORMAT = {
  font: { name: "Arial", size: 9, color: TEXT },
  verticalAlignment: "top",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#E6EAF0" },
};

function existingSheet(workbook, name) {
  return workbook.worksheets.items.find((sheet) => sheet.name === name) ?? null;
}

function setWidths(sheet, widths) {
  for (let index = 0; index < widths.length; index += 1) sheet.getCell(2, index).format.columnWidth = widths[index];
}

export function applyQueryMetricRowRules(sheet, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 4) throw new Error("Query Metrics row number must be at least 4");
  sheet.getRange(`B${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`H${rowNumber}:T${rowNumber}`).setNumberFormat("0");
  sheet.getRange(`U${rowNumber}:W${rowNumber}`).setNumberFormat("0.0%");
  sheet.getRange(`G${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Completed", "Failed"] } };
}

export function ensureQueryMetricsSheet(workbook) {
  let sheet = existingSheet(workbook, "Query Metrics");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Query Metrics");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:X1");
    title.merge();
    title.values = [["Query Metrics"]];
    title.format = {
      fill: NAVY,
      font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" },
      verticalAlignment: "center",
    };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:X2");
    subtitle.merge();
    subtitle.values = [["One row per attempted discovery query. Metrics are derived deterministically from attributed candidates and scan events."]];
    subtitle.format = {
      fill: PALE_BLUE,
      font: { name: "Arial", size: 9, italic: true, color: "#595959" },
      verticalAlignment: "center",
      wrapText: true,
    };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:X3").values = [QUERY_METRIC_HEADERS];
    sheet.getRange("A3:X3").format = {
      fill: NAVY,
      font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      wrapText: true,
      borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:X3").format.rowHeight = 34;
    sheet.getRange("A4:X4").values = [Array(QUERY_METRIC_HEADERS.length).fill(null)];
    sheet.getRange("A4:X4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:X4", true, "QueryMetricsTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyQueryMetricRowRules(sheet, 4);
    setWidths(sheet, [22, 19, 32, 20, 20, 22, 14, 10, 10, 11, 10, 10, 12, 12, 10, 11, 13, 10, 12, 15, 12, 14, 12, 42]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "QueryMetricsTable");
    if (!table) throw new Error("Query Metrics exists but QueryMetricsTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== QUERY_METRIC_HEADERS.join("\u0000")) {
      throw new Error("QueryMetricsTable headers do not match the current schema");
    }
  }
  return { sheet, table: sheet.tables.items.find((item) => item.name === "QueryMetricsTable"), changed };
}
