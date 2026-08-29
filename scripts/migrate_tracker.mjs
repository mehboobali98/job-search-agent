import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { ensureFormRunsSheet, FORM_RUN_HEADERS } from "./form_runs_sheet.mjs";
import { ensureQueryMetricsSheet, QUERY_METRIC_HEADERS } from "./query_metrics_sheet.mjs";
import { ensureEligibilityReviewSheet, ELIGIBILITY_REVIEW_HEADERS } from "./eligibility_review_sheet.mjs";
import { ensureLeadMonitorSheet, LEAD_MONITOR_HEADERS } from "./lead_monitor_sheet.mjs";
import { ensureApplicationOutcomesSheet, APPLICATION_OUTCOME_HEADERS } from "./application_outcomes_sheet.mjs";
import { ACTION_DASHBOARD_HEADERS, refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import { argumentValue } from "./project_config.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook", process.argv[2]);
if (!workbookArgument) throw new Error("Usage: node scripts/migrate_tracker.mjs --workbook <xlsx> [--state-dir <dir>]");
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));
const tempPath = workbookTemporaryPath(workbookPath, "migration-tmp");
const pendingPath = path.join(stateDir, "pending-tracker-migration.json");
await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const { changed: formRunsChanged } = ensureFormRunsSheet(workbook);
  const { changed: queryMetricsChanged } = ensureQueryMetricsSheet(workbook);
  const { changed: eligibilityReviewChanged } = ensureEligibilityReviewSheet(workbook);
  const { changed: leadMonitorChanged } = ensureLeadMonitorSheet(workbook);
  const { changed: applicationOutcomesChanged } = ensureApplicationOutcomesSheet(workbook);
  const { changed: actionDashboardChanged } = refreshActionDashboard(workbook);
  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "tracker migration formula validation",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);
  await (await SpreadsheetFile.exportXlsx(workbook)).save(tempPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(tempPath));
  const table = verified.worksheets.getItem("Form Runs").tables.getItem("FormRunsTable");
  const headers = table.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (headers.join("\u0000") !== FORM_RUN_HEADERS.join("\u0000")) throw new Error("Form Runs migration verification failed");
  const queryMetricsTable = verified.worksheets.getItem("Query Metrics").tables.getItem("QueryMetricsTable");
  const queryMetricHeaders = queryMetricsTable.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (queryMetricHeaders.join("\u0000") !== QUERY_METRIC_HEADERS.join("\u0000")) throw new Error("Query Metrics migration verification failed");
  const eligibilityReviewTable = verified.worksheets.getItem("Eligibility Review").tables.getItem("EligibilityReviewTable");
  const eligibilityReviewHeaders = eligibilityReviewTable.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (eligibilityReviewHeaders.join("\u0000") !== ELIGIBILITY_REVIEW_HEADERS.join("\u0000")) throw new Error("Eligibility Review migration verification failed");
  const leadMonitorTable = verified.worksheets.getItem("Lead Monitor").tables.getItem("LeadMonitorTable");
  const leadMonitorHeaders = leadMonitorTable.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (leadMonitorHeaders.join("\u0000") !== LEAD_MONITOR_HEADERS.join("\u0000")) throw new Error("Lead Monitor migration verification failed");
  const applicationOutcomesTable = verified.worksheets.getItem("Application Outcomes").tables.getItem("ApplicationOutcomesTable");
  const applicationOutcomeHeaders = applicationOutcomesTable.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (applicationOutcomeHeaders.join("\u0000") !== APPLICATION_OUTCOME_HEADERS.join("\u0000")) throw new Error("Application Outcomes migration verification failed");
  const actionDashboardTable = verified.worksheets.getItem("Action Dashboard").tables.getItem("ActionDashboardTable");
  const actionDashboardHeaders = actionDashboardTable.getHeaderRowRange().values[0].map((value) => String(value ?? ""));
  if (actionDashboardHeaders.join("\u0000") !== ACTION_DASHBOARD_HEADERS.join("\u0000")) throw new Error("Action Dashboard migration verification failed");
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  await fs.rm(pendingPath, { force: true });
  console.log(JSON.stringify({
    migrated: formRunsChanged || queryMetricsChanged || eligibilityReviewChanged || leadMonitorChanged || applicationOutcomesChanged || actionDashboardChanged,
    workbook: workbookPath,
    form_runs_sheet: true,
    query_metrics_sheet: true,
    eligibility_review_sheet: true,
    lead_monitor_sheet: true,
    application_outcomes_sheet: true,
    action_dashboard_sheet: true,
  }, null, 2));
} catch (error) {
  try { await removeTemporaryWorkbook(tempPath, workbookPath); } catch { /* Keep the original workbook. */ }
  await fs.writeFile(pendingPath, JSON.stringify({
    workbook: workbookPath,
    error: String(error?.stack ?? error),
    created_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
}
