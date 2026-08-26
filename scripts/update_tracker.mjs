import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import {
  canonicalKey,
  candidateIdentityKeys,
  candidateNotes,
  descriptionHash,
  ELIGIBILITY_DECISIONS,
  isAlertable,
  normalizeText,
  normalizeUrl,
  recommendationBand,
  RESUMES,
  LISTING_STATUS,
  shouldRepeatAlert,
  validateJudgedCandidate,
} from "./job_tracker_lib.mjs";
import { argumentValue } from "./project_config.mjs";
import { appendStyledRow } from "./tracker_rows.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const workbookArgument = argumentValue(process.argv, "--workbook");
const inputArgument = argumentValue(process.argv, "--input");

if (!workbookArgument || !inputArgument) {
  throw new Error("Usage: node scripts/update_tracker.mjs --workbook <xlsx> --input <run.json> [--state-dir <dir>]");
}
const workbookPath = resolveXlsxWorkbookPath(workbookArgument, "--workbook");
const inputPath = path.resolve(inputArgument);
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", path.join(path.dirname(workbookPath), "state")));

const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));

const RUN_STATUSES = new Set(["Completed", "Partial"]);
const FINDER_STATUSES = new Set(["Completed", "Failed", "Fallback Completed", "Fallback Failed"]);
const JUDGE_AGENT_STATUSES = new Set([...FINDER_STATUSES, "Partial"]);
const COUNT_FIELDS = ["queries", "found", "unique", "evaluated", "judged"];
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
function validDate(value) {
  return normalizeText(value) && Number.isFinite(new Date(value).getTime());
}

function validateRunPayload(run) {
  if (!normalizeText(run.run_id)) throw new Error("Run payload requires a non-empty run_id");
  if (!validDate(run.started_at) || !validDate(run.completed_at)) {
    throw new Error("Run payload requires valid started_at and completed_at timestamps");
  }
  if (new Date(run.completed_at) < new Date(run.started_at)) throw new Error("completed_at cannot precede started_at");
  if (!RUN_STATUSES.has(run.status)) throw new Error("Run status must be Completed or Partial");
  if (!run.agents || typeof run.agents !== "object" || Array.isArray(run.agents)) throw new Error("Run payload requires agents");
  if (!FINDER_STATUSES.has(run.agents.backend_finder)) throw new Error("Invalid backend_finder status");
  if (!FINDER_STATUSES.has(run.agents.ai_product_finder)) throw new Error("Invalid ai_product_finder status");
  if (!JUDGE_AGENT_STATUSES.has(run.agents.job_judge)) throw new Error("Invalid job_judge status");
  const failedAgent = Object.values(run.agents).some((status) => status === "Failed" || status === "Fallback Failed" || status === "Partial");
  if (run.status === "Completed" && failedAgent) throw new Error("A run with a failed or partial agent must have status Partial");
  for (const field of COUNT_FIELDS) {
    if (!Number.isInteger(run[field]) || run[field] < 0) throw new Error(field + " must be a non-negative integer");
  }
  if (!Array.isArray(run.errors) || run.errors.some((item) => typeof item !== "string")) throw new Error("errors must be an array of strings");
  if (run.notes !== undefined && typeof run.notes !== "string") throw new Error("notes must be a string");
  if (!Array.isArray(run.scan_events)) throw new Error("Run payload requires scan_events[]");
  if (!Array.isArray(run.candidates)) throw new Error("Run payload requires candidates[]");
  for (let index = 0; index < run.scan_events.length; index += 1) {
    const event = run.scan_events[index];
    if (typeof event.counts_toward_unique !== "boolean" || typeof event.deep_evaluated !== "boolean") {
      throw new Error(`scan_events[${index}] requires counts_toward_unique and deep_evaluated booleans`);
    }
    if (event.deep_evaluated && !event.counts_toward_unique) {
      throw new Error(`scan_events[${index}] cannot be deep_evaluated when counts_toward_unique is false`);
    }
  }
}

