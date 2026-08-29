import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import { applicationStatusForOutcome, buildOutcomeCalibration, validateApplicationOutcome } from "./application_outcomes_lib.mjs";
import { appendApplicationOutcome, ensureApplicationOutcomesSheet } from "./application_outcomes_sheet.mjs";
import { normalizeText } from "./job_tracker_lib.mjs";
import { argumentValue } from "./project_config.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook");
const inputArgument = argumentValue(process.argv, "--input");
if (!workbookArgument || !inputArgument) throw new Error("Usage: node scripts/record_application_outcome.mjs --workbook <xlsx> --input <outcome.json> [--state-dir <dir>]");
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const inputPath = path.resolve(inputArgument);
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));
const event = validateApplicationOutcome(JSON.parse(await fs.readFile(inputPath, "utf8")));
const tempPath = workbookTemporaryPath(workbookPath, "outcome-tmp");
const pendingPath = path.join(stateDir, "pending-outcome-" + event.event_id.replace(/[^a-z0-9_-]/gi, "_") + ".json");
await fs.mkdir(stateDir, { recursive: true });

const STAGE_RANK = new Map([
  ["Interested", 0], ["Evaluating", 1], ["Preparing", 2], ["Applied", 3], ["Recruiter Screen", 4],
  ["Assessment", 5], ["Technical", 6], ["System Design", 7], ["Hiring Manager", 8], ["Final", 9],
  ["Offer", 10], ["Rejected", 11], ["Withdrawn", 11], ["Ghosted", 11], ["Accepted", 12], ["Not applying", 12],
]);

function appendOnce(value, sentence) {
  const current = normalizeText(value);
  return current.includes(sentence) ? current : [current, sentence].filter(Boolean).join(" ");
}

function eventNextAction(outcome, stage) {
  if (outcome === "Rejected" || outcome === "Ghosted") return "Record any useful feedback and close the application; do not infer a cause that was not provided.";
  if (outcome === "Withdrawn") return "Application withdrawn by user confirmation; no further action is scheduled.";
  if (outcome === "Offer") return "Review the offer terms and eligibility details manually before making a decision.";
  if (outcome === "Accepted") return "Accepted by user confirmation; close remaining follow-ups manually.";
  if (outcome === "Screening") return "Prepare evidence-backed examples for the recruiter screen.";
  if (outcome === "Interview") return `Prepare evidence-backed examples for the ${stage} stage.`;
  return "Follow up manually after the configured interval if there is no response.";
}

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const applicationsTable = applicationsSheet.tables.getItem("ApplicationsTable");
  const leadsTable = leadsSheet.tables.getItem("LeadsTable");
  const applications = applicationsTable.getDataRows();
  const applicationIndex = applications.findIndex((row) => String(row[0] ?? "").toLowerCase() === event.lead_id.toLowerCase());
  if (applicationIndex < 0) throw new Error("Application not found for outcome lead: " + event.lead_id);
  const lead = leadsTable.getDataRows().find((row) => String(row[0] ?? "").toLowerCase() === event.lead_id.toLowerCase());
  if (!lead) throw new Error("Lead not found for outcome: " + event.lead_id);
  const { sheet: outcomesSheet, table: outcomesTable } = ensureApplicationOutcomesSheet(workbook);
  if (outcomesTable.getDataRows().some((row) => String(row[0] ?? "") === event.event_id)) {
    console.log(JSON.stringify({ event_id: event.event_id, lead_id: event.lead_id, outcome: "Already recorded", application_changed: false }, null, 2));
    process.exit(0);
  }

  const application = applications[applicationIndex];
  const rowNumber = 4 + applicationIndex;
  const currentStage = normalizeText(application[20]) || "Preparing";
  const currentRank = STAGE_RANK.get(currentStage) ?? -1;
  const nextRank = STAGE_RANK.get(event.stage) ?? -1;
  const applicationChanged = nextRank >= currentRank;
  const now = new Date();
  if (applicationChanged) {
    applicationsSheet.getRange(`L${rowNumber}`).values = [[applicationStatusForOutcome(event.outcome)]];
    applicationsSheet.getRange(`U${rowNumber}:W${rowNumber}`).values = [[event.stage, eventNextAction(event.outcome, event.stage), now]];
    if (["Rejected", "Withdrawn", "Ghosted", "Accepted"].includes(event.outcome)) applicationsSheet.getRange(`M${rowNumber}`).values = [[null]];
  } else {
    applicationsSheet.getRange(`W${rowNumber}`).values = [[now]];
  }
  const note = `${event.outcome} recorded for ${event.occurred_at.slice(0, 10)}${event.reason_category ? ` (${event.reason_category})` : ""}.`;
  applicationsSheet.getRange(`N${rowNumber}`).values = [[appendOnce(application[13], note)]];

  const recorded = appendApplicationOutcome({
    sheet: outcomesSheet,
    table: outcomesTable,
    values: [
      event.event_id, event.lead_id, new Date(event.occurred_at), lead[3], lead[4], event.outcome, event.stage,
      event.reason_category, event.notes, true, lead[22], application[6], lead[28], now,
    ],
  });
  const actions = refreshActionDashboard(workbook, { asOf: now });
  const calibration = buildOutcomeCalibration(outcomesTable.getDataRows().map((row) => ({
    lead_id: row[1], outcome: row[5], final_score: row[10], resume_version: row[11],
  })));
  await (await SpreadsheetFile.exportXlsx(workbook)).save(tempPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(tempPath));
  const verifiedEvent = verified.worksheets.getItem("Application Outcomes").tables.getItem("ApplicationOutcomesTable").getDataRows()
    .find((row) => String(row[0] ?? "") === event.event_id);
  if (!verifiedEvent) throw new Error("Application outcome verification failed");
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  await fs.rm(pendingPath, { force: true });
  console.log(JSON.stringify({ event_id: event.event_id, lead_id: event.lead_id, outcome: recorded.outcome, application_changed: applicationChanged, actions, calibration }, null, 2));
} catch (error) {
  try { await removeTemporaryWorkbook(tempPath, workbookPath); } catch { /* Preserve the original workbook. */ }
  await fs.writeFile(pendingPath, JSON.stringify({ event, error: String(error?.stack ?? error), created_at: new Date().toISOString() }, null, 2) + "\n");
  throw error;
}
