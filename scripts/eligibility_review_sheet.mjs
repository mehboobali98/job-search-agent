const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const BORDER = "#D9E2F3";
const TEXT = "#262626";

export const ELIGIBILITY_REVIEW_HEADERS = [
  "Review ID", "Lead ID", "Run ID", "First Seen", "Last Updated", "Company", "Role / Title", "Final Score",
  "Eligibility", "Review Type", "Review Reason", "Eligibility Evidence", "Status", "Resolution", "Canonical URL",
  "Canonical Source", "Source Status", "Description Hash",
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

export function applyEligibilityReviewRowRules(sheet, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 4) throw new Error("Eligibility Review row number must be at least 4");
  sheet.getRange(`D${rowNumber}:E${rowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
  sheet.getRange(`H${rowNumber}`).setNumberFormat("0");
  sheet.getRange(`I${rowNumber}`).dataValidation = {
    rule: { type: "list", values: ["Eligible", "Unclear", "Ineligible", "Needs Human Review"] },
  };
  sheet.getRange(`M${rowNumber}`).dataValidation = { rule: { type: "list", values: ["Open", "Resolved", "Dismissed"] } };
}

export function ensureEligibilityReviewSheet(workbook) {
  let sheet = existingSheet(workbook, "Eligibility Review");
  let changed = false;
  if (!sheet) {
    sheet = workbook.worksheets.add("Eligibility Review");
    sheet.showGridLines = false;
    const title = sheet.getRange("A1:R1");
    title.merge();
    title.values = [["Eligibility Review"]];
    title.format = {
      fill: NAVY,
      font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" },
      verticalAlignment: "center",
    };
    title.format.rowHeight = 28;
    const subtitle = sheet.getRange("A2:R2");
    subtitle.merge();
    subtitle.values = [["Persistent inbox for strong roles that need human eligibility or evidence review. Status and Resolution are user-controlled."]];
    subtitle.format = {
      fill: PALE_BLUE,
      font: { name: "Arial", size: 9, italic: true, color: "#595959" },
      verticalAlignment: "center",
      wrapText: true,
    };
    subtitle.format.rowHeight = 30;
    sheet.getRange("A3:R3").values = [ELIGIBILITY_REVIEW_HEADERS];
    sheet.getRange("A3:R3").format = {
      fill: NAVY,
      font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
      horizontalAlignment: "center",
      verticalAlignment: "center",
      wrapText: true,
      borders: { preset: "all", style: "thin", color: BORDER },
    };
    sheet.getRange("A3:R3").format.rowHeight = 34;
    sheet.getRange("A4:R4").values = [Array(ELIGIBILITY_REVIEW_HEADERS.length).fill(null)];
    sheet.getRange("A4:R4").format = BODY_FORMAT;
    const table = sheet.tables.add("A3:R4", true, "EligibilityReviewTable");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
    sheet.freezePanes.freezeRows(3);
    applyEligibilityReviewRowRules(sheet, 4);
    setWidths(sheet, [22, 18, 22, 18, 18, 24, 34, 12, 20, 24, 42, 48, 14, 40, 38, 22, 22, 25]);
    changed = true;
  } else {
    const table = sheet.tables.items.find((item) => item.name === "EligibilityReviewTable");
    if (!table) throw new Error("Eligibility Review exists but EligibilityReviewTable is missing");
    const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
    if (headers.join("\u0000") !== ELIGIBILITY_REVIEW_HEADERS.join("\u0000")) {
      throw new Error("EligibilityReviewTable headers do not match the current schema");
    }
  }
  return { sheet, table: sheet.tables.items.find((item) => item.name === "EligibilityReviewTable"), changed };
}

export function syncEligibilityReview({ sheet, table, candidate, runId, now, shouldReview, reviewType, reviewReason, canonicalSource, sourceStatus }) {
  const rows = table.getDataRows();
  const index = rows.findIndex((row) => String(row[1] ?? "") === String(candidate.lead_id ?? ""));
  const existing = index >= 0 ? rows[index] : null;
  if (!shouldReview) {
    if (!existing || !["Eligible", "Ineligible"].includes(candidate.eligibility) || existing[12] !== "Open") return null;
    const values = [...existing];
    values[2] = runId;
    values[4] = now;
    values[8] = candidate.eligibility;
    values[12] = "Resolved";
    values[13] = `Eligibility resolved as ${candidate.eligibility} by run ${runId}.`;
    sheet.getRange(`A${4 + index}:R${4 + index}`).values = [values];
    applyEligibilityReviewRowRules(sheet, 4 + index);
    return { review_id: values[0], lead_id: candidate.lead_id, outcome: "Resolved" };
  }

  const values = [
    existing?.[0] ?? `REV-${candidate.lead_id}`,
    candidate.lead_id,
    runId,
    existing?.[3] ?? now,
    now,
    candidate.company,
    candidate.title,
    candidate.final_score,
    candidate.eligibility,
    reviewType,
    reviewReason,
    candidate.eligibility_evidence ?? null,
    existing?.[12] ?? "Open",
    existing?.[13] ?? null,
    candidate.canonical_url,
    canonicalSource,
    sourceStatus,
    candidate.description_hash,
  ];
  let rowNumber;
  let outcome;
  if (existing) {
    rowNumber = 4 + index;
    sheet.getRange(`A${rowNumber}:R${rowNumber}`).values = [values];
    outcome = "Updated";
  } else {
    table.rows.add(null, [values]);
    rowNumber = 3 + table.getDataRows().length;
    const rowRange = sheet.getRange(`A${rowNumber}:R${rowNumber}`);
    rowRange.format = BODY_FORMAT;
    rowRange.format.rowHeight = 54;
    outcome = "Added";
  }
  applyEligibilityReviewRowRules(sheet, rowNumber);
  return { review_id: values[0], lead_id: candidate.lead_id, outcome };
}
