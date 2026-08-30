import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import {
  buildHistoricalImportPlan,
  HISTORICAL_IMPORT_CLASSIFICATIONS,
  historicalRecordReference,
  MAX_HISTORICAL_IMPORT_COLUMNS,
  MAX_HISTORICAL_IMPORT_FILE_BYTES,
  MAX_HISTORICAL_IMPORT_ROWS,
  normalizeHistoricalRecord,
  publicHistoricalImportSummary,
  validateHistoricalImportSpec,
} from "./historical_tracker_import_lib.mjs";
import { candidateIdentityKeys, normalizeText } from "./job_tracker_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { appendStyledRow } from "./tracker_rows.mjs";
import { inspectTrackerContract } from "./tracker_contract.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const LEAD_ROW_OPTIONS = {
  numberFormats: { B: "yyyy-mm-dd", C: "yyyy-mm-dd", K: "yyyy-mm-dd", AB: "yyyy-mm-dd hh:mm", "P:W": "0" },
  validations: {
    L: ["Eligible", "Unclear", "Ineligible", "Needs Human Review", "Needs Judge"],
    N: ["High", "Medium", "Low"],
    O: ["Backend / Platform", "Staff / Principal / Tech Lead", "Applied AI / LLM", "Developer Productivity / AI Enablement", "Full-stack / Product"],
    AA: ["New", "Review", "Shortlisted", "Preparing", "Dismissed", "Expired", "Moved to Applications"],
    AF: ["Judged", "Needs Judge", "Legacy / unjudged", "Failed"],
  },
  conditionalFormats: [
    { column: "W", type: "colorScale", options: { colors: ["#FCE4D6", "#FFF2CC", "#E2F0D9"], thresholds: ["min", "50%", "max"] } },
    { column: "L", type: "containsText", options: { text: "Ineligible", format: { fill: "#FCE4D6", font: { color: "#9C0006" } } } },
    { column: "L", type: "containsText", options: { text: "Unclear", format: { fill: "#FFF2CC", font: { color: "#7F6000" } } } },
    { column: "L", type: "containsText", options: { text: "Eligible", format: { fill: "#E2F0D9", font: { color: "#375623" } } } },
  ],
};

const APPLICATION_ROW_OPTIONS = {
  numberFormats: { B: "yyyy-mm-dd", M: "yyyy-mm-dd", O: "0", W: "yyyy-mm-dd hh:mm" },
  validations: {
    G: ["Backend / Platform", "Staff / Principal / Tech Lead", "Applied AI / LLM", "Developer Productivity / AI Enablement", "Full-stack / Product"],
    L: ["Draft", "Applied", "Submitted", "Skipped", "Not needed", "Not generated", "Screening", "Interview", "Offer", "Rejected", "Withdrawn"],
    T: ["Not started", "Plan ready — not started", "In progress", "Ready", "Completed", "Not started — skipped"],
    U: ["Interested", "Evaluating", "Preparing", "Applied", "Recruiter Screen", "Assessment", "Technical", "System Design", "Hiring Manager", "Final", "Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted", "Not applying"],
  },
};

const AUTO_COLUMNS = Object.freeze({
  lead: {
    company: "Company", title: "Role / Title", location: "Location", work_type: "Work Type", source: "Source",
    canonical_url: "Canonical URL", job_id: "Job ID", posted_date: "Posted Date", first_seen: "First Seen",
    last_seen: "Last Seen", eligibility: "Eligibility", confidence: "Confidence", best_resume: "Best Resume",
    final_score: "Final Score", lead_status: "Status", notes: "Notes", next_action: "Next Action",
  },
  application: {
    company: "Company", title: "Role / Title", location: "Location", work_type: "Work Type", source: "Source / Platform",
    canonical_url: "Job Posting URL", date_applied: "Date Applied", eligibility: "Eligibility", confidence: "Confidence",
    best_resume: "Resume Version", final_score: "Match Score (/100)", application_status: "Status",
    current_stage: "Current Stage", next_follow_up: "Next Follow-up", salary_posted: "Salary Range (Posted)",
    salary_expectation: "Salary Expectation Given", notes: "Notes", next_action: "Next Action",
  },
});

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileHash(filePath) {
  return sha256(await fs.readFile(filePath));
}

