import crypto from "node:crypto";
import { canonicalKey, normalizeText, normalizeUrl } from "./job_tracker_lib.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function replayHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortedTexts(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => normalizeText(item)).filter(Boolean))].sort();
}

function candidateSnapshot(candidate) {
  return {
    canonical_key: candidate.canonical_key ?? canonicalKey(candidate),
    company: normalizeText(candidate.company),
    title: normalizeText(candidate.title),
    canonical_url: normalizeUrl(candidate.canonical_url),
    description_hash: normalizeText(candidate.description_hash).toLowerCase() || null,
    final_score: candidate.final_score ?? null,
    recommendation: normalizeText(candidate.recommendation) || null,
    eligibility: normalizeText(candidate.eligibility) || null,
    confidence: normalizeText(candidate.confidence) || null,
    judge_status: normalizeText(candidate.judge_status) || null,
    listing_status: normalizeText(candidate.listing_status) || null,
    best_resume: normalizeText(candidate.best_resume) || null,
    candidate_evidence_ids: sortedTexts(candidate.candidate_evidence_ids),
    eligibility_evidence_ids: sortedTexts(candidate.eligibility_evidence_ids),
  };
}

export function buildReplaySnapshot(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("Run replay input must be an object");
  const runId = normalizeText(run.run_id);
  if (!runId) throw new Error("Run replay input requires run_id");
  if (!Array.isArray(run.candidates) || !Array.isArray(run.scan_events)) throw new Error("Run replay input requires candidates[] and scan_events[]");
  const querySource = Array.isArray(run.replay_context?.query_plan) ? run.replay_context.query_plan : (run.query_attempts ?? []);
  const queries = querySource.map((query, index) => ({
    query_id: normalizeText(query.query_id) || `legacy-${index + 1}`,
    finder: normalizeText(query.finder) || null,
    role_family: normalizeText(query.role_family) || null,
    source: normalizeText(query.source) || null,
    lane: normalizeText(query.lane) || null,
    query: normalizeText(query.query) || null,
    status: normalizeText(query.status) || null,
  })).sort((left, right) => left.query_id.localeCompare(right.query_id));
  const candidates = run.candidates.map(candidateSnapshot).sort((left, right) => left.canonical_key.localeCompare(right.canonical_key));
  const snapshot = {
    schema_version: 1,
    run_id: runId,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    status: run.status ?? null,
    agents: run.agents ?? {},
    counts: Object.fromEntries(["queries", "found", "unique", "evaluated", "judged"].map((field) => [field, run[field] ?? null])),
    queries,
    filters: run.replay_context?.filters ?? {},
    config: run.replay_context?.config ?? {},
    evidence: run.replay_context?.evidence ?? {},
    candidates,
    scan_event_count: run.scan_events.length,
    errors: Array.isArray(run.errors) ? [...run.errors] : [],
  };
  return { ...snapshot, replay_hash: replayHash(snapshot) };
}

function flatten(value, prefix = "", output = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
  } else output.set(prefix, canonicalJson(value));
  return output;
}

function changedFields(before, after) {
  const left = flatten(before);
  const right = flatten(after);
  return [...new Set([...left.keys(), ...right.keys()])].sort().filter((key) => left.get(key) !== right.get(key)).map((key) => ({
    field: key,
    before: left.has(key) ? JSON.parse(left.get(key)) : null,
    after: right.has(key) ? JSON.parse(right.get(key)) : null,
  }));
}

function compareKeyed(before, after, keyField) {
  const left = new Map(before.map((item) => [item[keyField], item]));
  const right = new Map(after.map((item) => [item[keyField], item]));
  const added = [...right.keys()].filter((key) => !left.has(key)).sort();
  const removed = [...left.keys()].filter((key) => !right.has(key)).sort();
  const changed = [...left.keys()].filter((key) => right.has(key)).sort().map((key) => ({
    key,
    changes: changedFields(left.get(key), right.get(key)),
  })).filter((item) => item.changes.length);
  return { added, removed, changed };
}

export function compareReplaySnapshots(before, after) {
  if (!before?.replay_hash || !after?.replay_hash) throw new Error("Both replay snapshots require replay_hash");
  const queries = compareKeyed(before.queries ?? [], after.queries ?? [], "query_id");
  const candidates = compareKeyed(before.candidates ?? [], after.candidates ?? [], "canonical_key");
  const filters = changedFields(before.filters ?? {}, after.filters ?? {});
  const config = changedFields(before.config ?? {}, after.config ?? {});
  const evidence = changedFields(before.evidence ?? {}, after.evidence ?? {});
  const counts = changedFields(before.counts ?? {}, after.counts ?? {});
  const explanations = [];
  if (queries.added.length || queries.removed.length || queries.changed.length) explanations.push("The generated or attempted query set changed.");
  if (filters.length) explanations.push("One or more screening filters changed.");
  if (config.length) explanations.push("Run configuration changed.");
  if (evidence.length) explanations.push("The run-level evidence snapshot changed.");
  if (candidates.added.length || candidates.removed.length) explanations.push("The discovered candidate set changed.");
  if (candidates.changed.length) explanations.push("Evidence or decisions changed for candidates present in both runs.");
  if (!explanations.length && before.replay_hash !== after.replay_hash) explanations.push("Only run metadata or timestamps changed.");
  return {
    schema_version: 1,
    before: { run_id: before.run_id, replay_hash: before.replay_hash },
    after: { run_id: after.run_id, replay_hash: after.replay_hash },
    identical: before.replay_hash === after.replay_hash,
    queries, filters, config, evidence, candidates, counts, explanations,
  };
}
