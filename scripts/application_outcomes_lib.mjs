import { normalizeText, RESUMES } from "./job_tracker_lib.mjs";

export const OUTCOME_TYPES = new Set([
  "Applied", "Screening", "Interview", "Rejected", "Offer", "Withdrawn", "Accepted", "Ghosted",
]);

export const OUTCOME_STAGES = new Set([
  "Applied", "Recruiter Screen", "Assessment", "Technical", "System Design", "Hiring Manager", "Final",
  "Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted",
]);

const POSITIVE_OUTCOMES = new Set(["Screening", "Interview", "Offer", "Accepted"]);
const TERMINAL_OUTCOMES = new Set(["Rejected", "Withdrawn", "Ghosted", "Accepted"]);
const OUTCOME_STAGE_MATCH = new Map([
  ["Applied", new Set(["Applied"])],
  ["Screening", new Set(["Recruiter Screen"])],
  ["Interview", new Set(["Assessment", "Technical", "System Design", "Hiring Manager", "Final"])],
  ["Rejected", new Set(["Rejected"])],
  ["Offer", new Set(["Offer"])],
  ["Withdrawn", new Set(["Withdrawn"])],
  ["Accepted", new Set(["Accepted"])],
  ["Ghosted", new Set(["Ghosted"])],
]);

function requiredText(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(label + " must be a non-empty string");
  return text;
}

function validTimestamp(value, label) {
  const text = requiredText(value, label);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(label + " must be a valid timestamp");
  return date;
}

export function validateApplicationOutcome(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Outcome payload must be an object");
  if (raw.schema_version !== 1) throw new Error("Unsupported outcome schema_version: " + raw.schema_version);
  const outcome = requiredText(raw.outcome, "outcome");
  const stage = requiredText(raw.stage, "stage");
  if (!OUTCOME_TYPES.has(outcome)) throw new Error("Invalid outcome: " + outcome);
  if (!OUTCOME_STAGES.has(stage)) throw new Error("Invalid outcome stage: " + stage);
  if (!OUTCOME_STAGE_MATCH.get(outcome).has(stage)) throw new Error(`${outcome} outcome is incompatible with stage ${stage}`);
  if (raw.user_confirmed !== true) throw new Error("Outcome must be explicitly user_confirmed");
  const occurredAt = validTimestamp(raw.occurred_at, "occurred_at");
  const eventId = requiredText(raw.event_id, "event_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,100}$/.test(eventId)) throw new Error("event_id has an invalid format");
  const leadId = requiredText(raw.lead_id, "lead_id");
  return {
    schema_version: 1,
    event_id: eventId,
    lead_id: leadId,
    occurred_at: occurredAt.toISOString(),
    outcome,
    stage,
    reason_category: normalizeText(raw.reason_category) || null,
    notes: normalizeText(raw.notes) || null,
    user_confirmed: true,
  };
}

export function applicationStatusForOutcome(outcome) {
  if (outcome === "Screening") return "Screening";
  if (outcome === "Interview") return "Interview";
  if (outcome === "Offer" || outcome === "Accepted") return "Offer";
  if (outcome === "Rejected" || outcome === "Ghosted") return "Rejected";
  if (outcome === "Withdrawn") return "Withdrawn";
  return "Applied";
}

function scoreBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "Unscored";
  if (value >= 90) return "90–100";
  if (value >= 80) return "80–89";
  if (value >= 70) return "70–79";
  return "Below 70";
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarizeGroup(name, records) {
  const leads = new Map();
  for (const record of records) {
    const lead = leads.get(record.lead_id) ?? new Set();
    lead.add(record.outcome);
    leads.set(record.lead_id, lead);
  }
  const outcomes = [...leads.values()];
  const applications = outcomes.length;
  const screening = outcomes.filter((values) => [...values].some((value) => POSITIVE_OUTCOMES.has(value))).length;
  const interviews = outcomes.filter((values) => [...values].some((value) => ["Interview", "Offer", "Accepted"].includes(value))).length;
  const offers = outcomes.filter((values) => values.has("Offer") || values.has("Accepted")).length;
  return {
    group: name,
    applications,
    screening,
    interviews,
    offers,
    screening_rate: ratio(screening, applications),
    interview_rate: ratio(interviews, applications),
    offer_rate: ratio(offers, applications),
    evidence_status: applications >= 5 ? "Directional" : "Insufficient sample",
  };
}

export function buildOutcomeCalibration(records) {
  if (!Array.isArray(records)) throw new Error("Outcome calibration records must be an array");
  const normalized = records.filter((record) => record?.lead_id && OUTCOME_TYPES.has(record.outcome)).map((record) => ({
    ...record,
    score_band: scoreBand(record.final_score),
    resume_version: RESUMES.has(record.resume_version) ? record.resume_version : "Unknown",
  }));
  const groupBy = (field) => {
    const groups = new Map();
    for (const record of normalized) {
      const key = record[field];
      const rows = groups.get(key) ?? [];
      rows.push(record);
      groups.set(key, rows);
    }
    return [...groups.entries()].map(([name, rows]) => summarizeGroup(name, rows));
  };
  const overall = summarizeGroup("All applications", normalized);
  const warnings = [];
  if (overall.applications < 5) warnings.push("Fewer than five applications have recorded outcomes; calibration is not yet directional.");
  if (!normalized.some((record) => TERMINAL_OUTCOMES.has(record.outcome))) warnings.push("No terminal outcomes are recorded yet.");
  return {
    policy_mutation: false,
    generated_from_events: normalized.length,
    overall,
    by_score_band: groupBy("score_band"),
    by_resume: groupBy("resume_version"),
    warnings,
    recommendation: "Use these observations for human review only; scoring thresholds and weights are never changed automatically.",
  };
}
