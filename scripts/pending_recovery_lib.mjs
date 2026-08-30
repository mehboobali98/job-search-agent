import crypto from "node:crypto";
import path from "node:path";

export function pendingChecksum(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function errorSummary(value) {
  const firstLine = String(value ?? "Unknown write failure").split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  return firstLine.slice(0, 240);
}

export function classifyPendingMarker(fileName, raw) {
  const name = path.basename(fileName);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { workflow: "Unknown", extract_key: null, command: null };
  }
  if (/^pending-monitor-/i.test(name) && raw.payload) {
    return { workflow: "Lead monitor", extract_key: "payload", command: "node scripts/monitor_leads.mjs" };
  }
  if (/^pending-form-/i.test(name)) {
    return { workflow: "Application form packet", extract_key: null, command: "node scripts/record_form_packet.mjs" };
  }
  if (/^pending-outcome-/i.test(name) && raw.event) {
    return { workflow: "Application outcome", extract_key: "event", command: "node scripts/record_application_outcome.mjs" };
  }
  if (/^pending-action-dashboard\.json$/i.test(name)) {
    return { workflow: "Action dashboard refresh", extract_key: null, command: "node scripts/refresh_actions.mjs" };
  }
  if (/^pending-dashboard-refresh\.json$/i.test(name)) {
    return { workflow: "Dashboard refresh", extract_key: null, command: "node scripts/refresh_dashboard.mjs" };
  }
  if (/^pending-tracker-migration\.json$/i.test(name)) {
    return { workflow: "Tracker migration", extract_key: null, command: "node scripts/migrate_tracker.mjs" };
  }
  if (/^pending-query-budget-/i.test(name)) {
    return { workflow: "Query-budget approval", extract_key: null, command: "node scripts/apply_query_budget.mjs" };
  }
  if (/^pending-job-alert-/i.test(name) && raw.proposal) {
    return { workflow: "Job-alert ingestion", extract_key: null, command: "node scripts/ingest_job_alerts.mjs" };
  }
  if (/^pending-history-import-/i.test(name) && raw.workflow === "historical_tracker_import") {
    return { workflow: "Historical tracker import", extract_key: null, command: "node scripts/import_tracker_history.mjs" };
  }
  if (/^pending-notification-/i.test(name) && raw.workflow === "notification_delivery") {
    return { workflow: "Notification delivery", extract_key: null, command: "node scripts/deliver_notifications.mjs" };
  }
  if (/^pending-action-/i.test(name) && raw.lead_id && raw.action) {
    return { workflow: "Lead action", extract_key: null, command: "node scripts/manage_lead.mjs" };
  }
  if (raw.payload?.checks && Array.isArray(raw.payload.checks)) {
    return { workflow: "Expiry recheck", extract_key: "payload", command: "node scripts/recheck_expiry.mjs" };
  }
  if (raw.payload?.run_id && (Array.isArray(raw.payload.candidates) || Array.isArray(raw.payload.scan_events))) {
    return { workflow: "Discovery tracker update", extract_key: "payload", command: "node scripts/update_tracker.mjs" };
  }
  return { workflow: "Unknown", extract_key: null, command: null };
}

function extractedPath(stateDirectory, fileName, key) {
  const base = path.basename(fileName, ".json");
  return path.join(stateDirectory, "recovery", `${base}.${key}.json`);
}

