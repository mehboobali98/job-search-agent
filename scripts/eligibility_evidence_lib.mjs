import fs from "node:fs/promises";
import { normalizeText } from "./job_tracker_lib.mjs";

export const ELIGIBILITY_TOPICS = new Set([
  "Hiring country", "Remote region", "Sponsorship", "Relocation", "Work authorization",
]);
export const ELIGIBILITY_CONCLUSIONS = new Set(["Supports", "Blocks", "Unclear"]);
export const EVIDENCE_CONFIDENCE = new Set(["High", "Medium", "Low"]);

function requiredText(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(label + " must be a non-empty string");
  return text;
}

function dateOnly(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(label + " must use YYYY-MM-DD");
  const parsed = new Date(text + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(label + " is not a valid date");
  }
  return text;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  const values = value.map((item, index) => requiredText(item, `${label}[${index}]`));
  if (new Set(values.map((item) => item.toLowerCase())).size !== values.length) {
    throw new Error(label + " contains duplicates");
  }
  return values;
}

function httpsUrl(value, label) {
  const text = requiredText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(label + " must be a valid URL"); }
  if (parsed.protocol !== "https:") throw new Error(label + " must use https");
  parsed.hash = "";
  return parsed.toString();
}

function validateOverride(value, label, observedAt) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  const conclusion = requiredText(value.conclusion, label + ".conclusion");
  if (!ELIGIBILITY_CONCLUSIONS.has(conclusion)) throw new Error(label + ".conclusion is invalid");
  const confirmedAt = dateOnly(value.confirmed_at, label + ".confirmed_at");
  const expiresAt = dateOnly(value.expires_at, label + ".expires_at");
  if (confirmedAt < observedAt) throw new Error(label + ".confirmed_at cannot precede the source observation");
  if (expiresAt < confirmedAt) throw new Error(label + ".expires_at cannot precede confirmed_at");
  return {
    conclusion,
    reason: requiredText(value.reason, label + ".reason"),
    confirmed_at: confirmedAt,
    expires_at: expiresAt,
  };
}

