const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const BORDER = "#D9E2F3";
const TEXT = "#262626";

export const LEAD_MONITOR_HEADERS = [
  "Monitor ID", "Lead ID", "Company", "Role / Title", "Canonical URL", "First Checked", "Last Checked",
  "Listing Status", "Location", "Work Type", "Description Hash", "Compensation Published", "Compensation",
  "Eligibility", "Eligibility Evidence", "Evidence IDs", "Change Types", "Change Summary", "Source Evidence", "Run ID",
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

export function applyLeadMonitorRowRules(sheet, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 4) throw new Error("Lead Monitor row number must be at least 4");
  sheet.getRange(`F${rowNumber}:G${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`H${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Active", "Expired", "Inaccessible"] } };
  sheet.getRange(`N${rowNumber}`).dataValidation = {
    rule: { type: "list", values: ["Eligible", "Unclear", "Ineligible", "Needs Human Review"] },
  };
}

export function ensureLeadMonitorSheet(workbook) {
  let sheet = existingSheet(workbook, "Lead Monitor");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Lead Monitor");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:T1");
    title.merge();
    title.values = [["Lead Monitor"]];
    title.format = {
      fill: NAVY,
      font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" },
      verticalAlignment: "center",
    };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:T2");
    subtitle.merge();
    subtitle.values = [["Latest source-backed snapshot for shortlisted and prepared roles. Material changes remain auditable in Scan Log."]];
    subtitle.format = {
      fill: PALE_BLUE,
      font: { name: "Arial", size: 9, italic: true, color: "#595959" },
      verticalAlignment: "center",
      wrapText: true,
    };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:T3").values = [LEAD_MONITOR_HEADERS];
    sheet.getRange("A3:T3").format = {
      fill: NAVY,
      font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      wrapText: true,
      borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:T3").format.rowHeight = 34;
    sheet.getRange("A4:T4").values = [Array(LEAD_MONITOR_HEADERS.length).fill(null)];
    sheet.getRange("A4:T4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:T4", true, "LeadMonitorTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyLeadMonitorRowRules(sheet, 4);
    setWidths(sheet, [22, 18, 24, 34, 38, 18, 18, 16, 26, 18, 26, 16, 28, 20, 44, 28, 30, 54, 48, 22]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "LeadMonitorTable");
    if (!table) throw new Error("Lead Monitor exists but LeadMonitorTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== LEAD_MONITOR_HEADERS.join("\u0000")) throw new Error("LeadMonitorTable headers do not match the current schema");
  }
  return { sheet, table: sheet.tables.items.find((item) => item.name === "LeadMonitorTable"), changed };
}

export function leadMonitorSnapshotFromRow(row) {
  return {
    listing_status: row[7],
    location: row[8],
    work_type: row[9],
    description_hash: row[10],
    compensation_published: row[11] === true ? true : row[11] === false ? false : null,
    compensation: row[12],
    eligibility: row[13],
    eligibility_evidence: row[14],
  };
}

export function upsertLeadMonitor({ sheet, table, lead, snapshot, evidenceIds, comparison, sourceEvidence, runId, now }) {
  const rows = table.getDataRows();
  const index = rows.findIndex((row) => String(row[1] ?? "") === String(lead[0] ?? ""));
  const existing = index >= 0 ? rows[index] : null;
  const values = [
    existing?.[0] ?? `MON-${lead[0]}`,
    lead[0],
    lead[3],
    lead[4],
    lead[8],
    existing?.[5] ?? now,
    now,
    snapshot.listing_status,
    snapshot.location,
    snapshot.work_type,
    snapshot.description_hash,
    snapshot.compensation_published,
    snapshot.compensation,
    snapshot.eligibility,
    snapshot.eligibility_evidence,
    evidenceIds.join(", ") || null,
    comparison.change_types.join(", ") || null,
    comparison.summary,
    sourceEvidence,
    runId,
  ];
  let rowNumber;
  let outcome;
  if (existing) {
    rowNumber = 4 + index;
    sheet.getRange(`A${rowNumber}:T${rowNumber}`).values = [values];
    outcome = "Updated";
  } else {
    table.rows.add(null, [values]);
    rowNumber = 3 + table.getDataRows().length;
    const range = sheet.getRange(`A${rowNumber}:T${rowNumber}`);
    range.format = BODY_FORMAT;
    range.format.rowHeight = 54;
    outcome = "Added";
  }
  applyLeadMonitorRowRules(sheet, rowNumber);
  return { monitor_id: values[0], lead_id: lead[0], outcome, row_number: rowNumber };
}
