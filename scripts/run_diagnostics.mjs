import { candidateIdentityKeys, isAlertable, normalizeText } from "./job_tracker_lib.mjs";
import { ROLE_FAMILIES } from "./search_query_lib.mjs";

const QUERY_ATTEMPT_STATUSES = new Set(["Completed", "Failed"]);
const FINDERS = new Set(["backend_finder", "ai_product_finder"]);
const MIN_UNIQUE_FOR_DEPTH_CHECK = 5;
const MIN_DEEP_EVALUATIONS = 3;
const MIN_EVALUATION_RATE = 0.2;

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function requiredText(value, label) {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(label + " must be a non-empty string");
  return normalized;
}

export function validateQueryAttempts(run) {
  if (run.query_attempts === undefined) return { available: false, attempts: [], byId: new Map() };
  if (!Array.isArray(run.query_attempts)) throw new Error("query_attempts must be an array when provided");
  if (run.query_attempts.length !== run.queries) throw new Error("query_attempts length must equal queries");

  const byId = new Map();
  const attempts = run.query_attempts.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`query_attempts[${index}] must be an object`);
    }
    const attempt = {
      query_id: requiredText(raw.query_id, `query_attempts[${index}].query_id`),
      finder: requiredText(raw.finder, `query_attempts[${index}].finder`),
      source: requiredText(raw.source, `query_attempts[${index}].source`),
      lane: requiredText(raw.lane, `query_attempts[${index}].lane`),
      role_family: normalizeText(raw.role_family) || null,
      status: requiredText(raw.status, `query_attempts[${index}].status`),
      error: normalizeText(raw.error) || null,
    };
    if (!FINDERS.has(attempt.finder)) throw new Error(`query_attempts[${index}] has an invalid finder`);
    if (attempt.role_family && !ROLE_FAMILIES.includes(attempt.role_family)) throw new Error(`query_attempts[${index}] has an invalid role_family`);
    if (!QUERY_ATTEMPT_STATUSES.has(attempt.status)) throw new Error(`query_attempts[${index}] has an invalid status`);
    if (attempt.status === "Failed" && !attempt.error) throw new Error(`query_attempts[${index}] requires error when status is Failed`);
    if (byId.has(attempt.query_id)) throw new Error("Duplicate query_attempts query_id: " + attempt.query_id);
    byId.set(attempt.query_id, attempt);
    return attempt;
  });

  for (const [collectionName, records] of [["candidates", run.candidates], ["scan_events", run.scan_events]]) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const queryId = requiredText(record.discovery_query_id, `${collectionName}[${index}].discovery_query_id`);
      const attempt = byId.get(queryId);
      if (!attempt) throw new Error(`${collectionName}[${index}] references unknown discovery_query_id: ${queryId}`);
      const finder = requiredText(record.finder, `${collectionName}[${index}].finder`);
      if (finder !== attempt.finder) throw new Error(`${collectionName}[${index}] finder does not match its query attempt`);
    }
  }

  return { available: true, attempts, byId };
}

function emptyMetric(attempt) {
  return {
    query_id: attempt.query_id,
    finder: attempt.finder,
    source: attempt.source,
    lane: attempt.lane,
    role_family: attempt.role_family,
    status: attempt.status,
    found: 0,
    unique: 0,
    evaluated: 0,
    judged: 0,
    eligible: 0,
    reviewable: 0,
    needs_review: 0,
    priority: 0,
    duplicates: 0,
    hard_blocked: 0,
    expired: 0,
    inaccessible: 0,
    shallow_rejected: 0,
    error: attempt.error,
  };
}

function classifyScanOutcome(metric, event) {
  const outcome = normalizeText(event.outcome).toLowerCase();
  if (outcome.includes("duplicate")) metric.duplicates += 1;
  const expired = outcome.includes("expired");
  const inaccessible = outcome.includes("inaccessible");
  if (expired) metric.expired += 1;
  if (inaccessible) metric.inaccessible += 1;
  if (outcome.includes("shallow") || outcome.includes("rejected")) metric.shallow_rejected += 1;
  if (outcome.includes("block") || (event.eligibility === "Ineligible" && !expired && !inaccessible)) metric.hard_blocked += 1;
}

