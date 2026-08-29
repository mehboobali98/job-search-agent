import { OUTCOME_STAGES, OUTCOME_TYPES } from "./application_outcomes_lib.mjs";

const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const BORDER = "#D9E2F3";

export const APPLICATION_OUTCOME_HEADERS = [
  "Event ID", "Lead ID", "Occurred At", "Company", "Role / Title", "Outcome", "Stage", "Reason Category",
  "Notes", "User Confirmed", "Final Score at Event", "Resume Version", "Canonical Key", "Recorded At",
];

const BODY_FORMAT = {
  font: { name: "Arial", size: 9, color: "#262626" },
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

export function applyApplicationOutcomeRowRules(sheet, rowNumber) {
  sheet.getRange(`C${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`N${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`K${rowNumber}`).setNumberFormat("0");
  sheet.getRange(`F${rowNumber}`).dataValidation = { rule: { type: "list", values: [...OUTCOME_TYPES] } };
  sheet.getRange(`G${rowNumber}`).dataValidation = { rule: { type: "list", values: [...OUTCOME_STAGES] } };
}

export function ensureApplicationOutcomesSheet(workbook) {
  let sheet = existingSheet(workbook, "Application Outcomes");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Application Outcomes");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:N1");
    title.merge();
    title.values = [["Application Outcomes"]];
    title.format = { fill: NAVY, font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" }, verticalAlignment: "center" };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:N2");
    subtitle.merge();
    subtitle.values = [["Append-only, user-confirmed application events used for advisory calibration. Scoring policy is never rewritten automatically."]];
    subtitle.format = { fill: PALE_BLUE, font: { name: "Arial", size: 9, italic: true, color: "#595959" }, verticalAlignment: "center", wrapText: true };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:N3").values = [APPLICATION_OUTCOME_HEADERS];
    sheet.getRange("A3:N3").format = {
      fill: NAVY, font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center",
      verticalAlignment: "center", wrapText: true, borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:N3").format.rowHeight = 34;
    sheet.getRange("A4:N4").values = [Array(APPLICATION_OUTCOME_HEADERS.length).fill(null)];
    sheet.getRange("A4:N4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:N4", true, "ApplicationOutcomesTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyApplicationOutcomeRowRules(sheet, 4);
    setWidths(sheet, [26, 18, 19, 24, 34, 16, 22, 24, 48, 15, 15, 28, 34, 19]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "ApplicationOutcomesTable");
    if (!table) throw new Error("Application Outcomes exists but ApplicationOutcomesTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== APPLICATION_OUTCOME_HEADERS.join("\u0000")) throw new Error("ApplicationOutcomesTable headers do not match the current schema");
  }
  return { sheet, table: sheet.tables.getItem("ApplicationOutcomesTable"), changed };
}

export function appendApplicationOutcome({ sheet, table, values }) {
  if (values.length !== APPLICATION_OUTCOME_HEADERS.length) throw new Error("Application outcome row has invalid width");
  const existing = table.getDataRows().find((row) => String(row[0] ?? "") === String(values[0] ?? ""));
  if (existing) return { outcome: "Already recorded", event_id: values[0] };
  table.rows.add(null, [values]);
  const rowNumber = 3 + table.getDataRows().length;
  sheet.getRange(`A${rowNumber}:N${rowNumber}`).format = BODY_FORMAT;
  sheet.getRange(`A${rowNumber}:N${rowNumber}`).format.rowHeight = 48;
  applyApplicationOutcomeRowRules(sheet, rowNumber);
  return { outcome: "Recorded", event_id: values[0], row_number: rowNumber };
}
