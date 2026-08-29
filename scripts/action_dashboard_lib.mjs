import { normalizeText } from "./job_tracker_lib.mjs";

const TERMINAL_STAGES = new Set(["Offer", "Rejected", "Withdrawn", "Ghosted", "Accepted", "Not applying"]);
const TERMINAL_STATUSES = new Set(["Offer", "Rejected", "Withdrawn", "Skipped"]);
const CLOSED_LEAD_STATUSES = new Set(["Dismissed", "Expired", "Moved to Applications"]);

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(Math.round((value - 25569) * 86400000));
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

function action({ priority, category, leadId, company, role, dueDate = null, text, sourceSheet, sourceId, url, updatedAt }) {
  return {
    action_id: `ACT-${category.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${leadId}`,
    priority,
    category,
    lead_id: leadId,
    company: normalizeText(company),
    role: normalizeText(role),
    due_date: dueDate,
    status: "Open",
    action: text,
    source_sheet: sourceSheet,
    source_id: sourceId,
    canonical_url: normalizeText(url),
    updated_at: updatedAt,
  };
}

export function deriveActionDashboard({ leads = [], applications = [], eligibilityReviews = [], asOf = new Date() } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(now.getTime())) throw new Error("Action dashboard asOf must be a valid date");
  const actions = [];

  for (const row of eligibilityReviews) {
    if (!row[0] || normalizeText(row[12]) !== "Open") continue;
    actions.push(action({
      priority: Number(row[7]) >= 80 ? "High" : "Medium",
      category: "Eligibility Review",
      leadId: row[1], company: row[5], role: row[6],
      text: normalizeText(row[10]) || "Resolve the eligibility question before proceeding.",
      sourceSheet: "Eligibility Review", sourceId: row[0], url: row[14], updatedAt: now,
    }));
  }

  for (const row of applications) {
    if (!row[0]) continue;
    const stage = normalizeText(row[20]);
    const status = normalizeText(row[11]);
    if (stage === "Preparing") {
      actions.push(action({
        priority: "High", category: "Manual Submission", leadId: row[0], company: row[2], role: row[3],
        text: normalizeText(row[21]) || `Review the ${normalizeText(row[6]) || "selected"} resume and submit manually when ready.`,
        sourceSheet: "Applications", sourceId: row[0], url: row[8], updatedAt: now,
      }));
    }
    const due = asDate(row[12]);
    if (due && !TERMINAL_STAGES.has(stage) && !TERMINAL_STATUSES.has(status) && status !== "Draft") {
      const overdueDays = daysBetween(due, now);
      if (overdueDays >= 0) {
        actions.push(action({
          priority: overdueDays >= 7 ? "High" : "Medium", category: "Follow-up", leadId: row[0], company: row[2], role: row[3],
          dueDate: due,
          text: normalizeText(row[21]) || "Consider a manual follow-up; do not send outreach automatically.",
          sourceSheet: "Applications", sourceId: row[0], url: row[8], updatedAt: now,
        }));
      }
    }
  }

  for (const row of leads) {
    if (!row[0] || CLOSED_LEAD_STATUSES.has(normalizeText(row[26])) || normalizeText(row[11]) === "Ineligible") continue;
    const lastSeen = asDate(row[2]);
    if (!lastSeen || daysBetween(lastSeen, now) < 14) continue;
    actions.push(action({
      priority: "Medium", category: "Stale Lead", leadId: row[0], company: row[3], role: row[4],
      text: `Recheck the canonical listing; it has not been observed for ${daysBetween(lastSeen, now)} days.`,
      sourceSheet: "Leads", sourceId: row[0], url: row[8], updatedAt: now,
    }));
  }

  const priority = { High: 0, Medium: 1, Low: 2 };
  return actions.sort((left, right) => priority[left.priority] - priority[right.priority]
    || Number(left.due_date ?? Infinity) - Number(right.due_date ?? Infinity)
    || left.action_id.localeCompare(right.action_id));
}
