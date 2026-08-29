import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { identifyCanonicalSource } from "./canonical_source_adapters.mjs";
import { ensureEligibilityReviewSheet, syncEligibilityReview } from "./eligibility_review_sheet.mjs";
import {
  assessEligibilityEvidence,
  eligibilityAssessmentText,
  loadEligibilityRegistry,
} from "./eligibility_evidence_lib.mjs";
import { normalizeText } from "./job_tracker_lib.mjs";
import { compareLeadSnapshots, leadSnapshotFromRow, validateLeadMonitorCheck } from "./lead_monitor_lib.mjs";
import { ensureLeadMonitorSheet, leadMonitorSnapshotFromRow, upsertLeadMonitor } from "./lead_monitor_sheet.mjs";
import { argumentValue } from "./project_config.mjs";
import { appendStyledRow } from "./tracker_rows.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook");
const inputArgument = argumentValue(process.argv, "--input");
const registryArgument = argumentValue(process.argv, "--eligibility-registry");
if (!workbookArgument || !inputArgument) {
  throw new Error("Usage: node scripts/monitor_leads.mjs --workbook <xlsx> --input <monitor.json> [--eligibility-registry <json>] [--state-dir <dir>]");
}
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const inputPath = path.resolve(inputArgument);
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));
const registryPath = registryArgument ? path.resolve(registryArgument) : null;
const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));

function validDate(value) {
  return normalizeText(value) && Number.isFinite(new Date(value).getTime());
}

if (!normalizeText(payload.run_id) || !validDate(payload.started_at) || !validDate(payload.completed_at)
  || new Date(payload.completed_at) < new Date(payload.started_at)
  || typeof payload.notes !== "string" || !Array.isArray(payload.checks)) {
  throw new Error("Monitor payload requires run_id, ordered timestamps, notes, and checks[]");
}
const leadIds = payload.checks.map((check) => String(check?.lead_id ?? "").toLowerCase());
if (new Set(leadIds).size !== leadIds.length) throw new Error("Monitor payload contains duplicate lead IDs");
const registry = registryPath ? await loadEligibilityRegistry(registryPath) : null;
const now = new Date(payload.completed_at);
const tempPath = workbookTemporaryPath(workbookPath, "monitor-tmp");
const pendingPath = path.join(stateDir, "pending-monitor-" + payload.run_id.replace(/[^a-z0-9_-]/gi, "_") + ".json");
await fs.mkdir(stateDir, { recursive: true });

function configValues(sheet) {
  return new Map(sheet.getRange("A5:B13").values.map(([label, value]) => [normalizeText(label), Number(value)]));
}

