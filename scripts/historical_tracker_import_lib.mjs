import crypto from "node:crypto";
import {
  candidateIdentityKeys,
  CONFIDENCE,
  ELIGIBILITY,
  normalizeText,
  normalizeUrl,
  RESUMES,
} from "./job_tracker_lib.mjs";

export const HISTORICAL_IMPORT_SCHEMA_VERSION = 1;
export const MAX_HISTORICAL_IMPORT_SHEETS = 20;
export const MAX_HISTORICAL_IMPORT_ROWS = 10_000;
export const MAX_HISTORICAL_IMPORT_COLUMNS = 100;
export const MAX_HISTORICAL_IMPORT_FILE_BYTES = 50_000_000;

export const HISTORICAL_IMPORT_CLASSIFICATIONS = Object.freeze({
  EMPTY_ROW: "empty_row",
  MALFORMED_ROW: "malformed_row",
  DUPLICATE_IN_SOURCE: "duplicate_in_source",
  CONFLICT_IN_SOURCE: "conflict_in_source",
  DUPLICATE_LEAD_IN_TRACKER: "duplicate_lead_in_tracker",
  DUPLICATE_APPLICATION_IN_TRACKER: "duplicate_application_in_tracker",
  CONFLICT_IN_TRACKER: "conflict_in_tracker",
  NEW_LEAD: "new_lead",
  NEW_APPLICATION: "new_application",
  APPLICATION_LINKED_TO_EXISTING_LEAD: "application_linked_to_existing_lead",
  LIMIT_EXCEEDED: "limit_exceeded",
});

export const HISTORICAL_MAPPING_FIELDS = Object.freeze([
  "company", "title", "location", "work_type", "source", "canonical_url", "job_id", "posted_date",
  "first_seen", "last_seen", "eligibility", "confidence", "best_resume", "final_score", "lead_status",
  "date_applied", "application_status", "current_stage", "next_follow_up", "salary_posted",
  "salary_expectation", "notes", "next_action",
]);

export const LEAD_STATUSES = new Set(["New", "Review", "Shortlisted", "Preparing", "Dismissed", "Expired", "Moved to Applications"]);
export const APPLICATION_STATUSES = new Set([
  "Draft", "Applied", "Submitted", "Skipped", "Not needed", "Not generated", "Screening", "Interview", "Offer", "Rejected", "Withdrawn",
]);
export const APPLICATION_STAGES = new Set([
  "Interested", "Evaluating", "Preparing", "Applied", "Recruiter Screen", "Assessment", "Technical", "System Design",
  "Hiring Manager", "Final", "Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted", "Not applying",
]);

