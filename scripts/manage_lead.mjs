import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { argumentValue } from "./project_config.mjs";
import { appendStyledRow } from "./tracker_rows.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook");
const leadId = argumentValue(process.argv, "--lead-id");
const action = String(argumentValue(process.argv, "--action", "")).toLowerCase();

if (!workbookArgument || !leadId || !["shortlist", "dismiss", "prepare", "applied"].includes(action)) {
  throw new Error("Usage: node scripts/manage_lead.mjs --workbook <xlsx> --lead-id <ID> --action <shortlist|dismiss|prepare|applied> [--applied-at YYYY-MM-DD] [--follow-up-at YYYY-MM-DD] [--salary <text>] [--cover-letter <text>] [--state-dir <dir>]");
}
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));
const appliedAtArgument = argumentValue(process.argv, "--applied-at");
const followUpAtArgument = argumentValue(process.argv, "--follow-up-at");
const salaryArgument = argumentValue(process.argv, "--salary");
const coverLetterArgument = argumentValue(process.argv, "--cover-letter");

const now = new Date();
const tempPath = workbookTemporaryPath(workbookPath, "action-tmp");
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

const PRE_APPLICATION_STATUSES = new Set(["", "Draft", "Not generated"]);
const PRE_APPLICATION_STAGES = new Set(["", "Interested", "Evaluating", "Preparing"]);

function shouldTransitionToApplied(application) {
  return PRE_APPLICATION_STATUSES.has(compactText(application[11]))
    && PRE_APPLICATION_STAGES.has(compactText(application[20]));
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
    if (action === "prepare") {
      leadsSheet.getRange("AI" + excelRow).values = [["Prepare manual application package"]];
    }
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
      appendStyledRow(applicationsTable, applicationsSheet, values, "AC", {
        numberFormats: { B: "yyyy-mm-dd", M: "yyyy-mm-dd", O: "0", W: "yyyy-mm-dd hh:mm" },
        validations: {
          G: ["Backend / Platform", "Staff / Principal / Tech Lead", "Applied AI / LLM", "Developer Productivity / AI Enablement", "Full-stack / Product"],
          L: ["Draft", "Applied", "Submitted", "Skipped", "Not needed", "Not generated", "Screening", "Interview", "Offer", "Rejected", "Withdrawn"],
          T: ["Not started", "Plan ready — not started", "In progress", "Ready", "Completed", "Not started — skipped"],
          U: ["Interested", "Evaluating", "Preparing", "Applied", "Recruiter Screen", "Assessment", "Technical", "System Design", "Hiring Manager", "Final", "Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted", "Not applying"],
        },
      });
      applicationChanged = true;
    }
  }

  let applicationStatus = null;
  let applicationStage = null;
  let appliedAt = null;
  let followUpAt = null;
  if (action === "applied") {
    const applicationRows = applicationsTable.getDataRows();
    const existingIndex = applicationRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
    if (existingIndex < 0) throw new Error("Application not found for lead: " + leadId + ". Run prepare first.");
    const existing = applicationRows[existingIndex];
    const rowNumber = 4 + existingIndex;
    const firstAppliedTransition = shouldTransitionToApplied(existing);
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
    applicationStatus = firstAppliedTransition ? "Applied" : (compactText(existing[11]) || null);
    applicationStage = firstAppliedTransition ? "Applied" : (compactText(existing[20]) || null);
  }

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(tempPath);
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
  console.log(JSON.stringify({
    lead_id: lead[0],
    action,
    lead_status: nextStatus,
    application_status: applicationStatus,
    application_stage: applicationStage,
    application_changed: applicationChanged,
    applied_at: appliedAt ? dateLabel(appliedAt) : null,
    follow_up_at: followUpAt ? dateLabel(followUpAt) : null,
  }, null, 2));
} catch (error) {
  try {
    await removeTemporaryWorkbook(tempPath, workbookPath);
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