function finalizeMetric(metric) {
  return {
    ...metric,
    unique_yield: ratio(metric.unique, metric.found),
    evaluation_rate: ratio(metric.evaluated, metric.unique),
    priority_yield: ratio(metric.priority, metric.unique),
  };
}

function aggregateMetrics(metrics, key) {
  const groups = new Map();
  for (const metric of metrics) {
    const name = metric[key];
    const group = groups.get(name) ?? {
      [key]: name,
      queries: 0,
      completed: 0,
      failed: 0,
      found: 0,
      unique: 0,
      evaluated: 0,
      judged: 0,
      eligible: 0,
      reviewable: 0,
      needs_review: 0,
      priority: 0,
      duplicates: 0,
      hard_blocked: 0,
      expired: 0,
      inaccessible: 0,
      shallow_rejected: 0,
    };
    group.queries += 1;
    group.completed += metric.status === "Completed" ? 1 : 0;
    group.failed += metric.status === "Failed" ? 1 : 0;
    for (const field of [
      "found", "unique", "evaluated", "judged", "eligible", "reviewable", "needs_review", "priority",
      "duplicates", "hard_blocked", "expired", "inaccessible", "shallow_rejected",
    ]) group[field] += metric[field];
    groups.set(name, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    unique_yield: ratio(group.unique, group.found),
    evaluation_rate: ratio(group.evaluated, group.unique),
    priority_yield: ratio(group.priority, group.unique),
  }));
}

