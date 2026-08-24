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
const appliedAtArgument = argument("--applied-at");
const followUpAtArgument = argument("--follow-up-at");
const salaryArgument = argument("--salary");
const coverLetterArgument = argument("--cover-letter");

if (!workbookPath || !leadId || !["shortlist", "dismiss", "prepare", "applied"].includes(action)) {
  throw new Error("Usage: node scripts/manage_lead.mjs --workbook <xlsx> --lead-id <ID> --action <shortlist|dismiss|prepare|applied> [--applied-at YYYY-MM-DD] [--follow-up-at YYYY-MM-DD] [--salary <text>] [--cover-letter <text>] [--state-dir <dir>]");
}

const now = new Date();
const tempPath = workbookPath.replace(/\.xlsx$/i, ".tmp.xlsx");
const pendingPath = path.join(stateDir, "pending-action-" + leadId.replace(/[^a-z0-9_-]/gi, "_") + "-" + action + ".json");
await fs.mkdir(stateDir, { recursive: true });

function compactText(value) {
  return String(value ?? "").trim();
}

function optionalDate(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(label + " must use YYYY-MM-DD");
  const parsed = new Date(value + "T12:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(label + " is not a valid date");
  return parsed;
}

function plusDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function workbookDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(Math.round((value - 25569) * 86400000));
  if (compactText(value)) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

function dateLabel(date) {
  return date.toISOString().slice(0, 10);
}

function appendOnce(value, sentence) {
  const current = compactText(value);
  if (current.includes(sentence)) return current;
  return [sentence, current].filter(Boolean).join(" ");
}

function joinApplicationNotes(lead) {
  return [
    `Recommended for manual preparation at ${lead[22]}/100 (${lead[23]}).`,
    `Eligibility: ${lead[11]}. ${compactText(lead[12])}`,
    compactText(lead[24]) ? `Evidence-backed strengths: ${compactText(lead[24])}` : "",
    compactText(lead[33]),
  ].filter(Boolean).join(" ");
}

function resumeGuidance(lead) {
  return [
    `Use the ${lead[14]} resume for this application.`,
    compactText(lead[24]) ? `Emphasize these verified strengths: ${compactText(lead[24])}` : "",
    compactText(lead[25]) ? `Address these gaps honestly: ${compactText(lead[25])}` : "",
  ].filter(Boolean).join(" ");
}

function preparationAction(lead) {
  return [
    `Tailor the ${lead[14]} resume for this role.`,
    compactText(lead[34]),
    "Inspect the live application form and draft evidence-backed answers. Generate a cover letter only if the form requires one; prepare outreach and interview guidance separately.",
  ].filter(Boolean).join(" ");
}

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
  const repeatedApplicationAction = ["prepare", "applied"].includes(action) && String(lead[26] ?? "") === "Moved to Applications";
  if (!repeatedApplicationAction) {
    leadsSheet.getRange("AA" + excelRow).values = [[nextStatus]];
    leadsSheet.getRange("AI" + excelRow).values = [[action === "prepare" ? "Prepare manual application package" : null]];
  }

  let applicationChanged = false;
  if (action === "prepare") {
    const applicationRows = applicationsTable.getDataRows();
    const existingIndex = applicationRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
    const values = [
      lead[0], null, lead[3], lead[4], lead[5], lead[6], lead[14], lead[7], lead[8], null, null,
      "Draft", null, joinApplicationNotes(lead), lead[22], lead[25], resumeGuidance(lead),
      "Not generated — package pending", "Not generated — package pending", "Not started",
      "Preparing", preparationAction(lead), now, lead[11], lead[13], lead[28], lead[30], lead[35], lead[36],
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
      const addedRowNumber = 3 + applicationsTable.getDataRows().length;
      const templateRowNumber = addedRowNumber === 5 ? 4 : (addedRowNumber % 2 === 0 ? 4 : 5);
      const addedRange = applicationsSheet.getRange(`A${addedRowNumber}:AC${addedRowNumber}`);
      addedRange.copyFrom(applicationsSheet.getRange(`A${templateRowNumber}:AC${templateRowNumber}`), "all");
      addedRange.values = [values];
      addedRange.format = {
        font: { name: "Arial", size: 9, color: "#262626" },
        verticalAlignment: "top",
        wrapText: true,
        borders: { preset: "all", style: "thin", color: "#E6EAF0" },
      };
      applicationsSheet.getRange(`B${addedRowNumber}`).setNumberFormat("yyyy-mm-dd");
      applicationsSheet.getRange(`M${addedRowNumber}`).setNumberFormat("yyyy-mm-dd");
      applicationsSheet.getRange(`W${addedRowNumber}`).setNumberFormat("yyyy-mm-dd hh:mm");
      addedRange.format.autofitRows();
      applicationChanged = true;
    }
  }

  let applicationStatus = null;
  let appliedAt = null;
  let followUpAt = null;
  if (action === "applied") {
    const applicationRows = applicationsTable.getDataRows();
    const existingIndex = applicationRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
    if (existingIndex < 0) throw new Error("Application not found for lead: " + leadId + ". Run prepare first.");
    const existing = applicationRows[existingIndex];
    const rowNumber = 4 + existingIndex;
    const firstAppliedTransition = compactText(existing[20]) !== "Applied" || compactText(existing[11]) !== "Applied";
    const requestedAppliedAt = optionalDate(appliedAtArgument, "--applied-at");
    const recordedDate = requestedAppliedAt ?? workbookDate(existing[1]) ?? now;
    appliedAt = requestedAppliedAt ?? (existing[1] ? null : now);
    followUpAt = optionalDate(followUpAtArgument, "--follow-up-at") ?? (firstAppliedTransition ? plusDays(recordedDate, 7) : null);
    if (appliedAt) applicationsSheet.getRange("B" + rowNumber).values = [[appliedAt]];
    if (salaryArgument !== null) applicationsSheet.getRange("K" + rowNumber).values = [[compactText(salaryArgument) || null]];
    if (coverLetterArgument !== null) applicationsSheet.getRange("R" + rowNumber).values = [[compactText(coverLetterArgument) || null]];
    if (firstAppliedTransition) {
      applicationsSheet.getRange("L" + rowNumber).values = [["Applied"]];
      if (followUpAt) applicationsSheet.getRange("M" + rowNumber).values = [[followUpAt]];
      applicationsSheet.getRange("N" + rowNumber).values = [[appendOnce(existing[13], `Application submitted ${dateLabel(recordedDate)}.`)]];
      applicationsSheet.getRange("U" + rowNumber + ":W" + rowNumber).values = [[
        "Applied",
        `Follow up after seven days if there is no response; continue interview preparation using the ${compactText(existing[6]) || compactText(lead[14])} resume evidence.`,
        now,
      ]];
      applicationChanged = true;
    } else if (appliedAt || followUpAt || salaryArgument !== null || coverLetterArgument !== null) {
      if (followUpAt) applicationsSheet.getRange("M" + rowNumber).values = [[followUpAt]];
      applicationsSheet.getRange("W" + rowNumber).values = [[now]];
      applicationChanged = true;
    }
    applicationStatus = "Applied";
  }

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(tempPath);
  await fs.rename(tempPath, workbookPath);
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
  console.log(JSON.stringify({
    lead_id: lead[0],
    action,
    lead_status: nextStatus,
    application_status: applicationStatus,
    application_changed: applicationChanged,
    applied_at: appliedAt ? dateLabel(appliedAt) : null,
    follow_up_at: followUpAt ? dateLabel(followUpAt) : null,
  }, null, 2));
} catch (error) {
  try {
    await fs.rm(tempPath, { force: true });
  } catch {
    // Preserve the action request even if a lock or conflicting path blocks cleanup.
  }
  await fs.writeFile(pendingPath, JSON.stringify({
    lead_id: leadId,
    action,
    applied_at: appliedAtArgument,
    follow_up_at: followUpAtArgument,
    salary: salaryArgument,
    cover_letter: coverLetterArgument,
    error: String(error?.stack ?? error),
    created_at: now.toISOString(),
  }, null, 2));
  throw error;
}
