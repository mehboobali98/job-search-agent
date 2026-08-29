import crypto from "node:crypto";
import { ROLE_FAMILIES } from "./search_query_lib.mjs";

function rounded(value) {
  return Number(value.toFixed(4));
}

function normalizedBudget(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return Object.fromEntries(ROLE_FAMILIES.map((role) => {
    const count = Number(value[role] ?? 0);
    if (!Number.isInteger(count) || count < 0) throw new Error(label + " has an invalid count for " + role);
    return [role, count];
  }));
}

export function queryMetricRecordsFromArchive(input, result) {
  const plan = input?.replay_context?.query_plan ?? [];
  const rolesByQuery = new Map(plan.map((query) => [query.query_id, query.role_family]));
  const records = [];
  let unattributed = 0;
  for (const metric of result?.diagnostics?.query_metrics ?? []) {
    const roleFamily = metric.role_family ?? rolesByQuery.get(metric.query_id) ?? null;
    if (!ROLE_FAMILIES.includes(roleFamily)) {
      unattributed += 1;
      continue;
    }
    records.push({
      run_id: result.run_id ?? input?.run_id ?? null,
      query_id: metric.query_id,
      role_family: roleFamily,
      status: metric.status,
      found: Number(metric.found ?? 0),
      unique: Number(metric.unique ?? 0),
      evaluated: Number(metric.evaluated ?? 0),
      reviewable: Number(metric.reviewable ?? 0),
      priority: Number(metric.priority ?? 0),
    });
  }
  return { records, unattributed };
}

export function recommendationId(packet) {
  const material = {
    schema_version: packet.schema_version,
    total_queries: packet.total_queries,
    current_budget: packet.current_budget,
    proposed_budget: packet.proposed_budget,
    evidence: packet.evidence,
    minimum_attempts: packet.minimum_attempts,
    utility_difference_threshold: packet.utility_difference_threshold,
  };
  return "QBUD-" + crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16).toUpperCase();
}

export function recommendQueryBudget({ records, currentBudget, minimumAttempts = 5, utilityDifferenceThreshold = 0.75 } = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (!Number.isInteger(minimumAttempts) || minimumAttempts < 1) throw new Error("minimumAttempts must be a positive integer");
  if (!Number.isFinite(utilityDifferenceThreshold) || utilityDifferenceThreshold < 0) throw new Error("utilityDifferenceThreshold must be non-negative");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || !ROLE_FAMILIES.includes(record.role_family)) throw new Error(`records[${index}] has an invalid role_family`);
    if (!["Completed", "Failed"].includes(record.status)) throw new Error(`records[${index}] has an invalid status`);
    for (const field of ["found", "unique", "evaluated", "reviewable", "priority"]) {
      const value = Number(record[field] ?? 0);
      if (!Number.isInteger(value) || value < 0) throw new Error(`records[${index}].${field} must be a non-negative integer`);
    }
  }
  const current = normalizedBudget(currentBudget, "currentBudget");
  const totalQueries = Object.values(current).reduce((sum, value) => sum + value, 0);
  const evidence = ROLE_FAMILIES.map((roleFamily) => {
    const roleRecords = records.filter((record) => record.role_family === roleFamily);
    const totals = { attempts: roleRecords.length, completed: 0, failed: 0, found: 0, unique: 0, evaluated: 0, reviewable: 0, priority: 0 };
    for (const record of roleRecords) {
      totals.completed += record.status === "Completed" ? 1 : 0;
      totals.failed += record.status === "Failed" ? 1 : 0;
      for (const field of ["found", "unique", "evaluated", "reviewable", "priority"]) totals[field] += Number(record[field] ?? 0);
    }
    const utility = totals.attempts > 0
      ? (totals.priority * 5 + totals.reviewable * 1.5 + totals.evaluated * 0.5 + totals.unique * 0.25 - totals.failed * 2) / totals.attempts
      : 0;
    return {
      role_family: roleFamily,
      ...totals,
      utility_per_attempt: rounded(utility),
      sufficiently_sampled: totals.attempts >= minimumAttempts,
    };
  });
  const sampled = evidence.filter((item) => item.sufficiently_sampled);
  let status = "Insufficient evidence";
  let rationale = `At least two role families need ${minimumAttempts} attributed query attempts.`;
  let proposed = { ...current };
  if (sampled.length >= 2) {
    const recipient = [...sampled].sort((a, b) => b.utility_per_attempt - a.utility_per_attempt || a.role_family.localeCompare(b.role_family))[0];
    const donors = sampled.filter((item) => item.role_family !== recipient.role_family && current[item.role_family] > 1)
      .sort((a, b) => a.utility_per_attempt - b.utility_per_attempt || a.role_family.localeCompare(b.role_family));
    const donor = donors[0] ?? null;
    const difference = donor ? rounded(recipient.utility_per_attempt - donor.utility_per_attempt) : 0;
    if (donor && difference >= utilityDifferenceThreshold) {
      proposed[donor.role_family] -= 1;
      proposed[recipient.role_family] += 1;
      status = "Recommendation";
      rationale = `Move one of ${totalQueries} queries from ${donor.role_family} to ${recipient.role_family}; observed utility differs by ${difference} per attempt.`;
    } else {
      status = "No change recommended";
      rationale = donor
        ? `Observed utility difference is ${difference}, below the ${utilityDifferenceThreshold} change threshold.`
        : "No sufficiently sampled role family has more than one query to donate.";
    }
  }
  const packet = {
    schema_version: 1,
    status,
    rationale,
    total_queries: totalQueries,
    current_budget: current,
    proposed_budget: proposed,
    proposed_weights: Object.fromEntries(ROLE_FAMILIES.map((role) => [role, totalQueries > 0 ? proposed[role] / totalQueries : 0])),
    evidence,
    minimum_attempts: minimumAttempts,
    utility_difference_threshold: utilityDifferenceThreshold,
    requires_explicit_approval: true,
    applied: false,
    policy_changed: false,
  };
  packet.recommendation_id = recommendationId(packet);
  return packet;
}

export function validateApplicableRecommendation(packet, approvalId, currentBudget) {
  if (!packet || packet.schema_version !== 1 || packet.status !== "Recommendation") throw new Error("Only a schema-version-1 Recommendation can be applied");
  if (packet.requires_explicit_approval !== true || packet.applied !== false) throw new Error("Recommendation is not awaiting explicit approval");
  if (!approvalId || approvalId !== packet.recommendation_id) throw new Error("--approve must exactly match recommendation_id");
  if (recommendationId(packet) !== packet.recommendation_id) throw new Error("Recommendation content does not match recommendation_id");
  const current = normalizedBudget(currentBudget, "currentBudget");
  const expectedCurrent = normalizedBudget(packet.current_budget, "recommendation.current_budget");
  if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) throw new Error("Workbook query budget changed after the recommendation was created");
  const proposed = normalizedBudget(packet.proposed_budget, "recommendation.proposed_budget");
  const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
  if (packet.total_queries !== currentTotal) throw new Error("Recommendation total_queries does not match the workbook budget");
  if (currentTotal !== Object.values(proposed).reduce((sum, value) => sum + value, 0)) {
    throw new Error("Recommendation must preserve the total query budget");
  }
  return proposed;
}