const ALLOWED_MAPPING_FIELDS = new Set(HISTORICAL_MAPPING_FIELDS);
const LARGE_TEXT_FIELDS = new Set(["notes", "next_action"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function requiredText(value, label, maximum) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  return text;
}

function normalizeChoice(value, allowed, label) {
  const text = normalizeText(value);
  if (!text) return null;
  const match = [...allowed].find((entry) => entry.toLowerCase() === text.toLowerCase());
  if (!match) throw new Error(`${label} contains an unsupported value`);
  return match;
}

export function validateHistoricalImportSpec(raw) {
  if (!isPlainObject(raw)) throw new Error("Historical import mapping must be an object");
  exactKeys(raw, new Set(["schema_version", "import_id", "imported_at", "sheets"]), "Historical import mapping");
  if (raw.schema_version !== HISTORICAL_IMPORT_SCHEMA_VERSION) throw new Error("Unsupported historical import schema_version");
  const importId = requiredText(raw.import_id, "import_id", 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(importId)) throw new Error("import_id must be an opaque slug");
  if (typeof raw.imported_at !== "string" || !Number.isFinite(new Date(raw.imported_at).getTime())) {
    throw new Error("imported_at must be a timestamp");
  }
  if (!Array.isArray(raw.sheets) || raw.sheets.length < 1 || raw.sheets.length > MAX_HISTORICAL_IMPORT_SHEETS) {
    throw new Error(`sheets must contain 1-${MAX_HISTORICAL_IMPORT_SHEETS} mappings`);
  }
  const seenSheets = new Set();
  const sheets = raw.sheets.map((sheet, index) => {
    if (!isPlainObject(sheet)) throw new Error(`sheets[${index}] must be an object`);
    exactKeys(sheet, new Set(["sheet_name", "record_type", "header_row", "columns"]), `sheets[${index}]`);
    const sheetName = requiredText(sheet.sheet_name, `sheets[${index}].sheet_name`, 31);
    if (seenSheets.has(sheetName.toLowerCase())) throw new Error(`Duplicate sheet mapping: ${sheetName}`);
    seenSheets.add(sheetName.toLowerCase());
    if (!["lead", "application"].includes(sheet.record_type)) throw new Error(`sheets[${index}].record_type must be lead or application`);
    if (!Number.isInteger(sheet.header_row) || sheet.header_row < 1 || sheet.header_row > 100) {
      throw new Error(`sheets[${index}].header_row must be an integer from 1 to 100`);
    }
    if (!isPlainObject(sheet.columns)) throw new Error(`sheets[${index}].columns must be an object`);
    exactKeys(sheet.columns, ALLOWED_MAPPING_FIELDS, `sheets[${index}].columns`);
    for (const required of ["company", "title"]) {
      if (sheet.columns[required] === undefined) throw new Error(`sheets[${index}].columns.${required} is required`);
    }
    const columns = {};
    const seenHeaders = new Set();
    for (const [field, header] of Object.entries(sheet.columns)) {
      const text = requiredText(header, `sheets[${index}].columns.${field}`, 256);
      const normalized = normalizeText(text).toLowerCase();
      if (seenHeaders.has(normalized)) throw new Error(`sheets[${index}].columns maps the same header more than once: ${text}`);
      seenHeaders.add(normalized);
      columns[field] = text;
    }
    return { sheet_name: sheetName, record_type: sheet.record_type, header_row: sheet.header_row, columns };
  });
  return {
    schema_version: HISTORICAL_IMPORT_SCHEMA_VERSION,
    import_id: importId,
    imported_at: new Date(raw.imported_at).toISOString(),
    sheets,
  };
}

function workbookDate(value, label) {
  if (value === null || value === undefined || value === "") return null;
  let parsed;
  if (value instanceof Date) parsed = new Date(value);
  else if (typeof value === "number" && Number.isFinite(value)) parsed = new Date(Math.round((value - 25569) * 86_400_000));
  else {
    const text = normalizeText(value);
    if (!text) return null;
    parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + "T12:00:00Z") : new Date(text);
  }
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is not a valid date`);
  return parsed.toISOString();
}

function boundedText(value, field) {
  const text = normalizeText(value);
  if (!text) return null;
  const maximum = LARGE_TEXT_FIELDS.has(field) ? 20_000 : 2_048;
  if (text.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return text;
}

function optionalScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("final_score must be from 0 to 100");
  return score;
}

function optionalUrl(value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (text.length > 2_048) throw new Error("canonical_url exceeds 2048 characters");
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error("canonical_url must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("canonical_url must be an absolute HTTP(S) URL");
  return normalizeUrl(parsed.toString());
}

export function historicalRecordReference(importId, sheetName, rowNumber) {
  return "HREF-" + crypto.createHash("sha256").update(`${importId}\u0000${sheetName}\u0000${rowNumber}`).digest("hex").slice(0, 24);
}

export function normalizeHistoricalRecord(raw, { importId, importedAt, sheetName, rowNumber, recordType }) {
  if (!isPlainObject(raw)) throw new Error("Historical source row must be an object");
  const company = boundedText(raw.company, "company");
  const title = boundedText(raw.title, "title");
  if (!company || !title) throw new Error("company and title are required");
  const record = {
    record_type: recordType,
    source_ref: historicalRecordReference(importId, sheetName, rowNumber),
    legacy_source_row: `${importId}:${sheetName}:${rowNumber}`,
    company,
    title,
    location: boundedText(raw.location, "location"),
    work_type: boundedText(raw.work_type, "work_type"),
    source: boundedText(raw.source, "source") ?? "Historical tracker import",
    canonical_url: optionalUrl(raw.canonical_url),
    job_id: boundedText(raw.job_id, "job_id"),
    posted_date: workbookDate(raw.posted_date, "posted_date"),
    first_seen: workbookDate(raw.first_seen, "first_seen"),
    last_seen: workbookDate(raw.last_seen, "last_seen"),
    eligibility: normalizeChoice(raw.eligibility, ELIGIBILITY, "eligibility"),
    confidence: normalizeChoice(raw.confidence, CONFIDENCE, "confidence"),
    best_resume: normalizeChoice(raw.best_resume, RESUMES, "best_resume"),
    final_score: optionalScore(raw.final_score),
    lead_status: normalizeChoice(raw.lead_status, LEAD_STATUSES, "lead_status"),
    date_applied: workbookDate(raw.date_applied, "date_applied"),
    application_status: normalizeChoice(raw.application_status, APPLICATION_STATUSES, "application_status"),
    current_stage: normalizeChoice(raw.current_stage, APPLICATION_STAGES, "current_stage"),
    next_follow_up: workbookDate(raw.next_follow_up, "next_follow_up"),
    salary_posted: boundedText(raw.salary_posted, "salary_posted"),
    salary_expectation: boundedText(raw.salary_expectation, "salary_expectation"),
    notes: boundedText(raw.notes, "notes"),
    next_action: boundedText(raw.next_action, "next_action"),
  };
  if (record.record_type === "application" && !record.application_status) {
    record.application_status = record.date_applied ? "Applied" : "Draft";
  }
  if (!record.first_seen) record.first_seen = record.date_applied ?? importedAt;
  if (!record.last_seen) record.last_seen = record.first_seen;
  if (new Date(record.last_seen) < new Date(record.first_seen)) throw new Error("last_seen cannot precede first_seen");
  record.identity_keys = candidateIdentityKeys(record);
  record.canonical_key = record.identity_keys[0];
  return record;
}

function recordFingerprint(record, type) {
  const keys = type === "application"
    ? ["company", "title", "location", "work_type", "source", "canonical_url", "job_id", "date_applied", "application_status", "current_stage", "next_follow_up", "salary_posted", "salary_expectation", "notes", "next_action"]
    : ["company", "title", "location", "work_type", "source", "canonical_url", "job_id", "posted_date", "first_seen", "last_seen", "eligibility", "confidence", "best_resume", "final_score", "lead_status", "notes", "next_action"];
  return crypto.createHash("sha256").update(JSON.stringify(keys.map((key) => record[key] ?? null))).digest("hex");
}

function targetIdentityMap(records) {
  const map = new Map();
  for (const record of records) {
    const keys = new Set(record.identity_keys ?? []);
    if (record.canonical_key) keys.add(String(record.canonical_key));
    for (const key of keys) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(record);
    }
  }
  return map;
}

function matchingTargets(keys, map) {
  const matches = new Set();
  for (const key of keys) for (const item of map.get(key) ?? []) matches.add(item);
  return [...matches];
}

function buildGroups(records) {
  const groups = [];
  const byKey = new Map();
  for (const record of records) {
    const matchedGroups = [...new Set(record.identity_keys.map((key) => byKey.get(key)).filter(Boolean))];
    let group;
    if (!matchedGroups.length) {
      group = { records: [], keys: new Set() };
      groups.push(group);
    } else {
      group = matchedGroups[0];
      for (const other of matchedGroups.slice(1)) {
        if (other === group) continue;
        for (const item of other.records) group.records.push(item);
        for (const key of other.keys) group.keys.add(key);
        groups.splice(groups.indexOf(other), 1);
      }
    }
    group.records.push(record);
    for (const key of record.identity_keys) {
      group.keys.add(key);
      byKey.set(key, group);
    }
    for (const key of group.keys) byKey.set(key, group);
  }
  return groups;
}

function classification(code, record, reason, extra = {}) {
  return { code, source_ref: record?.source_ref ?? null, reason, ...extra };
}

function nextLeadSequence(targetLeads) {
  const sequences = targetLeads
    .map((lead) => String(lead.lead_id ?? "").match(/^L-\d{8}-(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  return Math.max(targetLeads.filter((lead) => lead.lead_id).length, ...sequences, 0) + 1;
}

function newLeadId(record, sequence) {
  const date = new Date(record.first_seen);
  const datePart = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `L-${datePart}-${String(sequence).padStart(3, "0")}`;
}

function representative(records, type) {
  return records.find((record) => record.record_type === type) ?? records[0];
}

export function buildHistoricalImportPlan({
  spec,
  records,
  targetLeads = [],
  targetApplications = [],
  sourceSha256,
  sourceClassifications = [],
}) {
  spec = validateHistoricalImportSpec(spec);
  if (!Array.isArray(records) || !Array.isArray(targetLeads) || !Array.isArray(targetApplications)) throw new Error("Historical import plan requires record arrays");
  if (!/^[a-f0-9]{64}$/i.test(String(sourceSha256 ?? ""))) throw new Error("sourceSha256 must be a SHA-256 hex digest");
  if (!Array.isArray(sourceClassifications)) throw new Error("sourceClassifications must be an array");
  const classifications = [...sourceClassifications];
  const leadsToAdd = [];
  const applicationsToAdd = [];
  const targetLeadMap = targetIdentityMap(targetLeads);
  const targetApplicationMap = targetIdentityMap(targetApplications);
  let sequence = nextLeadSequence(targetLeads);

  for (const group of buildGroups(records)) {
    const leads = group.records.filter((record) => record.record_type === "lead");
    const applications = group.records.filter((record) => record.record_type === "application");
    let conflicted = false;
    for (const [type, typed] of [["lead", leads], ["application", applications]]) {
      if (typed.length <= 1) continue;
      const fingerprints = new Set(typed.map((record) => recordFingerprint(record, type)));
      if (fingerprints.size > 1) {
        for (const record of typed) classifications.push(classification(
          HISTORICAL_IMPORT_CLASSIFICATIONS.CONFLICT_IN_SOURCE,
          record,
          `Conflicting ${type} rows share the same deterministic identity; the identity was not imported.`,
        ));
        conflicted = true;
      } else {
        for (const record of typed.slice(1)) classifications.push(classification(
          HISTORICAL_IMPORT_CLASSIFICATIONS.DUPLICATE_IN_SOURCE,
          record,
          `Exact duplicate ${type} row was ignored.`,
        ));
      }
    }
    if (conflicted) continue;
    const leadRecord = representative(leads.length ? leads : applications, leads.length ? "lead" : "application");
    const applicationRecord = applications[0] ?? null;
    const existingLeads = matchingTargets(group.keys, targetLeadMap);
    const existingApplications = matchingTargets(group.keys, targetApplicationMap);
    if (existingLeads.length > 1 || existingApplications.length > 1) {
      classifications.push(classification(
        HISTORICAL_IMPORT_CLASSIFICATIONS.CONFLICT_IN_TRACKER,
        leadRecord,
        "The source identity matches multiple current tracker rows; current data was left unchanged.",
      ));
      continue;
    }
    let targetLead = existingLeads[0] ?? null;
    if (!targetLead && existingApplications[0]?.lead_id) {
      targetLead = targetLeads.find((lead) => lead.lead_id === existingApplications[0].lead_id) ?? null;
    }
    if (existingApplications.length && !targetLead) {
      classifications.push(classification(
        HISTORICAL_IMPORT_CLASSIFICATIONS.CONFLICT_IN_TRACKER,
        leadRecord,
        "The matching current application has no resolvable lead; current data was left unchanged.",
      ));
      continue;
    }
    if (!targetLead) {
      const leadId = newLeadId(leadRecord, sequence++);
      const operation = { ...leadRecord, lead_id: leadId, import_run_id: `HIST-${spec.import_id}` };
      leadsToAdd.push(operation);
      targetLead = operation;
      for (const key of group.keys) {
        if (!targetLeadMap.has(key)) targetLeadMap.set(key, []);
        targetLeadMap.get(key).push(operation);
      }
      classifications.push(classification(HISTORICAL_IMPORT_CLASSIFICATIONS.NEW_LEAD, leadRecord, "Historical lead will be appended.", { lead_id: leadId }));
    } else {
      classifications.push(classification(
        HISTORICAL_IMPORT_CLASSIFICATIONS.DUPLICATE_LEAD_IN_TRACKER,
        leadRecord,
        "Current tracker lead is authoritative; no lead fields will be overwritten.",
        { lead_id: targetLead.lead_id },
      ));
    }
    if (!applicationRecord) continue;
    if (existingApplications.length) {
      classifications.push(classification(
        HISTORICAL_IMPORT_CLASSIFICATIONS.DUPLICATE_APPLICATION_IN_TRACKER,
        applicationRecord,
        "Current tracker application is authoritative; no application fields will be overwritten.",
        { lead_id: targetLead.lead_id },
      ));
      continue;
    }
    const operation = { ...applicationRecord, lead_id: targetLead.lead_id, import_run_id: `HIST-${spec.import_id}` };
    applicationsToAdd.push(operation);
    classifications.push(classification(
      existingLeads.length ? HISTORICAL_IMPORT_CLASSIFICATIONS.APPLICATION_LINKED_TO_EXISTING_LEAD : HISTORICAL_IMPORT_CLASSIFICATIONS.NEW_APPLICATION,
      applicationRecord,
      existingLeads.length ? "Historical application will be linked to the existing lead." : "Historical application will be appended.",
      { lead_id: targetLead.lead_id },
    ));
  }

  const classificationCounts = Object.fromEntries(Object.values(HISTORICAL_IMPORT_CLASSIFICATIONS).map((code) => [code, 0]));
  for (const item of classifications) classificationCounts[item.code] += 1;
  return {
    schema_version: HISTORICAL_IMPORT_SCHEMA_VERSION,
    import_id: spec.import_id,
    import_run_id: `HIST-${spec.import_id}`,
    imported_at: spec.imported_at,
    source_sha256: String(sourceSha256).toLowerCase(),
    policy: {
      current_tracker_authoritative: true,
      overwrite_existing_fields: false,
      application_stage_regression_allowed: false,
    },
    diagnostics: {
      source_records: records.length,
      leads_to_add: leadsToAdd.length,
      applications_to_add: applicationsToAdd.length,
      classification_counts: classificationCounts,
    },
    classifications,
    operations: { leads_to_add: leadsToAdd, applications_to_add: applicationsToAdd },
  };
}

export function publicHistoricalImportSummary(plan, { mode = "preview", applied = false, alreadyCommitted = false } = {}) {
  return {
    schema_version: plan.schema_version,
    mode,
    import_id: plan.import_id,
    import_run_id: plan.import_run_id,
    applied,
    already_committed: alreadyCommitted,
    source_sha256: plan.source_sha256,
    policy: plan.policy,
    diagnostics: plan.diagnostics,
    classifications: plan.classifications,
  };
}
