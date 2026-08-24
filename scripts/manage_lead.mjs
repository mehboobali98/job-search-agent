import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const workbookPath = argument("--workbook");
const leadId = argument("--lead-id");
const action = String(argument("--action", "")).toLowerCase();
const stateDir = argument("--state-dir", path.join(path.dirname(workbookPath ?? "."), "state"));

if (!workbookPath || !leadId || !["shortlist", "dismiss", "prepare"].includes(action)) {
  throw new Error("Usage: node scripts/manage_lead.mjs --workbook <xlsx> --lead-id <ID> --action <shortlist|dismiss|prepare> [--state-dir <dir>]");
}

const now = new Date();
const tempPath = workbookPath.replace(/\.xlsx$/i, ".tmp.xlsx");
const pendingPath = path.join(stateDir, "pending-action-" + leadId.replace(/[^a-z0-9_-]/gi, "_") + "-" + action + ".json");
await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const leadsTable = leadsSheet.tables.items.find((table) => table.name === "LeadsTable");
  const applicationsTable = applicationsSheet.tables.items.find((table) => table.name === "ApplicationsTable");
  if (!leadsTable || !applicationsTable) throw new Error("Required tracker tables are missing");

  const leadRows = leadsTable.getDataRows();
  const leadIndex = leadRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
  if (leadIndex < 0) throw new Error("Lead not found: " + leadId);
  const lead = leadRows[leadIndex];
  const excelRow = 4 + leadIndex;
  const nextStatus = action === "shortlist" ? "Shortlisted" : action === "dismiss" ? "Dismissed" : "Moved to Applications";
  const repeatedPrepare = action === "prepare" && String(lead[26] ?? "") === "Moved to Applications";
  if (!repeatedPrepare) {
    leadsSheet.getRange("AA" + excelRow).values = [[nextStatus]];
    leadsSheet.getRange("AI" + excelRow).values = [[action === "prepare" ? "Prepare manual application package" : null]];
  }

  let applicationChanged = false;
  if (action === "prepare") {
    const applicationRows = applicationsTable.getDataRows();
    const existingIndex = applicationRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
    const values = [
      lead[0], null, lead[3], lead[4], lead[5], lead[6], lead[14], lead[7], lead[8], null, null,
      "Draft", null, lead[33], lead[22], lead[25], null, "Not generated", "Not generated", "Not started",
      "Preparing", "Prepare resume and application package", now, lead[11], lead[13], lead[28], lead[30], lead[35], lead[36],
    ];
    if (existingIndex >= 0) {
      const existing = applicationRows[existingIndex];
      const existingStage = String(existing[20] ?? "");
      if (["", "Interested", "Evaluating"].includes(existingStage)) {
        const rowNumber = 4 + existingIndex;
        applicationsSheet.getRange("U" + rowNumber + ":W" + rowNumber).values = [[
          "Preparing", "Prepare resume and application package", now,
        ]];
        applicationChanged = true;
      }
    } else {
      applicationsTable.rows.add(null, [values]);
      applicationChanged = true;
    }
  }

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(tempPath);
  await fs.rename(tempPath, workbookPath);
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
  console.log(JSON.stringify({ lead_id: lead[0], action, lead_status: nextStatus, application_changed: applicationChanged }, null, 2));
} catch (error) {
  try {
    await fs.rm(tempPath, { force: true });
  } catch {
    // Preserve the action request even if a lock or conflicting path blocks cleanup.
  }
  await fs.writeFile(pendingPath, JSON.stringify({ lead_id: leadId, action, error: String(error?.stack ?? error), created_at: now.toISOString() }, null, 2));
  throw error;
}