export function buildRunDiagnostics(run, {
  maxDeepEvaluations,
  alertThreshold,
  leadThreshold,
  alertCount = 0,
} = {}) {
  const queryAttempts = validateQueryAttempts(run);
  const metricsById = new Map(queryAttempts.attempts.map((attempt) => [attempt.query_id, emptyMetric(attempt)]));
  const seen = new Set();
  const judgedSeen = new Set();
  let eligible = 0;
  let reviewable = 0;
  let needsReview = 0;
  let priority = 0;
  let leads = 0;

  if (queryAttempts.available) {
    for (const candidate of run.candidates) {
      const metric = metricsById.get(candidate.discovery_query_id);
      metric.found += 1;
      const keys = candidateIdentityKeys(candidate);
      const isUnique = !keys.some((key) => seen.has(key));
      if (isUnique) {
        metric.unique += 1;
        metric.evaluated += 1;
      }
      for (const key of keys) seen.add(key);
      const isJudged = candidate.judge_status === "Judged" && !keys.some((key) => judgedSeen.has(key));
      if (isJudged) metric.judged += 1;
      if (candidate.judge_status === "Judged") for (const key of keys) judgedSeen.add(key);
      if (!isUnique) continue;

      if (candidate.eligibility === "Eligible") {
        metric.eligible += 1;
        eligible += 1;
      }
      if (["Eligible", "Unclear"].includes(candidate.eligibility)) {
        metric.reviewable += 1;
        reviewable += 1;
      }
      if (["Needs Human Review", "Needs Judge"].includes(candidate.eligibility)) {
        metric.needs_review += 1;
        needsReview += 1;
      }
      if (Number(candidate.final_score ?? candidate.preliminary_score ?? 0) >= Number(leadThreshold ?? 0)
        && candidate.eligibility !== "Ineligible") leads += 1;
      if (isAlertable(candidate, alertThreshold)) {
        metric.priority += 1;
        priority += 1;
      }
    }

    for (const event of run.scan_events) {
      const metric = metricsById.get(event.discovery_query_id);
      metric.found += 1;
      metric.unique += event.counts_toward_unique ? 1 : 0;
      metric.evaluated += event.deep_evaluated ? 1 : 0;
      classifyScanOutcome(metric, event);
    }
  } else {
    const legacySeen = new Set();
    for (const candidate of run.candidates) {
      const keys = candidateIdentityKeys(candidate);
      if (keys.some((key) => legacySeen.has(key))) continue;
      for (const key of keys) legacySeen.add(key);
      eligible += candidate.eligibility === "Eligible" ? 1 : 0;
      reviewable += ["Eligible", "Unclear"].includes(candidate.eligibility) ? 1 : 0;
      needsReview += ["Needs Human Review", "Needs Judge"].includes(candidate.eligibility) ? 1 : 0;
      priority += isAlertable(candidate, alertThreshold) ? 1 : 0;
      leads += Number(candidate.final_score ?? candidate.preliminary_score ?? 0) >= Number(leadThreshold ?? 0)
        && candidate.eligibility !== "Ineligible" ? 1 : 0;
    }
  }

  const queryMetrics = [...metricsById.values()].map(finalizeMetric);
  const evaluationRate = ratio(run.evaluated, run.unique);
  const requiredMinimumEvaluations = Math.min(
    Number.isInteger(maxDeepEvaluations) ? maxDeepEvaluations : MIN_DEEP_EVALUATIONS,
    run.unique,
    MIN_DEEP_EVALUATIONS,
  );
  const thinReasons = [];
  if (run.unique >= MIN_UNIQUE_FOR_DEPTH_CHECK && requiredMinimumEvaluations > 0) {
    if (run.evaluated < requiredMinimumEvaluations) {
      thinReasons.push(`Only ${run.evaluated} of ${run.unique} unique vacancies were deeply evaluated; the minimum diagnostic target is ${requiredMinimumEvaluations}.`);
    }
    if (evaluationRate < MIN_EVALUATION_RATE) {
      thinReasons.push(`The deep-evaluation rate was ${(evaluationRate * 100).toFixed(1)}%, below the ${(MIN_EVALUATION_RATE * 100).toFixed(0)}% diagnostic floor.`);
    }
  }

  const failedAttempts = queryAttempts.attempts.filter((attempt) => attempt.status === "Failed").length;
  let coverageStatus = "Adequate";
  if (run.found === 0) coverageStatus = "No discoveries";
  else if (thinReasons.length) coverageStatus = "Thin";
  else if (failedAttempts) coverageStatus = "Partial query coverage";
  else if (!queryAttempts.available && run.queries > 0) coverageStatus = "Aggregate only";

  const warnings = [];
  if (!queryAttempts.available && run.queries > 0) warnings.push("Per-query metrics are unavailable because query_attempts was not supplied.");
  if (failedAttempts) warnings.push(`${failedAttempts} of ${run.queries} query attempts failed.`);
  if (run.found === 0 && run.queries > 0) warnings.push("No vacancies were surfaced; this does not establish that no suitable jobs exist.");
  warnings.push(...thinReasons);

  const summary = run.found === 0
    ? `No discoveries from ${run.queries} attempted queries.`
    : `${coverageStatus} coverage: ${run.found} found, ${run.unique} unique, ${run.evaluated} deeply evaluated, ${run.judged} judged, and ${alertCount} alerted.`;

  return {
    funnel: {
      queries: run.queries,
      attempts_recorded: queryAttempts.attempts.length,
      attempts_completed: queryAttempts.attempts.filter((attempt) => attempt.status === "Completed").length,
      attempts_failed: failedAttempts,
      found: run.found,
      unique: run.unique,
      evaluated: run.evaluated,
      judged: run.judged,
      leads,
      eligible,
      reviewable,
      needs_review: needsReview,
      priority,
      alerted: alertCount,
    },
    rates: {
      findings_per_query: ratio(run.found, run.queries),
      unique_rate: ratio(run.unique, run.found),
      evaluation_rate: evaluationRate,
      judging_rate: ratio(run.judged, run.evaluated),
      priority_rate: ratio(priority, run.unique),
      alert_rate: ratio(alertCount, run.unique),
    },
    coverage: {
      status: coverageStatus,
      is_thin: thinReasons.length > 0,
      no_discoveries: run.found === 0,
      required_minimum_evaluations: requiredMinimumEvaluations,
      reasons: thinReasons,
    },
    query_metrics_available: queryAttempts.available,
    query_metrics: queryMetrics,
    source_metrics: aggregateMetrics(queryMetrics, "source"),
    finder_metrics: aggregateMetrics(queryMetrics, "finder"),
    role_metrics: aggregateMetrics(queryMetrics.filter((metric) => metric.role_family), "role_family"),
    warnings,
    summary,
  };
}
