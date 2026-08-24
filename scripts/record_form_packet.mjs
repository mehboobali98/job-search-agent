import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import {
  applicationFormSummary,
  renderApplicationFormMarkdown,
  resolveInside,
  safePacketSegment,
  validateApplicationFormPacket,
} from "./application_form_lib.mjs";
import { ensureFormRunsSheet, upsertFormRun } from "./form_runs_sheet.mjs";
import { promoteFilesWithRollback } from "./file_transaction.mjs";
import { normalizeText, normalizeUrl, RESUMES } from "./job_tracker_lib.mjs";
import { argumentValue } from "./project_config.mjs";
import { removeTemporaryWorkbook, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook", "");
const leadId = normalizeText(argumentValue(process.argv, "--lead-id", ""));
const inputArgument = argumentValue(process.argv, "--input", "");
if (!workbookArgument || !leadId || !inputArgument) {
  throw new Error("Usage: node scripts/record_form_packet.mjs --workbook <xlsx> --lead-id <ID> --input <packet.json> [--state-dir <dir>] [--packages-dir <dir>]");
}
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const inputPath = path.resolve(inputArgument);
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));
const packagesDir = path.resolve(argumentValue(process.argv, "--packages-dir", path.join(path.dirname(workbookPath), "application-packages")));

const safeLeadId = safePacketSegment(leadId);
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(packagesDir, { recursive: true });
const pendingBasePath = path.join(stateDir, `pending-form-${safeLeadId}.json`);
let pendingPath = pendingBasePath;
const tempWorkbookPath = workbookTemporaryPath(workbookPath, `form-${Date.now()}-tmp`);
let packetTempPath = null;
let responseTempPath = null;

function visiblePath(target) {
  const relative = path.relative(path.dirname(workbookPath), target);
  return relative && !relative.startsWith(".." + path.sep) && relative !== ".." ? relative : target;
}

function mergeFormNextAction(current, summary, formId, responsePath) {
  const base = normalizeText(current).replace(/\s*\[Form packet\][\s\S]*$/i, "").trim();
  const formAction = `[Form packet] ${formId}: ${summary.ready} ready, ${summary.needs_input} need input, ${summary.manual} manual; cover letter ${summary.cover_letter_status}. Review ${responsePath}.`;
  return [base, formAction].filter(Boolean).join(" ");
}

function mayReplaceCoverLetter(value) {
  const text = normalizeText(value);
  return !text || /^(Not generated|Not requested|Required —|Optional —|Not present|Unclear —)/i.test(text);
}

