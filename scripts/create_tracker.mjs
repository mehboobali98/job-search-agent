import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { ensureFormRunsSheet } from "./form_runs_sheet.mjs";
import { resolveXlsxWorkbookPath } from "./workbook_io.mjs";

const NAVY = "#1F3864";
const PALE_BLUE = "#D9EAF7";
const LIGHT_BLUE = "#EAF1F8";
const LIGHT_GRAY = "#F3F6F8";
const BORDER = "#D9E2F3";
const GREEN = "#E2F0D9";
const AMBER = "#FFF2CC";
const RED = "#FCE4D6";
const TEXT = "#262626";

export const LEAD_HEADERS = [
  "Lead ID", "First Seen", "Last Seen", "Company", "Role / Title", "Location", "Work Type", "Source",
  "Canonical URL", "Job ID", "Posted Date", "Eligibility", "Eligibility Evidence", "Confidence", "Best Resume",
  "Responsibilities", "Technical", "Seniority", "Evidence", "Domain", "Location Fit", "Compensation", "Final Score",
  "Recommendation", "Key Strengths", "Critical Gaps", "Status", "Last Alerted", "Canonical Key", "Description Hash",
  "Run ID", "Judge Status", "Unsupported Evidence", "Notes", "Next Action", "Detail Sheet", "Legacy Source Row",
];

export const APPLICATION_HEADERS = [
  "Lead ID", "Date Applied", "Company", "Role / Title", "Location", "Work Type", "Resume Version", "Source / Platform",
  "Job Posting URL", "Salary Range (Posted)", "Salary Expectation Given", "Status", "Next Follow-up", "Notes",
  "Match Score (/100)", "Critical Gaps", "Recommended Resume Improvements", "Cover Letter", "LinkedIn Outreach",
  "Interview Prep Status", "Current Stage", "Next Action", "Last Updated", "Eligibility", "Confidence", "Canonical Key",
  "Run ID", "Detail Sheet", "Legacy Source Row",
];

export const SCAN_HEADERS = [
  "Run ID", "Examined At", "Canonical Key", "Company", "Role / Title", "Canonical URL", "Outcome", "Reason",
  "Finder", "Preliminary Score", "Judge Score", "Eligibility", "Confidence", "Description Hash", "Source", "Job ID",
  "Location", "Work Type", "First Seen", "Last Seen", "Destination", "Detail Sheet", "Legacy Source Row", "Legacy Payload",
];

export const RUN_HEADERS = [
  "Run ID", "Started At", "Completed At", "Status", "Backend Finder", "AI/Product Finder", "Judge", "Queries",
  "Found", "Unique", "Evaluated", "Judged", "Leads Added", "Applications Migrated", "Suppressed", "Alerts", "Errors", "Notes",
];

function styleTitle(sheet, endColumn, title, subtitle) {
  sheet.showGridLines = false;
  const titleRange = sheet.getRange("A1:" + endColumn + "1");
  titleRange.merge();
  titleRange.values = [[title]];
  titleRange.format = {
    fill: NAVY,
    font: { name: "Arial", size: 14, bold: true, color: "#FFFFFF" },
    verticalAlignment: "center",
  };
  titleRange.format.rowHeight = 28;
  const subtitleRange = sheet.getRange("A2:" + endColumn + "2");
  subtitleRange.merge();
  subtitleRange.values = [[subtitle]];
  subtitleRange.format = {
    fill: PALE_BLUE,
    font: { name: "Arial", size: 9, italic: true, color: "#595959" },
    verticalAlignment: "center",
    wrapText: true,
  };
  subtitleRange.format.rowHeight = 30;
}

function styleHeader(range) {
  range.format = {
    fill: NAVY,
    font: { name: "Arial", size: 9, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: BORDER },
  };
  range.format.rowHeight = 34;
}

function styleBody(range) {
  range.format = {
    font: { name: "Arial", size: 9, color: TEXT },
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: "#E6EAF0" },
  };
}