function computedCounts(run) {
  const seen = new Set();
  const judgedSeen = new Set();
  let uniqueCandidates = 0;
  let judgedCandidates = 0;
  for (const candidate of run.candidates) {
    const keys = candidateIdentityKeys(candidate);
    if (!keys.some((key) => seen.has(key))) uniqueCandidates += 1;
    for (const key of keys) seen.add(key);
    if (candidate.judge_status === "Judged" && !keys.some((key) => judgedSeen.has(key))) judgedCandidates += 1;
    if (candidate.judge_status === "Judged") for (const key of keys) judgedSeen.add(key);
  }
  return {
    found: run.candidates.length + run.scan_events.length,
    unique: uniqueCandidates + run.scan_events.filter((event) => event.counts_toward_unique === true).length,
    evaluated: uniqueCandidates + run.scan_events.filter((event) => event.deep_evaluated === true).length,
    judged: judgedCandidates,
  };
}

validateRunPayload(payload);

const now = payload.completed_at ? new Date(payload.completed_at) : new Date();
const pendingPath = path.join(stateDir, "pending-" + String(payload.run_id).replace(/[^a-z0-9_-]/gi, "_") + ".json");
const tempPath = workbookTemporaryPath(workbookPath, "update-tmp");

function rowValues(candidate, previous, alert) {
  const firstSeen = previous?.first_seen ? new Date(previous.first_seen) : new Date(candidate.first_seen ?? now);
  const lastAlerted = alert ? now : (previous?.last_alerted ? new Date(previous.last_alerted) : null);
  return [
    previous?.lead_id ?? candidate.lead_id,
    firstSeen,
    now,
    candidate.company,
    candidate.title,
    candidate.location ?? null,
    candidate.work_type ?? null,
    candidate.source ?? null,
    candidate.canonical_url,
    candidate.job_id ?? null,
    candidate.posted_date ? new Date(candidate.posted_date) : null,
    candidate.eligibility,
    candidate.eligibility_evidence ?? null,
    candidate.confidence,
    candidate.best_resume,
    candidate.scores?.responsibilities ?? null,
    candidate.scores?.technical ?? null,
    candidate.scores?.seniority ?? null,
    candidate.scores?.evidence ?? null,
    candidate.scores?.domain ?? null,
    candidate.scores?.location ?? null,
    candidate.scores?.compensation ?? null,
    candidate.final_score,
    candidate.recommendation,
    bulletList(candidate.strengths),
    bulletList(candidate.gaps),
    previous?.status ?? candidate.status ?? "New",
    lastAlerted,
    candidate.canonical_key,
    candidate.description_hash,
    payload.run_id,
    candidate.judge_status ?? (candidate.eligibility === "Needs Judge" ? "Needs Judge" : "Judged"),
    Boolean(candidate.unsupported_evidence),
    candidateNotes(candidate),
    candidate.next_action ?? null,
    previous?.detail_sheet ?? null,
    previous?.legacy_source_row ?? null,
  ];
}

function bulletList(value) {
  if (!Array.isArray(value)) return value ?? null;
  return value.length ? "• " + value.join("\n• ") : null;
}

function searchConfigValues(sheet) {
  const values = new Map();
  for (const [rawLabel, value] of sheet.getRange("A5:B13").values) {
    const label = normalizeText(rawLabel);
    if (!label) continue;
    if (values.has(label)) throw new Error("Duplicate Search Config label: " + label);
    values.set(label, value);
  }
  return values;
}

function requiredConfigNumber(values, label) {
  if (!values.has(label)) throw new Error("Missing Search Config label: " + label);
  return Number(values.get(label));
}

function serializeExisting(row) {
  return {
    lead_id: row[0],
    first_seen: row[1] instanceof Date ? row[1].toISOString() : row[1],
    last_alerted: row[27] instanceof Date ? row[27].toISOString() : row[27],
    canonical_key: row[28],
    job_id: row[9],
    description_hash: row[29],
    final_score: row[22],
    eligibility: row[11],
    status: row[26],
    detail_sheet: row[35],
    legacy_source_row: row[36],
  };
}