export function recoveryGuidance({ filePath, stateDirectory, raw, workbookPath = null, eligibilityRegistryPath = null, packagesDirectory = null }) {
  const classification = classifyPendingMarker(filePath, raw);
  const common = workbookPath ? ` --workbook ${shellQuote(workbookPath)}` : "";
  const state = ` --state-dir ${shellQuote(stateDirectory)}`;
  const registry = eligibilityRegistryPath ? ` --eligibility-registry ${shellQuote(eligibilityRegistryPath)}` : "";
  const steps = [];
  let inputPath = null;
  if (classification.extract_key) {
    inputPath = extractedPath(stateDirectory, filePath, classification.extract_key);
    steps.push(`node scripts/inspect_pending.mjs --state-dir ${shellQuote(stateDirectory)} --marker ${shellQuote(path.basename(filePath))} --extract ${shellQuote(inputPath)}`);
  }
  switch (classification.workflow) {
    case "Discovery tracker update":
      steps.push(`${classification.command}${common} --input ${shellQuote(inputPath)}${registry}${state}`);
      break;
    case "Lead monitor":
      steps.push(`${classification.command}${common} --input ${shellQuote(inputPath)}${registry}${state}`);
      break;
    case "Expiry recheck":
      steps.push(`${classification.command}${common} --input ${shellQuote(inputPath)}${state}`);
      break;
    case "Application outcome":
      steps.push(`${classification.command}${common} --input ${shellQuote(inputPath)}${state}`);
      break;
    case "Application form packet":
      if (raw.lead_id && raw.input) {
        const packages = packagesDirectory ? ` --packages-dir ${shellQuote(packagesDirectory)}` : "";
        steps.push(`${classification.command}${common} --lead-id ${shellQuote(raw.lead_id)} --input ${shellQuote(raw.input)}${packages}${state}`);
      }
      break;
    case "Lead action": {
      let command = `${classification.command}${common} --lead-id ${shellQuote(raw.lead_id)} --action ${shellQuote(raw.action)}${state}`;
      for (const [field, flag] of [["applied_at", "--applied-at"], ["follow_up_at", "--follow-up-at"], ["salary", "--salary"], ["cover_letter", "--cover-letter"]]) {
        if (raw[field]) command += ` ${flag} ${shellQuote(raw[field])}`;
      }
      steps.push(command);
      break;
    }
    case "Action dashboard refresh":
      steps.push(`${classification.command}${common}${state}`);
      break;
    case "Dashboard refresh":
      if (workbookPath) steps.push(`${classification.command} ${shellQuote(workbookPath)}`);
      break;
    case "Tracker migration":
      steps.push(`${classification.command}${common}${state}`);
      break;
    case "Query-budget approval":
      if (raw.recommendation_path && raw.approval_id) {
        steps.push(`${classification.command}${common} --recommendation ${shellQuote(raw.recommendation_path)} --approve ${shellQuote(raw.approval_id)}${state}`);
      }
      break;
    case "Job-alert ingestion":
      steps.push(`${classification.command} --recover ${shellQuote(filePath)} --apply`);
      break;
    case "Historical tracker import":
      steps.push(`${classification.command} --recover ${shellQuote(filePath)} --apply`);
      break;
    case "Notification delivery":
      if (raw.approval_id) {
        steps.push(`${classification.command} --recover ${shellQuote(filePath)} --apply --approve ${shellQuote(raw.approval_id)}`);
      }
      break;
    default:
      break;
  }
  return {
    workflow: classification.workflow,
    recoverable: steps.length > 0,
    extraction_required: Boolean(classification.extract_key),
    extraction_key: classification.extract_key,
    steps,
    note: steps.length
      ? "Review the marker and underlying cause before running these commands. Successful replay removes its own marker."
      : "No automatic replay path is known. Preserve the marker and inspect it manually.",
  };
}

export function pendingMarkerSummary({ filePath, text, raw, stat, stateDirectory, workbookPath = null, eligibilityRegistryPath = null, packagesDirectory = null, retentionDays = 30, now = new Date() }) {
  const createdAt = raw.created_at ?? raw.payload?.completed_at ?? raw.event?.recorded_at ?? stat.mtime.toISOString();
  const ageDays = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86_400_000));
  return {
    marker: path.basename(filePath),
    checksum_sha256: pendingChecksum(text),
    created_at: createdAt,
    age_days: Number.isFinite(ageDays) ? ageDays : null,
    stale: Number.isFinite(ageDays) ? ageDays >= retentionDays : false,
    error_summary: errorSummary(raw.error),
    recovery: recoveryGuidance({ filePath, stateDirectory, raw, workbookPath, eligibilityRegistryPath, packagesDirectory }),
  };
}
