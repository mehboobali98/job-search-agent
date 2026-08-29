import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import { normalizeUrl } from "./job_tracker_lib.mjs";
import { argumentValue } from "./project_config.mjs";
import { appendStyledRow } from "./tracker_rows.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook");
const inputArgument = argumentValue(process.argv, "--input");
if (!workbookArgument || !inputArgument) {
  throw new Error("Usage: node scripts/recheck_expiry.mjs --workbook <xlsx> --input <recheck.json> [--state-dir <dir>]");
}
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const inputPath = path.resolve(inputArgument);
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));

const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
function validDate(value) {
  return String(value ?? "").trim() && Number.isFinite(new Date(value).getTime());
}
if (!String(payload.run_id ?? "").trim() || !validDate(payload.started_at) || !validDate(payload.completed_at) || typeof payload.notes !== "string" || !Array.isArray(payload.checks)) {
  throw new Error("Recheck payload requires run_id, valid started_at/completed_at, notes, and checks[]");
}
if (new Date(payload.completed_at) < new Date(payload.started_at)) throw new Error("Recheck completed_at cannot precede started_at");
const now = new Date(payload.completed_at);
const tempPath = workbookTemporaryPath(workbookPath, "recheck-tmp");
const pendingPath = path.join(stateDir, "pending-" + payload.run_id.replace(/[^a-z0-9_-]/gi, "_") + ".json");
await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const scanSheet = workbook.worksheets.getItem("Scan Log");
  const runSheet = workbook.worksheets.getItem("Run Log");
  const leads = leadsSheet.tables.getItem("LeadsTable").getDataRows();
  const applications = applicationsSheet.tables.getItem("ApplicationsTable").getDataRows();
  const scanTable = scanSheet.tables.getItem("ScanLogTable");
  const runTable = runSheet.tables.getItem("RunLogTable");
  if (runTable.getDataRows().some((row) => String(row[0] ?? "") === payload.run_id)) {
    console.log(JSON.stringify({ run_id: payload.run_id, outcomes: [], already_committed: true }, null, 2));
    process.exit(0);
  }
  const outcomes = [];

  for (const check of payload.checks) {
    if (!check.lead_id || !["Active", "Expired"].includes(check.result) || !String(check.canonical_url ?? "").trim() || !String(check.evidence ?? "").trim()) {
      throw new Error("Each expiry check requires lead_id, result Active|Expired, canonical_url, and source-backed evidence");
    }
    const leadIndex = leads.findIndex((row) => String(row[0] ?? "").toLowerCase() === String(check.lead_id).toLowerCase());
    if (leadIndex < 0) throw new Error("Lead not found: " + check.lead_id);
    const lead = leads[leadIndex];
    if (normalizeUrl(check.canonical_url) !== normalizeUrl(lead[8])) {
      throw new Error("Expiry check canonical_url does not match lead " + check.lead_id);
    }
    const wasActive = !["Dismissed", "Expired"].includes(String(lead[26] ?? ""));
    const expired = check.result === "Expired";
    if (expired && wasActive) {
      leadsSheet.getRange("AA" + (4 + leadIndex)).values = [["Expired"]];
      leadsSheet.getRange("AI" + (4 + leadIndex)).values = [["Listing expired; stop application preparation"]];
      const applicationIndex = applications.findIndex((row) => String(row[0] ?? "").toLowerCase() === String(check.lead_id).toLowerCase());
      if (applicationIndex >= 0 && String(applications[applicationIndex][20] ?? "") === "Preparing") {
        const rowNumber = 4 + applicationIndex;
        const priorNotes = String(applications[applicationIndex][13] ?? "").trim();
        const expiryNote = "Expiry check " + now.toISOString().slice(0, 10) + ": listing is no longer active. " + String(check.evidence ?? "").trim();
        applicationsSheet.getRange("N" + rowNumber).values = [[priorNotes ? priorNotes + "\n\n" + expiryNote : expiryNote]];
        applicationsSheet.getRange("U" + rowNumber).values = [["Not applying"]];
        applicationsSheet.getRange("V" + rowNumber).values = [["Listing expired; stop preparation"]];
        applicationsSheet.getRange("W" + rowNumber).values = [[now]];
      }
    }

    const outcome = expired ? (wasActive ? "Expired" : "Expired / already inactive") : "Rechecked Active";
    appendStyledRow(scanTable, scanSheet, [
      payload.run_id, now, lead[28], lead[3], lead[4], check.canonical_url ?? lead[8], outcome,
      check.evidence ?? null, "Friday Recheck", null, lead[22], lead[11], lead[13], lead[29], lead[7], lead[9],
      lead[5], lead[6], lead[1], now, "Leads", lead[35], lead[36], JSON.stringify(check),
    ], "X", {
      numberFormats: { B: "yyyy-mm-dd hh:mm", S: "yyyy-mm-dd", T: "yyyy-mm-dd" },
      rowHeight: 54,
    });
    outcomes.push({ lead_id: lead[0], result: check.result, changed: expired && wasActive });
  }

  appendStyledRow(runTable, runSheet, [
    payload.run_id, new Date(payload.started_at), now, "Completed",
    "Friday Recheck", "Friday Recheck", "Not run", payload.checks.length, payload.checks.length,
    payload.checks.length, payload.checks.length, 0, 0, 0,
    outcomes.filter((item) => item.result === "Expired").length, 0, null, payload.notes,
  ], "R", {
    numberFormats: { B: "yyyy-mm-dd hh:mm", C: "yyyy-mm-dd hh:mm", "H:P": "0" },
  });

  const actions = refreshActionDashboard(workbook, { asOf: now });
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(tempPath);
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
  console.log(JSON.stringify({ run_id: payload.run_id, outcomes, actions }, null, 2));
} catch (error) {
  try {
    await removeTemporaryWorkbook(tempPath, workbookPath);
  } catch {
    // Preserve the recheck request even when a lock or conflicting path blocks cleanup.
  }
  await fs.writeFile(pendingPath, JSON.stringify({ payload, error: String(error?.stack ?? error) }, null, 2));
  throw error;
}