function pendingCandidate(raw) {
  for (const field of [
    "company", "title", "location", "work_type", "canonical_url", "source", "best_resume",
    "finder_eligibility", "finder_eligibility_evidence",
  ]) {
    if (!normalizeText(raw[field])) throw new Error("Missing required pending candidate field: " + field);
  }
  if (!RESUMES.has(raw.best_resume)) throw new Error("Invalid pending best_resume: " + raw.best_resume);
  if (!ELIGIBILITY_DECISIONS.has(raw.finder_eligibility)) throw new Error("Invalid pending finder_eligibility");
  if (raw.listing_status !== "Active") throw new Error("Needs Judge candidate listing_status must be Active");
  const preliminary = Number(raw.preliminary_score);
  if (!Number.isFinite(preliminary) || preliminary < 0 || preliminary > 100) throw new Error("Needs Judge candidate requires preliminary_score from 0 to 100");
  if (raw.confidence !== "Low") throw new Error("Needs Judge candidate confidence must be Low");
  const pendingDescription = normalizeText(raw.job_description ?? raw.description);
  if (!pendingDescription) throw new Error("Needs Judge candidate requires a job description");
  if (!/^[a-f0-9]{64}$/i.test(String(raw.description_hash ?? ""))) throw new Error("Needs Judge candidate requires a SHA-256 description_hash");
  if (raw.description_hash.toLowerCase() !== descriptionHash(pendingDescription)) throw new Error("Needs Judge description_hash does not match the normalized job description");
  return {
    ...raw,
    canonical_url: normalizeUrl(raw.canonical_url),
    canonical_key: canonicalKey(raw),
    description_hash: raw.description_hash.toLowerCase(),
    eligibility: "Needs Judge",
    eligibility_evidence: raw.finder_eligibility_evidence + " Independent judge did not complete.",
    confidence: "Low",
    scores: null,
    final_score: null,
    recommendation: "Needs Judge",
    judge_status: "Needs Judge",
    unsupported_evidence: false,
  };
}