function writeEmptyTable(sheet, headers, tableName, endColumn, subtitle) {
  styleTitle(sheet, endColumn, sheet.name, subtitle);
  sheet.getRange("A3:" + endColumn + "3").values = [headers];
  styleHeader(sheet.getRange("A3:" + endColumn + "3"));
  sheet.getRange("A4:" + endColumn + "4").values = [Array(headers.length).fill(null)];
  styleBody(sheet.getRange("A4:" + endColumn + "4"));
  const table = sheet.tables.add("A3:" + endColumn + "4", true, tableName);
  table.style = "TableStyleMedium2";
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(3);
}

function setWidths(sheet, widths) {
  for (let index = 0; index < widths.length; index += 1) sheet.getCell(2, index).format.columnWidth = widths[index];
}

export async function createTracker({ outputPath, candidateName, timezone, targetGeography }) {
  outputPath = resolveXlsxWorkbookPath(outputPath, "Tracker output path");
  const workbook = Workbook.create();
  const dashboard = workbook.worksheets.add("Dashboard");
  const configSheet = workbook.worksheets.add("Search Config");
  const leadsSheet = workbook.worksheets.add("Leads");
  const applicationsSheet = workbook.worksheets.add("Applications");
  const scanSheet = workbook.worksheets.add("Scan Log");
  const runSheet = workbook.worksheets.add("Run Log");

  styleTitle(configSheet, "F", "Search Config", "Edit blue input cells to tune discovery. All agents and the deterministic updater must honor these values.");
  configSheet.getRange("A4:B4").values = [["Run Limits", "Value"]];
  styleHeader(configSheet.getRange("A4:B4"));
  configSheet.getRange("A5:B13").values = [
    ["Schedule", "Weekdays at 08:00 " + timezone],
    ["Maximum searches", 12],
    ["Maximum unique candidates", 40],
    ["Maximum deep evaluations", 20],
    ["Maximum judged candidates", 10],
    ["Maximum alerts", 5],
    ["Alert threshold", 80],
    ["Lead threshold", 60],
    ["Judge threshold", 70],
  ];
  styleBody(configSheet.getRange("A5:B13"));
  configSheet.getRange("B5:B13").format.fill = LIGHT_BLUE;
  configSheet.getRange("D4:E4").values = [["Role Profile", "Allocation"]];
  styleHeader(configSheet.getRange("D4:E4"));
  configSheet.getRange("D5:E9").values = [
    ["Backend / Platform", 0.5],
    ["Staff / Principal / Tech Lead", 0.2],
    ["Applied AI / LLM", 0.15],
    ["Developer Productivity / AI Enablement", 0.1],
    ["Full-stack / Product", 0.05],
  ];
  styleBody(configSheet.getRange("D5:E9"));
  configSheet.getRange("E5:E9").setNumberFormat("0%");
  configSheet.getRange("E5:E9").format.fill = LIGHT_BLUE;
  configSheet.getRange("A14:B14").values = [["Score Component", "Maximum"]];
  styleHeader(configSheet.getRange("A14:B14"));
  configSheet.getRange("A15:B21").values = [
    ["Core responsibilities", 25], ["Technical fit and transferability", 20], ["Seniority and scope", 15],
    ["Strength of verified evidence", 15], ["Domain and product fit", 10],
    ["Location, sponsorship, and work model", 10], ["Compensation alignment", 5],
  ];
  styleBody(configSheet.getRange("A15:B21"));
  configSheet.getRange("B15:B21").format.fill = LIGHT_GRAY;
  configSheet.getRange("D14:F14").values = [["Policy", "Rule", "Effect"]];
  styleHeader(configSheet.getRange("D14:F14"));
  configSheet.getRange("D15:F21").values = [
    ["Geography", targetGeography, "Include"],
    ["Explicit country restriction", "Unsupported country with no relocation path", "Suppress"],
    ["Existing work authorization required", "Sponsorship unavailable", "Suppress"],
    ["Sponsorship unclear", "Otherwise strong role", "Include and flag Unclear"],
    ["Compensation missing", "No published range", "Use neutral 3/5"],
    ["Canonical source", "Employer page preferred", "Required for High confidence"],
    ["Applications", "No automatic submission or outreach", "Manual only"],
  ];
  styleBody(configSheet.getRange("D15:F21"));
  configSheet.getRange("A24:C24").values = [["Validation List", "Allowed Values", "Notes"]];
  styleHeader(configSheet.getRange("A24:C24"));
  configSheet.getRange("A25:C30").values = [
    ["Eligibility", "Eligible | Unclear | Ineligible | Needs Human Review | Needs Judge", "Hard blockers never alert"],
    ["Confidence", "High | Medium | Low", "Only High/Medium can alert"],
    ["Lead Status", "New | Review | Shortlisted | Preparing | Dismissed | Expired | Moved to Applications", "User-controlled workflow"],
    ["Judge Status", "Judged | Needs Judge | Failed", "Only Judged can alert"],
    ["Application Status", "Draft | Applied | Submitted | Skipped | Screening | Interview | Offer | Rejected | Withdrawn", "Manual pipeline"],
    ["Current Stage", "Interested | Evaluating | Preparing | Applied | Recruiter Screen | Assessment | Technical | System Design | Hiring Manager | Final | Offer | Rejected | Withdrawn | Ghosted | Accepted | Not applying", "Manual pipeline"],
  ];
  styleBody(configSheet.getRange("A25:C30"));
  configSheet.freezePanes.freezeRows(2);
  configSheet.getRange("A1:F30").format.font.name = "Arial";
  setWidths(configSheet, [34, 31, 27, 34, 27, 30]);

  writeEmptyTable(leadsSheet, LEAD_HEADERS, "LeadsTable", "AK", "Viable, deduplicated discoveries scoring at least the configured lead threshold.");
  writeEmptyTable(applicationsSheet, APPLICATION_HEADERS, "ApplicationsTable", "AC", "Shortlisted, preparing, submitted, and applied roles. Application submission remains manual.");
  writeEmptyTable(scanSheet, SCAN_HEADERS, "ScanLogTable", "X", "Append-only audit log for every examined, duplicate, rejected, and suppressed role.");
  writeEmptyTable(runSheet, RUN_HEADERS, "RunLogTable", "R", "One row per orchestration run, including partial and failed runs.");

  leadsSheet.getRange("B4:C203").setNumberFormat("yyyy-mm-dd");
  leadsSheet.getRange("K4:K203").setNumberFormat("yyyy-mm-dd");
  leadsSheet.getRange("AB4:AB203").setNumberFormat("yyyy-mm-dd hh:mm");
  leadsSheet.getRange("P4:W203").setNumberFormat("0");
  applicationsSheet.getRange("B4:B203").setNumberFormat("yyyy-mm-dd");
  applicationsSheet.getRange("M4:M203").setNumberFormat("yyyy-mm-dd");
  applicationsSheet.getRange("W4:W203").setNumberFormat("yyyy-mm-dd hh:mm");
  applicationsSheet.getRange("O4:O203").setNumberFormat("0");
  scanSheet.getRange("B4:B203").setNumberFormat("yyyy-mm-dd hh:mm");
  scanSheet.getRange("S4:T203").setNumberFormat("yyyy-mm-dd");
  runSheet.getRange("B4:C203").setNumberFormat("yyyy-mm-dd hh:mm");
  runSheet.getRange("H4:P203").setNumberFormat("0");

  leadsSheet.getRange("L4:L203").dataValidation = { rule: { type: "list", values: ["Eligible", "Unclear", "Ineligible", "Needs Human Review", "Needs Judge"] } };
  leadsSheet.getRange("N4:N203").dataValidation = { rule: { type: "list", values: ["High", "Medium", "Low"] } };
  leadsSheet.getRange("O4:O203").dataValidation = { rule: { type: "list", values: ["Backend / Platform", "Staff / Principal / Tech Lead", "Applied AI / LLM", "Developer Productivity / AI Enablement", "Full-stack / Product"] } };
  leadsSheet.getRange("AA4:AA203").dataValidation = { rule: { type: "list", values: ["New", "Review", "Shortlisted", "Preparing", "Dismissed", "Expired", "Moved to Applications"] } };
  leadsSheet.getRange("AF4:AF203").dataValidation = { rule: { type: "list", values: ["Judged", "Needs Judge", "Legacy / unjudged", "Failed"] } };
  applicationsSheet.getRange("G4:G203").dataValidation = { rule: { type: "list", values: ["Backend / Platform", "Staff / Principal / Tech Lead", "Applied AI / LLM", "Developer Productivity / AI Enablement", "Full-stack / Product"] } };
  applicationsSheet.getRange("L4:L203").dataValidation = { rule: { type: "list", values: ["Draft", "Applied", "Submitted", "Skipped", "Not needed", "Not generated", "Screening", "Interview", "Offer", "Rejected", "Withdrawn"] } };
  applicationsSheet.getRange("T4:T203").dataValidation = { rule: { type: "list", values: ["Not started", "Plan ready — not started", "In progress", "Ready", "Completed", "Not started — skipped"] } };
  applicationsSheet.getRange("U4:U203").dataValidation = { rule: { type: "list", values: ["Interested", "Evaluating", "Preparing", "Applied", "Recruiter Screen", "Assessment", "Technical", "System Design", "Hiring Manager", "Final", "Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted", "Not applying"] } };
  leadsSheet.getRange("W4:W203").conditionalFormats.add("colorScale", { colors: [RED, AMBER, GREEN], thresholds: ["min", "50%", "max"] });
  leadsSheet.getRange("L4:L203").conditionalFormats.add("containsText", { text: "Ineligible", format: { fill: RED, font: { color: "#9C0006" } } });
  leadsSheet.getRange("L4:L203").conditionalFormats.add("containsText", { text: "Unclear", format: { fill: AMBER, font: { color: "#7F6000" } } });
  leadsSheet.getRange("L4:L203").conditionalFormats.add("containsText", { text: "Eligible", format: { fill: GREEN, font: { color: "#375623" } } });
  setWidths(leadsSheet, [15,12,12,22,32,24,16,21,34,14,12,20,38,12,27,10,10,10,10,10,12,12,12,20,36,36,18,18,32,22,20,20,18,42,42,22,16]);
  setWidths(applicationsSheet, [15,12,22,32,24,16,27,21,34,20,22,16,14,42,12,36,38,24,24,24,18,42,18,20,12,32,20,22,16]);
  setWidths(scanSheet, [20,18,32,22,32,34,21,42,20,12,12,20,12,22,22,14,24,16,12,12,18,22,16,50]);
  setWidths(runSheet, [20,18,18,15,20,20,18,10,10,10,10,10,12,18,12,10,30,50]);

  dashboard.getRange("A1:H35").format.rowHeight = 18;
  styleTitle(dashboard, "H", "Job Search Dashboard — " + candidateName, "Only independently judged, eligible or unclear roles meeting the configured threshold appear in the priority queue.");
  const cards = [
    ["A4:B4", "Active Leads", "A5:B6", "=COUNTIFS('Leads'!$A$4:$A$203,\"<>\",'Leads'!$AA$4:$AA$203,\"<>Dismissed\",'Leads'!$L$4:$L$203,\"<>Ineligible\")"],
    ["C4:D4", "Priority Leads", "C5:D6", "=COUNTIFS('Leads'!$W$4:$W$203,\">=\"&'Search Config'!$B$11,'Leads'!$AF$4:$AF$203,\"Judged\",'Leads'!$L$4:$L$203,\"Eligible\",'Leads'!$AA$4:$AA$203,\"<>Dismissed\",'Leads'!$AA$4:$AA$203,\"<>Expired\")+COUNTIFS('Leads'!$W$4:$W$203,\">=\"&'Search Config'!$B$11,'Leads'!$AF$4:$AF$203,\"Judged\",'Leads'!$L$4:$L$203,\"Unclear\",'Leads'!$AA$4:$AA$203,\"<>Dismissed\",'Leads'!$AA$4:$AA$203,\"<>Expired\")"],
    ["E4:F4", "Applications", "E5:F6", "=COUNTIFS('Applications'!$A$4:$A$203,\"<>\")"],
    ["G4:H4", "Follow-ups Due", "G5:H6", "=COUNTIFS('Applications'!$A$4:$A$203,\"<>\",'Applications'!$M$4:$M$203,\"<=\"&TODAY(),'Applications'!$M$4:$M$203,\"<>\")"],
  ];
  for (const [labelRange, label, valueRange, formula] of cards) {
    const labelCell = dashboard.getRange(labelRange); labelCell.merge(); labelCell.values = [[label]];
    labelCell.format = { fill: PALE_BLUE, font: { name: "Arial", size: 10, bold: true, color: NAVY }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: BORDER } };
    const valueCell = dashboard.getRange(valueRange); valueCell.merge(); valueCell.formulas = [[formula]];
    valueCell.setNumberFormat("0");
    valueCell.format = { fill: "#FFFFFF", font: { name: "Arial", size: 20, bold: true, color: NAVY }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: BORDER } };
  }
  dashboard.getRange("A9:H9").values = [["Rank", "Company", "Role", "Score", "Best Resume", "Eligibility", "Status", "Canonical Link"]];
  styleHeader(dashboard.getRange("A9:H9"));
  for (let row = 10; row <= 14; row += 1) {
    dashboard.getRange("A" + row).values = [[row - 9]];
    const eligible = "('Leads'!$AF$4:$AF$203=\"Judged\")*('Leads'!$W$4:$W$203>='Search Config'!$B$11)*(('Leads'!$L$4:$L$203=\"Eligible\")+('Leads'!$L$4:$L$203=\"Unclear\"))*('Leads'!$AA$4:$AA$203<>\"Dismissed\")*('Leads'!$AA$4:$AA$203<>\"Expired\")";
    const scoreKeys = "('Leads'!$W$4:$W$203+((204-ROW('Leads'!$W$4:$W$203))/100000))";
    const targetKey = "LARGE(FILTER(" + scoreKeys + "," + eligible + "),$A" + row + ")";
    const position = "MATCH(" + targetKey + "," + scoreKeys + ",0)";
    for (const [column, source] of [["B","D"],["C","E"],["D","W"],["E","O"],["F","L"],["G","AA"],["H","I"]]) {
      dashboard.getRange(column + row).formulas = [["=IFERROR(INDEX('Leads'!$" + source + "$4:$" + source + "$203," + position + "),\"\")"]];
    }
  }
  styleBody(dashboard.getRange("A10:H14"));
  dashboard.getRange("A10:H14").format.rowHeight = 38;
  dashboard.getRange("D10:D14").setNumberFormat("0");
  dashboard.getRange("A18:B18").values = [["Recommendation", "Count"]];
  styleHeader(dashboard.getRange("A18:B18"));
  for (const [index, band] of ["Immediate priority", "Strong match", "Review", "Stretch/watchlist", "Needs Human Review"].entries()) {
    const row = 19 + index;
    dashboard.getRange("A" + row).values = [[band]];
    dashboard.getRange("B" + row).formulas = [["=COUNTIF('Leads'!$X$4:$X$203,A" + row + ")"]];
  }
  styleBody(dashboard.getRange("A19:B23"));
  const chart = dashboard.charts.add("bar", dashboard.getRange("A18:B23"));
  chart.title = "Leads by recommendation";
  chart.hasLegend = false;
  chart.setPosition("D18", "H31");
  dashboard.getRange("A34:H35").merge();
  dashboard.getRange("A34:H35").values = [["Commands: shortlist L-…  |  dismiss L-…  |  prepare L-…\nPreparing a lead starts the manual application-package workflow; it never submits an application."]];
  dashboard.getRange("A34:H35").format = { fill: LIGHT_GRAY, font: { name: "Arial", size: 10, italic: true, color: "#595959" }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: BORDER } };
  dashboard.freezePanes.freezeRows(2);
  setWidths(dashboard, [8,24,34,12,28,20,18,38]);
  ensureFormRunsSheet(workbook);

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "new tracker formula scan",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await (await SpreadsheetFile.exportXlsx(workbook)).save(outputPath);
  return { outputPath, sheets: workbook.worksheets.items.map((sheet) => sheet.name) };
}

async function main() {
  const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
  const config = await loadProjectConfig({ projectRoot, configPath: argumentValue(process.argv, "--config", ".job-search.local.json") });
  const outputPath = path.resolve(argumentValue(process.argv, "--output", config.trackerPath));
  const result = await createTracker({
    outputPath,
    candidateName: config.raw.candidate_name,
    timezone: config.raw.timezone,
    targetGeography: config.raw.target_geography,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
