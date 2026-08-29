const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const LIGHT_GRAY = "#F3F6F8";
const BORDER = "#D9E2F3";
const TEXT = "#262626";

export const FORM_RUN_HEADERS = [
  "Form ID", "Lead ID", "Captured At", "Step", "Step Title", "Company", "Role / Title", "ATS", "Form URL",
  "Canonical Job URL", "Fields Found", "Ready", "Needs Input", "Manual", "Cover Letter Requirement",
  "Cover Letter Status", "Packet Path", "Review Status", "Last Updated",
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

function updateDashboardCommands(workbook) {
  const dashboard = existingSheet(workbook, "Dashboard");
  if (!dashboard) return;
  dashboard.getRange("A34:H35").values = [[
    "Commands: shortlist L-…  |  dismiss L-…  |  prepare L-…  |  tailor L-…  |  form L-…  |  applied L-…  |  outcome L-…\n" +
    "Action Dashboard tracks manual work. Tailoring and form inspection are evidence-backed; submission remains manual.",
  ]];
  dashboard.getRange("A34:H35").format = {
    fill: LIGHT_GRAY,
    font: { name: "Arial", size: 10, italic: true, color: "#595959" },
    wrapText: true,
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: BORDER },
  };
}

export function ensureFormRunsSheet(workbook) {
  let sheet = existingSheet(workbook, "Form Runs");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Form Runs");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:S1");
    title.merge();
    title.values = [["Form Runs"]];
    title.format = {
      fill: NAVY,
      font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" },
      verticalAlignment: "center",
    };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:S2");
    subtitle.merge();
    subtitle.values = [["One row per inspected application-form step. Full answers remain in private, Git-ignored packets; no form is submitted automatically."]];
    subtitle.format = {
      fill: PALE_BLUE,
      font: { name: "Arial", size: 9, italic: true, color: "#595959" },
      verticalAlignment: "center",
      wrapText: true,
    };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:S3").values = [FORM_RUN_HEADERS];
    sheet.getRange("A3:S3").format = {
      fill: NAVY,
      font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      wrapText: true,
      borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:S3").format.rowHeight = 34;
    sheet.getRange("A4:S4").values = [Array(FORM_RUN_HEADERS.length).fill(null)];
    sheet.getRange("A4:S4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:S4", true, "FormRunsTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyFormRunRowRules(sheet, 4);
    setWidths(sheet, [24, 18, 19, 10, 24, 22, 32, 18, 38, 38, 12, 10, 12, 10, 22, 28, 42, 20, 19]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "FormRunsTable");
    if (!table) throw new Error("Form Runs exists but FormRunsTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== FORM_RUN_HEADERS.join("\u0000")) {
      throw new Error("FormRunsTable headers do not match the current schema");
    }
  }
  updateDashboardCommands(workbook);
  return { sheet, table: sheet.tables.items.find((item) => item.name === "FormRunsTable"), changed };
}

export function applyFormRunRowRules(sheet, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 4) throw new Error("Form Runs row number must be at least 4");
  sheet.getRange(`C${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`S${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`K${rowNumber}:N${rowNumber}`).setNumberFormat("0");
  sheet.getRange(`O${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Required", "Optional", "Absent", "Unclear"] } };
  sheet.getRange(`R${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Ready", "Needs User Input"] } };
}

export function upsertFormRun({ sheet, table, values }) {
  if (!Array.isArray(values) || values.length !== FORM_RUN_HEADERS.length) throw new Error("Form Runs row has invalid width");
  const rows = table.getDataRows();
  const index = rows.findIndex((row) => String(row[0] ?? "") === String(values[0] ?? ""));
  let rowNumber;
  let outcome;
  if (index >= 0) {
    rowNumber = 4 + index;
    sheet.getRange(`A${rowNumber}:S${rowNumber}`).values = [values];
    outcome = "Updated";
  } else {
    table.rows.add(null, [values]);
    rowNumber = 3 + table.getDataRows().length;
    const rowRange = sheet.getRange(`A${rowNumber}:S${rowNumber}`);
    rowRange.format = BODY_FORMAT;
    rowRange.format.rowHeight = 48;
    outcome = "Added";
  }
  applyFormRunRowRules(sheet, rowNumber);
  return { rowNumber, outcome };
}