await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const leadsSheet = workbook.worksheets.getItem("Leads");
  const scanSheet = workbook.worksheets.getItem("Scan Log");
  const runSheet = workbook.worksheets.getItem("Run Log");
  const configSheet = workbook.worksheets.getItem("Search Config");
  const leadsTable = leadsSheet.tables.items.find((table) => table.name === "LeadsTable");
  const scanTable = scanSheet.tables.items.find((table) => table.name === "ScanLogTable");
  const runTable = runSheet.tables.items.find((table) => table.name === "RunLogTable");
  if (!leadsTable || !scanTable || !runTable) throw new Error("Required tracker tables are missing");
  if (runTable.getDataRows().some((row) => String(row[0] ?? "") === payload.run_id)) {
    console.log(JSON.stringify({ run_id: payload.run_id, outcomes: [], alerts: [], already_committed: true, state_warnings: [] }, null, 2));
    process.exit(0);
  }

  const configValues = searchConfigValues(configSheet);
  const configuredMaxAlerts = requiredConfigNumber(configValues, "Maximum alerts");
  const alertThreshold = requiredConfigNumber(configValues, "Alert threshold");
  const leadThreshold = requiredConfigNumber(configValues, "Lead threshold");
  const configuredMaxSearches = requiredConfigNumber(configValues, "Maximum searches");
  const configuredMaxUnique = requiredConfigNumber(configValues, "Maximum unique candidates");
  const configuredMaxEvaluated = requiredConfigNumber(configValues, "Maximum deep evaluations");
  const configuredMaxJudged = requiredConfigNumber(configValues, "Maximum judged candidates");
  if (!Number.isInteger(configuredMaxAlerts) || configuredMaxAlerts < 0 || configuredMaxAlerts > 20) throw new Error("Invalid Search Config maximum alerts");
  if (!Number.isFinite(alertThreshold) || alertThreshold < 0 || alertThreshold > 100) throw new Error("Invalid Search Config alert threshold");
  if (!Number.isFinite(leadThreshold) || leadThreshold < 0 || leadThreshold > alertThreshold) throw new Error("Invalid Search Config lead threshold");
  for (const [name, value] of Object.entries({ configuredMaxSearches, configuredMaxUnique, configuredMaxEvaluated, configuredMaxJudged })) {
    if (!Number.isInteger(value) || value < 0) throw new Error("Invalid Search Config " + name);
  }

  const counts = computedCounts(payload);
  for (const field of ["found", "unique", "evaluated", "judged"]) {
    if (payload[field] !== counts[field]) throw new Error(field + " does not match the deterministic run count");
  }
  if (!(payload.judged <= payload.evaluated && payload.evaluated <= payload.unique && payload.unique <= payload.found)) {
    throw new Error("Run counts must satisfy judged <= evaluated <= unique <= found");
  }
  if (payload.queries > configuredMaxSearches || payload.unique > configuredMaxUnique || payload.evaluated > configuredMaxEvaluated || payload.judged > configuredMaxJudged) {
    throw new Error("Run counts exceed Search Config limits");
  }

  const leadRows = leadsTable.getDataRows();
  const byIdentity = new Map();
  for (let index = 0; index < leadRows.length; index += 1) {
    const row = leadRows[index];
    if (!row[0]) continue;
    const existing = { index, row, ...serializeExisting(row) };
    for (const key of candidateIdentityKeys({
      company: row[3], title: row[4], location: row[5], canonical_url: row[8], job_id: row[9],
    })) byIdentity.set(key, existing);
    if (row[28]) byIdentity.set(String(row[28]), existing);
  }

  const numericSequences = leadRows
    .map((row) => String(row[0] ?? "").match(/^L-\d{8}-(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  let sequence = Math.max(leadRows.filter((row) => row[0]).length, ...numericSequences, 0) + 1;
  const alertCandidates = new Map();
  const writtenRows = new Map();
  const outcomes = [];

  for (const event of payload.scan_events) {
    const eventUrl = normalizeUrl(event.canonical_url ?? event.url ?? "");
    const eventKey = event.canonical_key ?? canonicalKey({ ...event, canonical_url: eventUrl });
    if (!normalizeText(event.finder) || !normalizeText(event.outcome) || !normalizeText(event.reason) || !validDate(event.examined_at)) {
      throw new Error("Each scan event requires finder, examined_at, outcome, and reason");
    }
    if (event.destination !== "Scan Log") throw new Error("Each scan event destination must be Scan Log");
    if (!eventUrl && !(normalizeText(event.company) && normalizeText(event.title))) {
      throw new Error("Each scan event requires a URL or company/title identity");
    }
    appendStyledRow(scanTable, scanSheet, [
      payload.run_id, new Date(event.examined_at), eventKey,
      event.company ?? null, event.title ?? null, eventUrl || null, event.outcome ?? "Examined",
      event.reason ?? null, event.finder ?? null, event.preliminary_score ?? null, null,
      event.eligibility ?? null, event.confidence ?? null, event.description_hash ?? null,
      event.source ?? null, event.job_id ?? null, event.location ?? null, event.work_type ?? null,
      event.first_seen ? new Date(event.first_seen) : now, now, event.destination ?? "Scan Log",
      event.detail_sheet ?? null, event.legacy_source_row ?? null, JSON.stringify(event),
    ], "X", {
      numberFormats: { B: "yyyy-mm-dd hh:mm", S: "yyyy-mm-dd", T: "yyyy-mm-dd" },
      rowHeight: 54,
    });
  }

  for (const raw of payload.candidates) {
    let candidate;
    if (raw.judge_status === "Needs Judge" || raw.eligibility === "Needs Judge") {
      candidate = pendingCandidate(raw);
    } else {
      if (!raw.finder_eligibility || !raw.judge_eligibility || !normalizeText(raw.finder_eligibility_evidence) || !normalizeText(raw.judge_eligibility_evidence)) {
        throw new Error("Judged candidate requires finder/judge eligibility and both evidence fields");
      }
      if (!ELIGIBILITY_DECISIONS.has(raw.finder_eligibility) || !ELIGIBILITY_DECISIONS.has(raw.judge_eligibility)) {
        throw new Error("finder_eligibility and judge_eligibility must be Eligible, Unclear, or Ineligible");
      }
      if (!LISTING_STATUS.has(raw.listing_status)) throw new Error("Judged candidate requires listing_status Active, Expired, or Inaccessible");
      const judgedDescription = normalizeText(raw.job_description ?? raw.description);
      if (!/^[a-f0-9]{64}$/i.test(String(raw.description_hash ?? ""))) throw new Error("Judged candidate requires a SHA-256 description_hash");
      if (raw.description_hash.toLowerCase() !== descriptionHash(judgedDescription)) throw new Error("Judged description_hash does not match the normalized job description");
      candidate = validateJudgedCandidate({
        ...raw,
        eligibility: raw.judge_eligibility,
        eligibility_evidence: raw.judge_eligibility_evidence,
        description_hash: raw.description_hash.toLowerCase(),
      });
      const eligibilityDisagreement = raw.finder_eligibility !== raw.judge_eligibility;
      const unavailableHardGate = candidate.eligibility === "Ineligible" && candidate.listing_status !== "Active";
      if (candidate.unsupported_evidence || (eligibilityDisagreement && !unavailableHardGate)) {
        candidate = {
          ...candidate,
          eligibility: "Needs Human Review",
          eligibility_evidence: [
            "Finder: " + normalizeText(raw.finder_eligibility_evidence),
            "Judge: " + normalizeText(raw.judge_eligibility_evidence),
            candidate.unsupported_evidence ? "Judge flagged unsupported candidate evidence." : null,
            eligibilityDisagreement ? "Finder and judge disagreed on eligibility." : null,
          ].filter(Boolean).join(" "),
          recommendation: recommendationBand(candidate.final_score, "Needs Human Review"),
        };
      }
    }
    const identityKeys = candidateIdentityKeys(candidate);
    const existing = identityKeys.map((key) => byIdentity.get(key)).find(Boolean);
    if (!candidate.job_id && existing?.job_id) candidate.job_id = existing.job_id;
    if (existing?.canonical_key?.startsWith("job:") && !candidate.canonical_key.startsWith("job:")) {
      candidate.canonical_key = existing.canonical_key;
    }
    candidate.lead_id = existing?.lead_id ?? ("L-" + now.toISOString().slice(0, 10).replaceAll("-", "") + "-" + String(sequence++).padStart(3, "0"));
    alertCandidates.delete(candidate.lead_id);
    const alert = existing?.status === "Dismissed" ? false : shouldRepeatAlert(existing, candidate, alertThreshold);
    const thresholdScore = candidate.final_score ?? Number(raw.preliminary_score ?? 0);
    const viable = thresholdScore >= leadThreshold && candidate.eligibility !== "Ineligible";
    let outcome;

    if (viable) {
      const values = rowValues(candidate, existing, false);
      let excelRow;
      if (existing) {
        excelRow = 4 + existing.index;
        leadsSheet.getRange("A" + excelRow + ":AK" + excelRow).values = [values];
        outcome = "Updated Lead";
      } else {
        excelRow = appendStyledRow(leadsTable, leadsSheet, values, "AK", LEAD_ROW_OPTIONS);
        outcome = "Added Lead";
      }
      const nextExisting = {
        index: existing?.index ?? leadRows.length + outcomes.filter((item) => item.outcome === "Added Lead").length,
        row: values,
        ...serializeExisting(values),
      };
      for (const key of identityKeys) byIdentity.set(key, nextExisting);
      byIdentity.set(candidate.canonical_key, nextExisting);
      writtenRows.set(candidate.lead_id, excelRow);
      if (alert && isAlertable(candidate, alertThreshold)) {
        alertCandidates.set(candidate.lead_id, { ...candidate, lead_id: candidate.lead_id });
      }
    } else if (existing && candidate.eligibility === "Ineligible") {
      const values = rowValues(candidate, existing, false);
      if (candidate.listing_status !== "Active") {
        values[26] = "Expired";
        values[34] = candidate.next_action ?? "Listing unavailable; stop application preparation";
      }
      const excelRow = 4 + existing.index;
      leadsSheet.getRange("A" + excelRow + ":AK" + excelRow).values = [values];
      const nextExisting = { index: existing.index, row: values, ...serializeExisting(values) };
      for (const key of identityKeys) byIdentity.set(key, nextExisting);
      byIdentity.set(candidate.canonical_key, nextExisting);
      writtenRows.set(candidate.lead_id, excelRow);
      outcome = "Suppressed Existing Lead";
    } else {
      outcome = "Suppressed";
    }

    const reason = candidate.eligibility === "Ineligible"
      ? candidate.eligibility_evidence ?? "Explicit eligibility blocker"
      : candidate.eligibility === "Needs Judge" ? "Pending independent judge"
      : candidate.final_score < leadThreshold ? "Final score below configured lead threshold" : "Processed";
    appendStyledRow(scanTable, scanSheet, [
      payload.run_id, now, candidate.canonical_key, candidate.company, candidate.title, candidate.canonical_url,
      outcome, reason, raw.finder ?? null, raw.preliminary_score ?? null, candidate.final_score ?? null,
      candidate.eligibility, candidate.confidence, candidate.description_hash, candidate.source ?? null,
      candidate.job_id ?? null, candidate.location ?? null, candidate.work_type ?? null,
      raw.first_seen ? new Date(raw.first_seen) : now, now, viable ? "Leads" : "Scan Log", null, null, JSON.stringify(raw),
    ], "X", {
      numberFormats: { B: "yyyy-mm-dd hh:mm", S: "yyyy-mm-dd", T: "yyyy-mm-dd" },
      rowHeight: 54,
    });
    outcomes.push({ lead_id: candidate.lead_id, canonical_key: candidate.canonical_key, outcome });
  }

  const selectedAlerts = [...alertCandidates.values()].sort((a, b) => b.final_score - a.final_score).slice(0, configuredMaxAlerts);
  for (const selected of selectedAlerts) {
    const excelRow = writtenRows.get(selected.lead_id);
    if (!excelRow) throw new Error("Cannot locate selected alert row: " + selected.lead_id);
    leadsSheet.getRange("AB" + excelRow).values = [[now]];
  }
  const errors = Array.isArray(payload.errors) ? payload.errors.join(" | ") : payload.errors ?? null;
  appendStyledRow(runTable, runSheet, [
    payload.run_id,
    new Date(payload.started_at),
    now,
    payload.status,
    payload.agents.backend_finder,
    payload.agents.ai_product_finder,
    payload.agents.job_judge,
    payload.queries,
    counts.found,
    counts.unique,
    counts.evaluated,
    counts.judged,
    outcomes.filter((item) => item.outcome === "Added Lead").length,
    0,
    outcomes.filter((item) => item.outcome.startsWith("Suppressed")).length,
    selectedAlerts.length,
    errors,
    payload.notes ?? null,
  ], "R", {
    numberFormats: { B: "yyyy-mm-dd hh:mm", C: "yyyy-mm-dd hh:mm", "H:P": "0" },
  });

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "updater formula error scan",
  });
  if (/#[A-Z0-9/]+[!?]/.test(formulaErrors.ndjson)) throw new Error("Formula validation failed: " + formulaErrors.ndjson);

  const result = { run_id: payload.run_id, outcomes, alerts: selectedAlerts };
  const resultTempPath = path.join(stateDir, ".last-run-" + String(payload.run_id).replace(/[^a-z0-9_-]/gi, "_") + ".tmp.json");
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(tempPath);
  await fs.writeFile(resultTempPath, JSON.stringify(result, null, 2));
  await fs.rename(tempPath, workbookPath);

  const stateWarnings = [];
  try {
    await removeWorkbookInspection(tempPath);
  } catch (error) {
    stateWarnings.push("Workbook committed; temporary inspection artifact could not be removed: " + String(error));
  }
  try {
    await fs.rename(resultTempPath, path.join(stateDir, "last-run.json"));
  } catch (error) {
    stateWarnings.push("Workbook committed; last-run state remains at " + resultTempPath + ": " + String(error));
  }
  try {
    await fs.rm(pendingPath, { force: true });
  } catch (error) {
    stateWarnings.push("Workbook committed; old pending marker could not be removed: " + String(error));
  }
  console.log(JSON.stringify({ ...result, state_warnings: stateWarnings }, null, 2));
} catch (error) {
  try {
    await removeTemporaryWorkbook(tempPath, workbookPath);
  } catch {
    // A lock or conflicting directory must not prevent the pending payload from being preserved.
  }
  await fs.writeFile(pendingPath, JSON.stringify({ payload, error: String(error?.stack ?? error) }, null, 2));
  throw error;
}