export function validateEligibilityRegistry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Eligibility evidence registry must be an object");
  if (raw.version !== 1) throw new Error("Unsupported eligibility evidence registry version: " + raw.version);
  if (!Array.isArray(raw.entries)) throw new Error("Eligibility evidence registry requires entries[]");
  const entries = raw.entries.map((value, index) => {
    const label = `entries[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
    const id = requiredText(value.id, label + ".id");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(label + ".id must be a lowercase slug");
    const topic = requiredText(value.topic, label + ".topic");
    if (!ELIGIBILITY_TOPICS.has(topic)) throw new Error(label + ".topic is invalid");
    const conclusion = requiredText(value.conclusion, label + ".conclusion");
    if (!ELIGIBILITY_CONCLUSIONS.has(conclusion)) throw new Error(label + ".conclusion is invalid");
    const confidence = requiredText(value.confidence, label + ".confidence");
    if (!EVIDENCE_CONFIDENCE.has(confidence)) throw new Error(label + ".confidence is invalid");
    const status = requiredText(value.status ?? "Active", label + ".status");
    if (!["Active", "Superseded"].includes(status)) throw new Error(label + ".status is invalid");
    const observedAt = dateOnly(value.observed_at, label + ".observed_at");
    const expiresAt = dateOnly(value.expires_at, label + ".expires_at");
    if (expiresAt < observedAt) throw new Error(label + ".expires_at cannot precede observed_at");
    const applies = value.applies_to;
    if (!applies || typeof applies !== "object" || Array.isArray(applies)) throw new Error(label + ".applies_to must be an object");
    const appliesTo = {
      global: applies.global === true,
      companies: stringList(applies.companies, label + ".applies_to.companies"),
      locations: stringList(applies.locations, label + ".applies_to.locations"),
      sources: stringList(applies.sources, label + ".applies_to.sources"),
    };
    const scoped = appliesTo.companies.length + appliesTo.locations.length + appliesTo.sources.length;
    if (!appliesTo.global && scoped === 0) throw new Error(label + ".applies_to must be global or have at least one scope value");
    if (appliesTo.global && scoped > 0) throw new Error(label + ".applies_to cannot combine global with scoped values");
    return {
      id,
      topic,
      applies_to: appliesTo,
      conclusion,
      statement: requiredText(value.statement, label + ".statement"),
      source_url: httpsUrl(value.source_url, label + ".source_url"),
      observed_at: observedAt,
      expires_at: expiresAt,
      confidence,
      status,
      override: validateOverride(value.override, label + ".override", observedAt),
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Eligibility evidence registry contains duplicate IDs");
  return { version: 1, entries };
}

function asOfDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return dateOnly(value ?? new Date().toISOString().slice(0, 10), "asOf");
}

export function effectiveEligibilityEvidence(entry, asOf = new Date()) {
  const date = asOfDate(asOf);
  const conclusion = entry.override?.conclusion ?? entry.conclusion;
  const expiresAt = entry.override?.expires_at ?? entry.expires_at;
  const state = entry.status === "Superseded" ? "Superseded" : expiresAt < date ? "Expired" : "Active";
  return {
    ...entry,
    effective_conclusion: conclusion,
    effective_expires_at: expiresAt,
    evidence_state: state,
    override_applied: Boolean(entry.override),
  };
}

export function eligibilityRegistrySnapshot(raw, { asOf = new Date() } = {}) {
  const registry = validateEligibilityRegistry(raw);
  const entries = registry.entries.map((entry) => effectiveEligibilityEvidence(entry, asOf));
  const active = entries.filter((entry) => entry.evidence_state === "Active");
  const expired = entries.filter((entry) => entry.evidence_state === "Expired");
  const superseded = entries.filter((entry) => entry.evidence_state === "Superseded");
  const warnings = [
    ...expired.map((entry) => `Eligibility evidence ${entry.id} expired on ${entry.effective_expires_at}.`),
    ...superseded.map((entry) => `Eligibility evidence ${entry.id} is superseded.`),
  ];
  return {
    version: 1,
    as_of: asOfDate(asOf),
    active_entries: active,
    expired_entries: expired,
    superseded_entries: superseded,
    warnings,
  };
}

function normalized(value) {
  return normalizeText(value).toLowerCase();
}

function matchesScopedValue(values, candidates, { contains = false } = {}) {
  if (!values.length) return true;
  return values.some((value) => candidates.some((candidate) => (
    contains ? normalized(candidate).includes(normalized(value)) : normalized(candidate) === normalized(value)
  )));
}

export function eligibilityEvidenceApplies(entry, candidate) {
  if (entry.applies_to.global) return true;
  let host = "";
  try { host = new URL(candidate.canonical_url ?? candidate.url ?? "").hostname; } catch { /* No URL host is a non-match for source scope. */ }
  return matchesScopedValue(entry.applies_to.companies, [candidate.company])
    && matchesScopedValue(entry.applies_to.locations, [candidate.location], { contains: true })
    && matchesScopedValue(entry.applies_to.sources, [candidate.source, host]);
}

export function assessEligibilityEvidence(raw, candidate, evidenceIds = [], { asOf = new Date() } = {}) {
  if (!Array.isArray(evidenceIds)) throw new Error("eligibility_evidence_ids must be an array");
  const ids = evidenceIds.map((id, index) => requiredText(id, `eligibility_evidence_ids[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error("eligibility_evidence_ids contains duplicates");
  const snapshot = eligibilityRegistrySnapshot(raw, { asOf });
  const byId = new Map([
    ...snapshot.active_entries,
    ...snapshot.expired_entries,
    ...snapshot.superseded_entries,
  ].map((entry) => [entry.id, entry]));
  const referenced = ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error("Unknown eligibility evidence ID: " + id);
    return entry;
  });
  const mismatched = referenced.filter((entry) => !eligibilityEvidenceApplies(entry, candidate));
  const applicable = referenced.filter((entry) => eligibilityEvidenceApplies(entry, candidate));
  const active = applicable.filter((entry) => entry.evidence_state === "Active");
  const stale = applicable.filter((entry) => entry.evidence_state !== "Active");
  const listingActive = candidate.listing_status === undefined || candidate.listing_status === "Active";
  const conflict = listingActive && active.some((entry) => (
    (entry.effective_conclusion === "Blocks" && candidate.eligibility === "Eligible")
    || (entry.effective_conclusion === "Supports" && candidate.eligibility === "Ineligible")
  ));
  const citations = active.map((entry) => (
    `${entry.id}: ${entry.statement} (${entry.source_url}; valid through ${entry.effective_expires_at})`
  ));
  const status = !ids.length ? "No references"
    : conflict ? "Conflict"
      : mismatched.length ? "Scope mismatch"
        : stale.length && !active.length ? "Stale only"
          : stale.length ? "Active with stale references" : "Active";
  return {
    evidence_ids: ids,
    status,
    active,
    stale,
    mismatched,
    conflict,
    citations,
    warnings: [
      ...stale.map((entry) => `Referenced eligibility evidence ${entry.id} is ${entry.evidence_state.toLowerCase()}.`),
      ...mismatched.map((entry) => `Referenced eligibility evidence ${entry.id} does not match this role's scope.`),
    ],
  };
}

export function eligibilityAssessmentText(assessment) {
  if (!assessment || assessment.status === "No references") return null;
  return [
    `Registry evidence status: ${assessment.status}.`,
    assessment.evidence_ids.length ? `Evidence IDs: ${assessment.evidence_ids.join(", ")}.` : null,
    assessment.citations.length ? `Citations: ${assessment.citations.join(" | ")}` : null,
    assessment.warnings.length ? assessment.warnings.join(" ") : null,
  ].filter(Boolean).join(" ");
}

export async function loadEligibilityRegistry(filePath, { allowMissing = false } = {}) {
  try {
    return validateEligibilityRegistry(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
}