try {
  const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const packet = validateApplicationFormPacket(raw);
  if (packet.form.lead_id.toLowerCase() !== leadId.toLowerCase()) throw new Error("Packet lead_id does not match --lead-id");

  const safeFormId = safePacketSegment(packet.form.form_id);
  pendingPath = path.join(stateDir, `pending-form-${safeLeadId}-${safeFormId}.json`);
  const packetDirectory = resolveInside(stateDir, "application-forms", safeLeadId);
  const responseDirectory = resolveInside(packagesDir, safeLeadId);
  const packetJsonPath = resolveInside(packetDirectory, `${safeFormId}.json`);
  const responsePath = resolveInside(responseDirectory, `${safeFormId}-responses.md`);
  const packetJsonVisible = visiblePath(packetJsonPath);
  const responseVisible = visiblePath(responsePath);

  if (packet.review.cover_letter.document_path) {
    const documentPath = resolveInside(responseDirectory, packet.review.cover_letter.document_path);
    await fs.access(documentPath);
  }

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const applicationsSheet = workbook.worksheets.getItem("Applications");
  const applicationsTable = applicationsSheet.tables.items.find((table) => table.name === "ApplicationsTable");
  if (!applicationsTable) throw new Error("ApplicationsTable is missing");
  const applicationRows = applicationsTable.getDataRows();
  const applicationIndex = applicationRows.findIndex((row) => String(row[0] ?? "").toLowerCase() === leadId.toLowerCase());
  if (applicationIndex < 0) throw new Error("Prepared application not found for lead: " + leadId);
  const application = applicationRows[applicationIndex];
  const applicationRowNumber = 4 + applicationIndex;
  const applicationUrl = normalizeUrl(application[8]);
  if (!applicationUrl || applicationUrl !== packet.form.canonical_job_url) {
    throw new Error("Packet canonical_job_url does not match Applications.Job Posting URL");
  }
  const resume = normalizeText(application[6]);
  if (!RESUMES.has(resume)) throw new Error("Prepared application does not have one allowed resume version");
  const applicationMeta = { company: normalizeText(application[2]), role: normalizeText(application[3]), resume };
  const summary = applicationFormSummary(packet);
  const markdown = renderApplicationFormMarkdown(packet, applicationMeta, packetJsonVisible);

  await fs.mkdir(packetDirectory, { recursive: true });
  await fs.mkdir(responseDirectory, { recursive: true });
  packetTempPath = packetJsonPath + `.staged-${process.pid}-${Date.now()}`;
  responseTempPath = responsePath + `.staged-${process.pid}-${Date.now()}`;
  await fs.writeFile(packetTempPath, JSON.stringify(packet, null, 2) + "\n");
  await fs.writeFile(responseTempPath, markdown);

  const { sheet: formRunsSheet, table: formRunsTable } = ensureFormRunsSheet(workbook);
  const now = new Date();
  const formRun = upsertFormRun({
    sheet: formRunsSheet,
    table: formRunsTable,
    values: [
      packet.form.form_id,
      packet.form.lead_id,
      new Date(packet.form.captured_at),
      packet.form.step.total ? `${packet.form.step.index}/${packet.form.step.total}` : String(packet.form.step.index),
      packet.form.step.title,
      applicationMeta.company,
      applicationMeta.role,
      packet.form.ats,
      packet.form.form_url,
      packet.form.canonical_job_url,
      summary.fields,
      summary.ready,
      summary.needs_input,
      summary.manual,
      summary.cover_letter_requirement,
      summary.cover_letter_status,
      responseVisible,
      summary.review_status,
      now,
    ],
  });

  if (mayReplaceCoverLetter(application[17])) applicationsSheet.getRange(`R${applicationRowNumber}`).values = [[summary.cover_letter_status]];
  applicationsSheet.getRange(`V${applicationRowNumber}`).values = [[
    mergeFormNextAction(application[21], summary, packet.form.form_id, responseVisible),
  ]];
  applicationsSheet.getRange(`W${applicationRowNumber}`).values = [[now]];

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "form packet formula validation",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);

  await (await SpreadsheetFile.exportXlsx(workbook)).save(tempWorkbookPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(tempWorkbookPath));
  const verifiedFormRows = verified.worksheets.getItem("Form Runs").tables.getItem("FormRunsTable").getDataRows();
  const verifiedForm = verifiedFormRows.find((row) => String(row[0] ?? "") === packet.form.form_id);
  if (!verifiedForm || String(verifiedForm[17] ?? "") !== summary.review_status) {
    throw new Error("Form Runs verification failed before workbook commit");
  }
  await promoteFilesWithRollback([
    { staged: packetTempPath, target: packetJsonPath },
    { staged: responseTempPath, target: responsePath },
  ], async () => fs.rename(tempWorkbookPath, workbookPath));
  await Promise.allSettled([
    fs.rm(pendingPath, { force: true }),
    fs.rm(pendingBasePath, { force: true }),
  ]);
  console.log(JSON.stringify({
    form_id: packet.form.form_id,
    lead_id: packet.form.lead_id,
    tracker_outcome: formRun.outcome,
    review_status: summary.review_status,
    fields: summary.fields,
    ready: summary.ready,
    needs_input: summary.needs_input,
    manual: summary.manual,
    cover_letter_requirement: summary.cover_letter_requirement,
    cover_letter_status: summary.cover_letter_status,
    response_packet: responsePath,
    validated_packet: packetJsonPath,
  }, null, 2));
} catch (error) {
  try { await removeTemporaryWorkbook(tempWorkbookPath, workbookPath); } catch { /* Preserve the original workbook. */ }
  for (const stagedPath of [packetTempPath, responseTempPath].filter(Boolean)) {
    try { await fs.rm(stagedPath, { force: true }); } catch { /* Pending metadata records the failed transaction. */ }
  }
  await fs.writeFile(pendingPath, JSON.stringify({
    lead_id: leadId,
    input: inputPath,
    error: String(error?.stack ?? error),
    rollback_errors: error?.rollback_errors ?? [],
    created_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
}