function appendOnce(value, sentence) {
  const current = String(value ?? "").trim();
  if (!sentence || current.includes(sentence)) return current || null;
  return [current, sentence].filter(Boolean).join("\n");
}

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const scanSheet = workbook.worksheets.getItem("Scan Log");
  const runSheet = workbook.worksheets.getItem("Run Log");
  const configSheet = workbook.worksheets.getItem("Search Config");
  const leadsTable = leadsSheet.tables.getItem("LeadsTable");
  const applicationsTable = applicationsSheet.tables.getItem("ApplicationsTable");
  const scanTable = scanSheet.tables.getItem("ScanLogTable");
  const runTable = runSheet.tables.getItem("RunLogTable");
  const { sheet: monitorSheet, table: monitorTable } = ensureLeadMonitorSheet(workbook);
  const { sheet: reviewSheet, table: reviewTable } = ensureEligibilityReviewSheet(workbook);
  if (runTable.getDataRows().some((row) => String(row[0] ?? "") === payload.run_id)) {
    console.log(JSON.stringify({ run_id: payload.run_id, outcomes: [], reviews: [], already_committed: true }, null, 2));
    process.exit(0);
  }
  const limits = configValues(configSheet);
  const alertThreshold = limits.get("Alert threshold");
  const leadThreshold = limits.get("Lead threshold");
  if (!Number.isFinite(alertThreshold) || !Number.isFinite(leadThreshold)) throw new Error("Search Config thresholds are missing");
  const leads = leadsTable.getDataRows();
  const applications = applicationsTable.getDataRows();
  const outcomes = [];
  const reviews = [];
  const registryWarnings = [];

  for (const raw of payload.checks) {
    const leadIndex = leads.findIndex((row) => String(row[0] ?? "").toLowerCase() === String(raw?.lead_id ?? "").toLowerCase());
    if (leadIndex < 0) throw new Error("Lead not found: " + raw?.lead_id);
    const lead = leads[leadIndex];
    if (!["Shortlisted", "Moved to Applications"].includes(String(lead[26] ?? ""))) {
      throw new Error("Lead Monitor accepts only Shortlisted or Moved to Applications leads: " + lead[0]);
    }
    const check = validateLeadMonitorCheck(raw, lead);
    if (check.eligibility_evidence_ids.length && !registry) {
      throw new Error("Monitor check references eligibility evidence but --eligibility-registry was not provided");
    }
    const canonicalSource = identifyCanonicalSource(check.canonical_url);
    const assessment = registry
      ? assessEligibilityEvidence(registry, {
        company: lead[3],
        location: check.location ?? lead[5],
        source: lead[7],
        canonical_url: check.canonical_url,
        listing_status: check.listing_status,
        eligibility: check.eligibility,
      }, check.eligibility_evidence_ids, { asOf: now })
      : null;
    if (assessment) registryWarnings.push(...assessment.warnings);
    const registryContext = eligibilityAssessmentText(assessment);
    const effectiveEligibility = assessment?.conflict ? "Needs Human Review" : check.eligibility;
    const eligibilityEvidence = [check.eligibility_evidence, registryContext].filter(Boolean).join(" ");
    const currentSnapshot = {
      listing_status: check.listing_status,
      location: check.location ?? lead[5],
      work_type: check.work_type ?? lead[6],
      description_hash: check.description_hash ?? lead[29],
      compensation_published: check.compensation_published,
      compensation: check.compensation,
      eligibility: effectiveEligibility,
      eligibility_evidence: eligibilityEvidence,
    };
    const monitorRows = monitorTable.getDataRows();
    const priorMonitor = monitorRows.find((row) => String(row[1] ?? "") === String(lead[0]));
    const previousSnapshot = priorMonitor ? leadMonitorSnapshotFromRow(priorMonitor) : leadSnapshotFromRow(lead);
    const comparison = compareLeadSnapshots(previousSnapshot, currentSnapshot);

    const leadRowNumber = 4 + leadIndex;
    if (check.listing_status === "Active") {
      leadsSheet.getRange(`F${leadRowNumber}:G${leadRowNumber}`).values = [[check.location, check.work_type]];
      leadsSheet.getRange(`L${leadRowNumber}:M${leadRowNumber}`).values = [[effectiveEligibility, eligibilityEvidence]];
      leadsSheet.getRange(`AD${leadRowNumber}:AE${leadRowNumber}`).values = [[check.description_hash, payload.run_id]];
      if (comparison.change_types.includes("Compensation")) {
        const note = `Monitor ${now.toISOString().slice(0, 10)}: ${comparison.summary}.`;
        leadsSheet.getRange(`AH${leadRowNumber}`).values = [[appendOnce(lead[33], note)]];
      }
    } else {
      leadsSheet.getRange(`L${leadRowNumber}:M${leadRowNumber}`).values = [["Ineligible", check.evidence]];
      leadsSheet.getRange(`AA${leadRowNumber}`).values = [["Expired"]];
      leadsSheet.getRange(`AE${leadRowNumber}`).values = [[payload.run_id]];
      leadsSheet.getRange(`AI${leadRowNumber}`).values = [["Listing unavailable; stop application preparation"]];
      const applicationIndex = applications.findIndex((row) => String(row[0] ?? "").toLowerCase() === String(lead[0]).toLowerCase());
      if (applicationIndex >= 0 && String(applications[applicationIndex][20] ?? "") === "Preparing") {
        const applicationRow = 4 + applicationIndex;
        const note = `Lead monitor ${now.toISOString().slice(0, 10)}: listing is ${check.listing_status.toLowerCase()}. ${check.evidence}`;
        applicationsSheet.getRange(`N${applicationRow}`).values = [[appendOnce(applications[applicationIndex][13], note)]];
        applicationsSheet.getRange(`U${applicationRow}:W${applicationRow}`).values = [["Not applying", "Listing unavailable; stop preparation", now]];
      }
    }

    const shouldReview = check.listing_status === "Active" && (
      (effectiveEligibility === "Needs Human Review" && Number(lead[22]) >= leadThreshold)
      || (effectiveEligibility === "Unclear" && Number(lead[22]) >= alertThreshold)
    );
    const review = syncEligibilityReview({
      sheet: reviewSheet,
      table: reviewTable,
      candidate: {
        lead_id: lead[0], company: lead[3], title: lead[4], final_score: lead[22],
        eligibility: check.listing_status === "Active" ? effectiveEligibility : "Ineligible",
        eligibility_evidence: eligibilityEvidence, canonical_url: lead[8], description_hash: currentSnapshot.description_hash,
      },
      runId: payload.run_id,
      now,
      shouldReview,
      reviewType: assessment?.conflict ? "Registry conflict" : "Eligibility clarification",
      reviewReason: registryContext ?? "Monitored source evidence leaves eligibility unresolved.",
      canonicalSource: canonicalSource.adapter_name ?? "Employer-hosted / unrecognized",
      sourceStatus: check.listing_status === "Active" ? "Verified Active" : `Verified ${check.listing_status}`,
    });
    if (review) reviews.push(review);

    upsertLeadMonitor({
      sheet: monitorSheet,
      table: monitorTable,
      lead,
      snapshot: currentSnapshot,
      evidenceIds: check.eligibility_evidence_ids,
      comparison,
      sourceEvidence: check.evidence,
      runId: payload.run_id,
      now,
    });
    const outcome = check.listing_status !== "Active"
      ? check.listing_status
      : comparison.changed ? "Material Change" : "Monitored / No Change";
    appendStyledRow(scanTable, scanSheet, [
      payload.run_id, now, lead[28], lead[3], lead[4], lead[8], outcome,
      [comparison.summary, check.evidence].join(" "), "Lead Monitor", null, lead[22], effectiveEligibility,
      lead[13], currentSnapshot.description_hash, lead[7], lead[9], currentSnapshot.location, currentSnapshot.work_type,
      lead[1], now, "Lead Monitor", lead[35], lead[36], JSON.stringify({ check, comparison, registry_assessment: assessment }),
    ], "X", {
      numberFormats: { B: "yyyy-mm-dd hh:mm", S: "yyyy-mm-dd", T: "yyyy-mm-dd" },
      rowHeight: 54,
    });
    outcomes.push({
      lead_id: lead[0],
      listing_status: check.listing_status,
      changed: comparison.changed,
      change_types: comparison.change_types,
      summary: comparison.summary,
    });
  }

  appendStyledRow(runTable, runSheet, [
    payload.run_id, new Date(payload.started_at), now, "Completed",
    "Lead Monitor", "Lead Monitor", "Not run", payload.checks.length, payload.checks.length,
    payload.checks.length, payload.checks.length, 0, 0, 0,
    outcomes.filter((outcome) => outcome.listing_status !== "Active").length, 0, null,
    [payload.notes, ...new Set(registryWarnings)].filter(Boolean).join("\n"),
  ], "R", {
    numberFormats: { B: "yyyy-mm-dd hh:mm", C: "yyyy-mm-dd hh:mm", "H:P": "0" },
  });

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "lead monitor formula validation",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);
  const result = { run_id: payload.run_id, outcomes, reviews, registry_warnings: [...new Set(registryWarnings)] };
  const resultTempPath = path.join(stateDir, ".last-monitor-" + payload.run_id.replace(/[^a-z0-9_-]/gi, "_") + ".tmp.json");
  await (await SpreadsheetFile.exportXlsx(workbook)).save(tempPath);
  await fs.writeFile(resultTempPath, JSON.stringify(result, null, 2) + "\n");
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  try { await fs.rename(resultTempPath, path.join(stateDir, "last-monitor.json")); } catch { /* Workbook commit already succeeded. */ }
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { await removeTemporaryWorkbook(tempPath, workbookPath); } catch { /* Preserve the original workbook. */ }
  await fs.writeFile(pendingPath, JSON.stringify({ payload, error: String(error?.stack ?? error) }, null, 2) + "\n");
  throw error;
}