function safeId(value) {
  const text = String(value ?? "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!text) throw new Error("Import ID cannot be converted to a safe filename");
  return text;
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function autoMappingSpec(sourceWorkbook, sourceHash, sourceStat) {
  const sheets = [];
  for (const [sheetName, tableName, recordType] of [["Leads", "LeadsTable", "lead"], ["Applications", "ApplicationsTable", "application"]]) {
    const sheet = sourceWorkbook.worksheets.items.find((item) => item.name === sheetName);
    const table = sheet?.tables.items.find((item) => item.name === tableName);
    if (!table) continue;
    const headers = new Set(table.getHeaderRowRange().values[0].map((value) => normalizeText(value)));
    const columns = Object.fromEntries(Object.entries(AUTO_COLUMNS[recordType]).filter(([, header]) => headers.has(header)));
    if (columns.company && columns.title) {
      sheets.push({ sheet_name: sheetName, record_type: recordType, header_row: table.getHeaderRowRange().rowIndex + 1, columns });
    }
  }
  if (!sheets.length) {
    throw new Error("No compatible LeadsTable or ApplicationsTable was found; provide --mapping <historical-import.v1.json>");
  }
  return validateHistoricalImportSpec({
    schema_version: 1,
    import_id: `auto-${sourceHash.slice(0, 24)}`,
    imported_at: sourceStat.mtime.toISOString(),
    sheets,
  });
}

function headerIndexes(values, mapping, label) {
  const byHeader = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const header = normalizeText(values[index]).toLowerCase();
    if (!header) continue;
    if (byHeader.has(header)) throw new Error(`${label} contains duplicate header: ${normalizeText(values[index])}`);
    byHeader.set(header, index);
  }
  return Object.fromEntries(Object.entries(mapping).map(([field, header]) => {
    const index = byHeader.get(normalizeText(header).toLowerCase());
    if (index === undefined) throw new Error(`${label} is missing mapped header: ${header}`);
    return [field, index];
  }));
}

export function extractHistoricalRecords(sourceWorkbook, spec) {
  spec = validateHistoricalImportSpec(spec);
  const records = [];
  const classifications = [];
  let examinedRows = 0;
  for (const sheetMapping of spec.sheets) {
    const sheet = sourceWorkbook.worksheets.items.find((item) => item.name === sheetMapping.sheet_name);
    if (!sheet) throw new Error(`Mapped source sheet is missing: ${sheetMapping.sheet_name}`);
    const used = sheet.getUsedRange(true);
    if (!used) continue;
    const usedEndRow = used.rowIndex + used.rowCount;
    const usedEndColumn = used.columnIndex + used.columnCount;
    if (usedEndColumn > MAX_HISTORICAL_IMPORT_COLUMNS) {
      throw new Error(`${sheet.name} exceeds the ${MAX_HISTORICAL_IMPORT_COLUMNS}-column import limit`);
    }
    const headerIndex = sheetMapping.header_row - 1;
    if (headerIndex >= usedEndRow) throw new Error(`${sheet.name} header_row is outside the used range`);
    const headerValues = sheet.getRangeByIndexes(headerIndex, 0, 1, Math.max(1, usedEndColumn)).values[0];
    const indexes = headerIndexes(headerValues, sheetMapping.columns, `${sheet.name} row ${sheetMapping.header_row}`);
    const remainingCapacity = Math.max(0, MAX_HISTORICAL_IMPORT_ROWS - examinedRows);
    const dataEndRow = Math.min(usedEndRow, headerIndex + 1 + remainingCapacity);
    for (let rowIndex = headerIndex + 1; rowIndex < dataEndRow; rowIndex += 1) {
      const rowNumber = rowIndex + 1;
      examinedRows += 1;
      const sourceRef = historicalRecordReference(spec.import_id, sheet.name, rowNumber);
      const values = sheet.getRangeByIndexes(rowIndex, 0, 1, Math.max(1, usedEndColumn)).values[0];
      const raw = Object.fromEntries(Object.entries(indexes).map(([field, index]) => [field, values[index]]));
      if (Object.values(raw).every((value) => !normalizeText(value))) {
        classifications.push({ code: HISTORICAL_IMPORT_CLASSIFICATIONS.EMPTY_ROW, source_ref: sourceRef, reason: "Mapped row is empty." });
        continue;
      }
      try {
        records.push(normalizeHistoricalRecord(raw, {
          importId: spec.import_id,
          importedAt: spec.imported_at,
          sheetName: sheet.name,
          rowNumber,
          recordType: sheetMapping.record_type,
        }));
      } catch (error) {
        classifications.push({
          code: HISTORICAL_IMPORT_CLASSIFICATIONS.MALFORMED_ROW,
          source_ref: sourceRef,
          reason: String(error?.message ?? error),
        });
      }
    }
    if (dataEndRow < usedEndRow) {
      classifications.push({
        code: HISTORICAL_IMPORT_CLASSIFICATIONS.LIMIT_EXCEEDED,
        source_ref: historicalRecordReference(spec.import_id, sheet.name, dataEndRow + 1),
        reason: `Rows beyond the ${MAX_HISTORICAL_IMPORT_ROWS}-row import limit were not read.`,
      });
    }
  }
  return { records, classifications, examined_rows: examinedRows };
}

function targetSnapshot(workbook) {
  const leadsRows = workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").getDataRows();
  const applicationRows = workbook.worksheets.getItem("Applications").tables.getItem("ApplicationsTable").getDataRows();
  const targetLeads = leadsRows.filter((row) => row[0]).map((row) => ({
    lead_id: String(row[0]),
    company: row[3], title: row[4], location: row[5], canonical_url: row[8], job_id: row[9],
    canonical_key: row[28] ? String(row[28]) : null,
    identity_keys: candidateIdentityKeys({ company: row[3], title: row[4], location: row[5], canonical_url: row[8], job_id: row[9] }),
  }));
  const targetApplications = applicationRows.filter((row) => row[0]).map((row) => ({
    lead_id: String(row[0]),
    company: row[2], title: row[3], location: row[4], canonical_url: row[8],
    canonical_key: row[25] ? String(row[25]) : null,
    identity_keys: candidateIdentityKeys({ company: row[2], title: row[3], location: row[4], canonical_url: row[8] }),
  }));
  return { targetLeads, targetApplications, leadsRows, applicationRows };
}

function appendNote(current, sentence) {
  const text = normalizeText(current);
  if (!text) return sentence;
  if (text.includes(sentence)) return text;
  return `${text} ${sentence}`;
}

function addPlanToWorkbook(workbook, plan) {
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const runSheet = workbook.worksheets.getItem("Run Log");
  const leadsTable = leadsSheet.tables.getItem("LeadsTable");
  const applicationsTable = applicationsSheet.tables.getItem("ApplicationsTable");
  const runTable = runSheet.tables.getItem("RunLogTable");
  const applicationLeadIds = new Set(plan.operations.applications_to_add.map((item) => item.lead_id));
  for (const record of plan.operations.leads_to_add) {
    appendStyledRow(leadsTable, leadsSheet, [
      record.lead_id, new Date(record.first_seen), new Date(record.last_seen), record.company, record.title,
      record.location, record.work_type, record.source, record.canonical_url, record.job_id,
      record.posted_date ? new Date(record.posted_date) : null,
      record.eligibility ?? "Unclear", "Imported historical record; eligibility has not been re-verified.",
      record.confidence ?? "Low", record.best_resume, null, null, null, null, null, null, null,
      record.final_score, "Historical import", null, null,
      applicationLeadIds.has(record.lead_id) ? "Moved to Applications" : (record.lead_status ?? "Review"),
      null, record.canonical_key, null, plan.import_run_id, "Legacy / unjudged", false,
      appendNote(record.notes, "Imported from a private historical tracker; current tracker data remains authoritative."),
      record.next_action ?? "Review imported historical record", null, record.legacy_source_row,
    ], "AK", LEAD_ROW_OPTIONS);
  }
  for (const record of plan.operations.applications_to_add) {
    appendStyledRow(applicationsTable, applicationsSheet, [
      record.lead_id, record.date_applied ? new Date(record.date_applied) : null, record.company, record.title,
      record.location, record.work_type, record.best_resume, record.source, record.canonical_url,
      record.salary_posted, record.salary_expectation, record.application_status,
      record.next_follow_up ? new Date(record.next_follow_up) : null,
      appendNote(record.notes, "Imported from a private historical tracker; current tracker data remains authoritative."),
      record.final_score, null, null, null, null, null, record.current_stage, record.next_action,
      new Date(record.last_seen), record.eligibility ?? "Unclear", record.confidence ?? "Low",
      record.canonical_key, plan.import_run_id, null, record.legacy_source_row,
    ], "AC", APPLICATION_ROW_OPTIONS);
  }
  const rejected = [
    "malformed_row", "conflict_in_source", "duplicate_in_source", "conflict_in_tracker",
    "duplicate_lead_in_tracker", "duplicate_application_in_tracker", "limit_exceeded",
  ].reduce((sum, code) => sum + Number(plan.diagnostics.classification_counts[code] ?? 0), 0);
  appendStyledRow(runTable, runSheet, [
    plan.import_run_id, new Date(plan.imported_at), new Date(plan.imported_at), "Completed",
    "Not run — historical import", "Not run — historical import", "Not run — historical import",
    0, plan.diagnostics.source_records, plan.diagnostics.leads_to_add, 0, 0,
    plan.diagnostics.leads_to_add, plan.diagnostics.applications_to_add, rejected, 0,
    plan.diagnostics.classification_counts.malformed_row + plan.diagnostics.classification_counts.conflict_in_source + plan.diagnostics.classification_counts.conflict_in_tracker,
    `Historical tracker import; source SHA-256 ${plan.source_sha256}; current tracker fields were authoritative.`,
  ], "R", { numberFormats: { B: "yyyy-mm-dd hh:mm", C: "yyyy-mm-dd hh:mm", "H:P": "0" } });
  refreshActionDashboard(workbook, { asOf: new Date(plan.imported_at) });
}

function existingImport(workbook, runId, sourceHash) {
  const rows = workbook.worksheets.getItem("Run Log").tables.getItem("RunLogTable").getDataRows();
  const row = rows.find((item) => String(item[0] ?? "") === runId);
  if (!row) return false;
  const notes = normalizeText(row[17]);
  if (!notes.includes(sourceHash)) throw new Error(`${runId} already exists with a different source hash`);
  return true;
}

async function verifiedSave(workbook, temporaryPath, plan, beforePromote) {
  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "historical tracker import formula validation",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);
  await (await SpreadsheetFile.exportXlsx(workbook)).save(temporaryPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(temporaryPath));
  const contract = inspectTrackerContract(verified);
  if (!contract.valid) throw new Error("Historical import verification failed: " + JSON.stringify(contract));
  if (!existingImport(verified, plan.import_run_id, plan.source_sha256)) throw new Error("Historical import run-log verification failed");
  const verifiedSnapshot = targetSnapshot(verified);
  for (const operation of plan.operations.leads_to_add) {
    if (!verifiedSnapshot.targetLeads.some((lead) => lead.lead_id === operation.lead_id)) throw new Error(`Imported lead verification failed: ${operation.lead_id}`);
  }
  for (const operation of plan.operations.applications_to_add) {
    if (!verifiedSnapshot.targetApplications.some((item) => item.lead_id === operation.lead_id)) throw new Error(`Imported application verification failed: ${operation.lead_id}`);
  }
  await beforePromote({ temporaryPath, plan });
}

async function readSpec(mappingPath, sourceWorkbook, sourceHash, sourceStat) {
  if (!mappingPath) return autoMappingSpec(sourceWorkbook, sourceHash, sourceStat);
  return validateHistoricalImportSpec(JSON.parse(await fs.readFile(path.resolve(mappingPath), "utf8")));
}

export async function runHistoricalTrackerImport({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  sourcePath,
  targetPath = null,
  mappingPath = null,
  stateDirectory = null,
  apply = false,
  recoverPath = null,
  beforePromote = async () => {},
} = {}) {
  let recovery = null;
  let recoverySpec = null;
  if (recoverPath) {
    if (!apply) throw new Error("Historical import recovery requires --apply");
    recovery = JSON.parse(await fs.readFile(path.resolve(recoverPath), "utf8"));
    if (recovery.workflow !== "historical_tracker_import") throw new Error("Recovery marker is not a historical tracker import marker");
    recoverySpec = validateHistoricalImportSpec(recovery.mapping_spec);
    sourcePath = recovery.source_path;
    targetPath = recovery.target_path;
    mappingPath = recovery.mapping_path;
    stateDirectory = path.dirname(path.resolve(recoverPath));
  }
  if (!sourcePath) throw new Error("Historical tracker import requires --source <xlsx>");
  const source = resolveXlsxWorkbookPath(sourcePath, "--source");
  const explicitTarget = targetPath ? resolveXlsxWorkbookPath(targetPath, "--target") : null;
  const config = await loadProjectConfig({ projectRoot, configPath });
  const target = explicitTarget ?? resolveXlsxWorkbookPath(config.trackerPath, "--target");
  if (source === target) throw new Error("Historical source and current target workbook must be different files");
  const stateDir = path.resolve(stateDirectory ?? config.stateDirectory);
  const resolvedMappingPath = recoverySpec ? null : (mappingPath ? path.resolve(mappingPath) : null);
  const sourceStat = await fs.stat(source);
  if (sourceStat.size > MAX_HISTORICAL_IMPORT_FILE_BYTES) throw new Error(`Historical source exceeds the ${MAX_HISTORICAL_IMPORT_FILE_BYTES}-byte limit`);
  const sourceHash = await fileHash(source);
  const targetHashBefore = await fileHash(target);
  const mappingHash = resolvedMappingPath ? await fileHash(resolvedMappingPath) : null;
  if (recovery) {
    if (recovery.source_sha256 !== sourceHash) throw new Error("Historical source changed after the failed import; run a new preview");
    if (recovery.target_sha256_before !== targetHashBefore) throw new Error("Current tracker changed after the failed import; run a new preview");
  }
  const sourceWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
  const targetWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(target));
  const targetContract = inspectTrackerContract(targetWorkbook);
  if (!targetContract.valid) throw new Error("Current tracker does not satisfy this release contract: " + JSON.stringify(targetContract));
  const spec = recoverySpec ?? await readSpec(resolvedMappingPath, sourceWorkbook, sourceHash, sourceStat);
  const runId = `HIST-${spec.import_id}`;
  if (existingImport(targetWorkbook, runId, sourceHash)) {
    const emptyPlan = buildHistoricalImportPlan({ spec, records: [], ...targetSnapshot(targetWorkbook), sourceSha256: sourceHash });
    return publicHistoricalImportSummary(emptyPlan, { mode: apply ? "apply" : "preview", applied: apply, alreadyCommitted: true });
  }
  const extracted = extractHistoricalRecords(sourceWorkbook, spec);
  const snapshot = targetSnapshot(targetWorkbook);
  const plan = buildHistoricalImportPlan({
    spec,
    records: extracted.records,
    targetLeads: snapshot.targetLeads,
    targetApplications: snapshot.targetApplications,
    sourceSha256: sourceHash,
    sourceClassifications: extracted.classifications,
  });
  if (!apply) return publicHistoricalImportSummary(plan);

  await fs.mkdir(stateDir, { recursive: true });
  const pendingPath = path.join(stateDir, `pending-history-import-${safeId(spec.import_id)}.json`);
  const temporaryPath = workbookTemporaryPath(target, "history-import-tmp");
  let committed = false;
  try {
    addPlanToWorkbook(targetWorkbook, plan);
    await verifiedSave(targetWorkbook, temporaryPath, plan, beforePromote);
    if (await fileHash(source) !== sourceHash) throw new Error("Historical source changed during import; run a new preview");
    if (await fileHash(target) !== targetHashBefore) throw new Error("Current tracker changed during import; run a new preview");
    if (resolvedMappingPath && await fileHash(resolvedMappingPath) !== mappingHash) {
      throw new Error("Historical import mapping changed during import; run a new preview");
    }
    await fs.rename(temporaryPath, target);
    committed = true;
    await removeWorkbookInspection(temporaryPath).catch(() => {});
    await fs.rm(pendingPath, { force: true }).catch(() => {});
    if (recoverPath) await fs.rm(path.resolve(recoverPath), { force: true }).catch(() => {});
    return publicHistoricalImportSummary(plan, { mode: "apply", applied: true });
  } catch (error) {
    await removeTemporaryWorkbook(temporaryPath, target).catch(() => {});
    if (!committed) {
      const marker = {
        schema_version: 1,
        workflow: "historical_tracker_import",
        import_id: spec.import_id,
        source_path: source,
        target_path: target,
        mapping_path: resolvedMappingPath,
        mapping_spec: spec,
        source_sha256: sourceHash,
        target_sha256_before: targetHashBefore,
        created_at: new Date().toISOString(),
        error: String(error?.stack ?? error),
      };
      await atomicJson(pendingPath, marker);
      error.pending_marker = pendingPath;
    }
    throw error;
  } finally {
    await Promise.allSettled([removeWorkbookInspection(source), removeWorkbookInspection(target)]);
  }
}

async function main() {
  const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
  const result = await runHistoricalTrackerImport({
    projectRoot,
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    sourcePath: argumentValue(process.argv, "--source"),
    targetPath: argumentValue(process.argv, "--target"),
    mappingPath: argumentValue(process.argv, "--mapping"),
    stateDirectory: argumentValue(process.argv, "--state-dir"),
    apply: process.argv.includes("--apply"),
    recoverPath: argumentValue(process.argv, "--recover"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ schema_version: 1, applied: false, error: String(error?.message ?? error), pending_marker: error?.pending_marker ?? null }, null, 2));
    process.exitCode = 1;
  });
}
