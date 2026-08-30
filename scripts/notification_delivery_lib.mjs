import crypto from "node:crypto";
import { normalizeText, normalizeUrl, RESUMES } from "./job_tracker_lib.mjs";
import { validateNotificationsConfig } from "./project_config.mjs";

export const JOB_DIGEST_SCHEMA_VERSION = 1;
export const NOTIFICATION_DELIVERY_SCHEMA_VERSION = 1;
export const MAX_NOTIFICATION_RESULT_BYTES = 2 * 1024 * 1024;
export const NOTIFICATION_CLASSIFICATIONS = Object.freeze({
  NOTIFICATIONS_DISABLED: "notifications_disabled",
  DESTINATION_DISABLED: "destination_disabled",
  NO_ALERTS: "no_alerts",
  BELOW_MINIMUM_SCORE: "below_minimum_score",
  DIGEST_LIMIT_EXCEEDED: "digest_limit_exceeded",
  DESTINATION_LIMIT_EXCEEDED: "destination_limit_exceeded",
  QUIET_HOURS_DEFERRED: "quiet_hours_deferred",
  CONNECTOR_REQUIRED: "connector_required",
});

const ELIGIBILITY = new Set(["Eligible", "Unclear"]);
const PRIVATE_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PRIVATE_HOME_PATTERN = /\/(?:Users|home)\/[^/\s]+\//g;
const FORBIDDEN_KEYS = new Set([
  "candidate_name", "candidate_profile", "credentials", "credential", "secret", "token", "password", "api_key",
  "webhook_url", "email_address", "recipient_address", "resume_path", "raw_run_payload",
]);
const DIGEST_FIELDS = new Set(["schema_version", "digest_id", "run_id", "generated_at", "timezone", "source", "items", "privacy"]);
const REQUEST_FIELDS = new Set([
  "schema_version", "request_id", "approval_id", "digest_id", "run_id", "created_at", "not_before", "destination", "items", "policy", "safety",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableId(prefix, value) {
  return `${prefix}-${sha256(canonical(value)).slice(0, 24).toUpperCase()}`;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function privacyText(value, maximum, { required = false, label = "text" } = {}) {
  const text = normalizeText(value)
    .replace(PRIVATE_EMAIL_PATTERN, "[redacted-email]")
    .replace(PRIVATE_HOME_PATTERN, "/[redacted-home]/")
    .slice(0, maximum);
  PRIVATE_EMAIL_PATTERN.lastIndex = 0;
  PRIVATE_HOME_PATTERN.lastIndex = 0;
  if (required && !text) throw new Error(`${label} is required`);
  return text || null;
}

function privacySafeUrl(value) {
  const normalized = normalizeUrl(value);
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error("Digest items require a valid canonical_url"); }
  if (parsed.protocol !== "https:") throw new Error("Digest canonical_url must use HTTPS");
  for (const key of [...parsed.searchParams.keys()]) {
    const parameter = parsed.searchParams.get(key) ?? "";
    if (/(?:email|user|account|token|signature|auth|recipient|subscriber|secret|password|api[_-]?key)/i.test(key)
      || PRIVATE_EMAIL_PATTERN.test(parameter)) parsed.searchParams.delete(key);
    PRIVATE_EMAIL_PATTERN.lastIndex = 0;
  }
  const safe = normalizeUrl(parsed.toString());
  if (PRIVATE_EMAIL_PATTERN.test(safe) || PRIVATE_HOME_PATTERN.test(safe)) throw new Error("Digest canonical_url contains private data");
  PRIVATE_EMAIL_PATTERN.lastIndex = 0;
  PRIVATE_HOME_PATTERN.lastIndex = 0;
  return safe;
}

function firstText(value, maximum) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of values) {
    const text = privacyText(item, maximum);
    if (text) return text;
  }
  return null;
}

function normalizePostedDate(value) {
  if (!value) return null;
  if (!validDate(String(value))) throw new Error("Digest posted_date must be a date");
  return new Date(value).toISOString().slice(0, 10);
}

function digestItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each updater alert must be an object");
  const leadId = privacyText(raw.lead_id, 64, { required: true, label: "lead_id" });
  const company = privacyText(raw.company, 160, { required: true, label: "company" });
  const role = privacyText(raw.title ?? raw.role, 240, { required: true, label: "role" });
  const score = Number(raw.final_score ?? raw.score);
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("Digest score must be an integer from 0 to 100");
  if (!ELIGIBILITY.has(raw.eligibility)) throw new Error("Digest alerts must be Eligible or Unclear");
  const bestResume = raw.best_resume == null ? null : privacyText(raw.best_resume, 80);
  if (bestResume && !RESUMES.has(bestResume)) throw new Error("Digest best_resume is unsupported");
  return {
    lead_id: leadId,
    company,
    role,
    score,
    canonical_url: privacySafeUrl(raw.canonical_url),
    location: privacyText(raw.location, 160),
    eligibility: raw.eligibility,
    primary_strength: firstText(raw.strengths, 240),
    primary_risk: firstText(raw.gaps, 240),
    posted_date: normalizePostedDate(raw.posted_date),
    best_resume: bestResume,
  };
}

export function validateUpdaterNotificationSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Updater result must be an object");
  const runId = String(value.run_id ?? "").trim();
  if (!runId || runId.length > 128 || /[\r\n]/.test(runId)) throw new Error("Updater result requires a bounded run_id");
  if (!Array.isArray(value.alerts) || value.alerts.length > 20) throw new Error("Updater result alerts must be an array with at most 20 items");
  const replayHash = value.replay?.replay_hash ?? null;
  if (replayHash !== null && !/^[a-f0-9]{64}$/.test(String(replayHash))) throw new Error("Updater result replay hash is invalid");
  if (value.completed_at !== undefined && !validDate(value.completed_at)) throw new Error("Updater result completed_at is invalid");
  return value;
}

export function validateJobDigest(digest) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) throw new Error("Job digest must be an object");
  for (const field of Object.keys(digest)) if (!DIGEST_FIELDS.has(field)) throw new Error("Unsupported job digest field: " + field);
  if (digest.schema_version !== JOB_DIGEST_SCHEMA_VERSION) throw new Error("Unsupported job digest schema_version");
  if (!/^DIGEST-[A-F0-9]{24}$/.test(String(digest.digest_id ?? ""))) throw new Error("Job digest digest_id is invalid");
  if (!String(digest.run_id ?? "").trim() || String(digest.run_id).length > 128) throw new Error("Job digest run_id is invalid");
  if (!validDate(digest.generated_at)) throw new Error("Job digest generated_at is invalid");
  try { new Intl.DateTimeFormat("en", { timeZone: digest.timezone }).format(new Date(digest.generated_at)); }
  catch { throw new Error("Job digest timezone is invalid"); }
  if (digest.source?.kind !== "tracker_update_result") throw new Error("Job digest source is invalid");
  if (digest.source.replay_hash !== null && !/^[a-f0-9]{64}$/.test(String(digest.source.replay_hash))) {
    throw new Error("Job digest replay hash is invalid");
  }
  if (!Array.isArray(digest.items) || digest.items.length > 20) throw new Error("Job digest items are invalid");
  if (digest.items.some((item) => canonical(digestItem({
    ...item, title: item.role, final_score: item.score, strengths: item.primary_strength ? [item.primary_strength] : [],
    gaps: item.primary_risk ? [item.primary_risk] : [],
  })) !== canonical(item))) throw new Error("Job digest contains a malformed item");
  if (digest.privacy?.candidate_identity_included !== false || digest.privacy?.credentials_included !== false
    || digest.privacy?.private_paths_included !== false || digest.privacy?.raw_run_payload_included !== false) {
    throw new Error("Job digest privacy flags are invalid");
  }
  const expectedId = stableId("DIGEST", {
    run_id: digest.run_id,
    generated_at: new Date(digest.generated_at).toISOString(),
    timezone: digest.timezone,
    replay_hash: digest.source.replay_hash,
    items: digest.items,
  });
  if (digest.digest_id !== expectedId) throw new Error("Job digest ID does not match its deterministic content");
  assertNotificationSafe(digest);
  return digest;
}

export function buildJobDigest(source, { generatedAt, timezone, maxItems = 10 } = {}) {
  validateUpdaterNotificationSource(source);
  if (!validDate(generatedAt)) throw new Error("Digest generation requires a stable timestamp");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(generatedAt)); }
  catch { throw new Error("Digest timezone is invalid"); }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) throw new Error("Digest maxItems must be from 1 to 20");
  const normalized = source.alerts.map(digestItem).sort((left, right) => right.score - left.score || left.lead_id.localeCompare(right.lead_id));
  const items = normalized.slice(0, maxItems);
  const seed = {
    run_id: String(source.run_id).trim(),
    generated_at: new Date(generatedAt).toISOString(),
    timezone,
    replay_hash: source.replay?.replay_hash ?? null,
    items,
  };
  const digest = {
    schema_version: JOB_DIGEST_SCHEMA_VERSION,
    digest_id: stableId("DIGEST", seed),
    run_id: seed.run_id,
    generated_at: seed.generated_at,
    timezone,
    source: { kind: "tracker_update_result", replay_hash: seed.replay_hash },
    items,
    privacy: {
      candidate_identity_included: false,
      credentials_included: false,
      private_paths_included: false,
      raw_run_payload_included: false,
    },
  };
  return {
    digest: validateJobDigest(digest),
    omitted_count: normalized.length - items.length,
  };
}

function localMinute(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function minuteOfDay(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isInsideQuietHours(date, timezone, quietHours) {
  if (!quietHours.enabled) return false;
  const local = localMinute(new Date(date), timezone);
  const start = minuteOfDay(quietHours.start);
  const end = minuteOfDay(quietHours.end);
  return start < end ? local >= start && local < end : local >= start || local < end;
}

export function notificationNotBefore(date, timezone, quietHours) {
  const instant = new Date(date);
  if (!isInsideQuietHours(instant, timezone, quietHours)) return instant.toISOString();
  const firstMinute = new Date(instant);
  firstMinute.setUTCSeconds(0, 0);
  if (firstMinute <= instant) firstMinute.setUTCMinutes(firstMinute.getUTCMinutes() + 1);
  for (let offset = 1; offset <= 1_500; offset += 1) {
    const candidate = new Date(firstMinute.getTime() + (offset - 1) * 60_000);
    if (!isInsideQuietHours(candidate, timezone, quietHours)) return candidate.toISOString();
  }
  throw new Error("Quiet hours do not yield a delivery window within 25 hours");
}

function classification(code, extras = {}) {
  return { code, ...extras };
}

function requestSeed(digest, destination, notBefore, items) {
  return {
    digest_id: digest.digest_id,
    destination: {
      id: destination.id, adapter: destination.adapter, channel: destination.channel,
      connection_ref: destination.connection_ref ?? null,
    },
    not_before: notBefore,
    minimum_score: destination.minimum_score,
    max_items: destination.max_items,
    include_resume: destination.include_resume,
    items,
  };
}

export function validateNotificationDeliveryRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Notification request must be an object");
  for (const field of Object.keys(request)) if (!REQUEST_FIELDS.has(field)) throw new Error("Unsupported notification request field: " + field);
  if (request.schema_version !== NOTIFICATION_DELIVERY_SCHEMA_VERSION) throw new Error("Unsupported notification request schema_version");
  if (!/^NREQ-[A-F0-9]{24}$/.test(String(request.request_id ?? ""))) throw new Error("Notification request_id is invalid");
  if (!/^NAPP-[A-F0-9]{24}$/.test(String(request.approval_id ?? ""))) throw new Error("Notification approval_id is invalid");
  if (!validDate(request.created_at) || !validDate(request.not_before)) throw new Error("Notification request timestamps are invalid");
  if (new Date(request.not_before) < new Date(request.created_at)) throw new Error("Notification not_before cannot precede created_at");
  if (!request.destination || !["private_file", "connector"].includes(request.destination.adapter)) throw new Error("Notification destination is invalid");
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 20) throw new Error("Notification request requires 1-20 items");
  if (request.items.some((item) => canonical(digestItem({
    ...item, title: item.role, final_score: item.score, strengths: item.primary_strength ? [item.primary_strength] : [],
    gaps: item.primary_risk ? [item.primary_risk] : [],
  })) !== canonical(item))) throw new Error("Notification request contains a malformed item");
  validateNotificationsConfig({
    enabled: true,
    max_items_per_digest: 20,
    quiet_hours: { enabled: false, start: "22:00", end: "08:00" },
    destinations: [{
      ...request.destination,
      enabled: true,
      minimum_score: request.policy?.minimum_score,
      max_items: request.policy?.max_items,
      include_resume: request.policy?.include_resume,
    }],
  });
  if (typeof request.policy?.quiet_hours_applied !== "boolean" || typeof request.policy?.deferred !== "boolean") {
    throw new Error("Notification request policy flags are invalid");
  }
  if (request.policy.deferred !== (request.not_before !== request.created_at)) {
    throw new Error("Notification request deferred flag does not match not_before");
  }
  if (request.items.some((item) => item.score < request.policy.minimum_score) || request.items.length > request.policy.max_items) {
    throw new Error("Notification request items violate destination policy");
  }
  if (!request.policy.include_resume && request.items.some((item) => item.best_resume !== null)) {
    throw new Error("Notification request includes resume data contrary to destination policy");
  }
  if (request.safety?.requires_explicit_approval !== true || request.safety?.external_delivery_performed !== false
    || request.safety?.application_submission_allowed !== false || request.safety?.recruiter_outreach_allowed !== false
    || request.safety?.credentials_included !== false) throw new Error("Notification request safety flags are invalid");
  const expectedRequestId = stableId("NREQ", requestSeed(
    { digest_id: request.digest_id },
    {
      ...request.destination,
      minimum_score: request.policy.minimum_score,
      max_items: request.policy.max_items,
      include_resume: request.policy.include_resume,
    },
    request.not_before,
    request.items,
  ));
  if (request.request_id !== expectedRequestId) throw new Error("Notification request ID does not match its deterministic content");
  assertNotificationSafe(request);
  return request;
}

export function planNotificationDeliveries(digest, notifications) {
  validateJobDigest(digest);
  const config = validateNotificationsConfig(notifications);
  const classifications = [];
  if (!config.enabled) classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.NOTIFICATIONS_DISABLED));
  if (digest.items.length === 0) classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.NO_ALERTS));
  const pending = [];
  for (const destination of config.destinations) {
    if (!destination.enabled) {
      classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.DESTINATION_DISABLED, { destination_id: destination.id }));
      continue;
    }
    const eligible = digest.items.filter((item) => item.score >= destination.minimum_score);
    if (eligible.length < digest.items.length) {
      classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.BELOW_MINIMUM_SCORE, {
        destination_id: destination.id, count: digest.items.length - eligible.length,
      }));
    }
    const selected = eligible.slice(0, destination.max_items).map((item) => destination.include_resume ? item : { ...item, best_resume: null });
    if (eligible.length > selected.length) classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.DESTINATION_LIMIT_EXCEEDED, {
      destination_id: destination.id, count: eligible.length - selected.length,
    }));
    if (!selected.length) continue;
    const notBefore = notificationNotBefore(digest.generated_at, digest.timezone, config.quiet_hours);
    const deferred = notBefore !== digest.generated_at;
    if (deferred) classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.QUIET_HOURS_DEFERRED, {
      destination_id: destination.id, not_before: notBefore,
    }));
    if (destination.adapter === "connector") classifications.push(classification(NOTIFICATION_CLASSIFICATIONS.CONNECTOR_REQUIRED, {
      destination_id: destination.id,
    }));
    const seed = requestSeed(digest, destination, notBefore, selected);
    pending.push({ seed, request_id: stableId("NREQ", seed) });
  }
  const approvalId = pending.length ? stableId("NAPP", pending.map((item) => item.request_id)) : null;
  const requests = pending.map(({ seed, request_id }) => validateNotificationDeliveryRequest({
    schema_version: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    request_id: request_id,
    approval_id: approvalId,
    digest_id: digest.digest_id,
    run_id: digest.run_id,
    created_at: digest.generated_at,
    not_before: seed.not_before,
    destination: seed.destination,
    items: seed.items,
    policy: {
      minimum_score: seed.minimum_score,
      max_items: seed.max_items,
      include_resume: seed.include_resume,
      quiet_hours_applied: config.quiet_hours.enabled,
      deferred: seed.not_before !== digest.generated_at,
    },
    safety: {
      requires_explicit_approval: true,
      external_delivery_performed: false,
      application_submission_allowed: false,
      recruiter_outreach_allowed: false,
      credentials_included: false,
    },
  }));
  return { enabled: config.enabled, approval_id: approvalId, requests, classifications };
}

export function assertNotificationSafe(value) {
  function inspect(node, location = "notification") {
    if (Array.isArray(node)) return node.forEach((item, index) => inspect(item, `${location}[${index}]`));
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`${location}.${key} is forbidden in notification contracts`);
        inspect(child, `${location}.${key}`);
      }
      return;
    }
    if (typeof node !== "string") return;
    if (PRIVATE_EMAIL_PATTERN.test(node)) throw new Error(`${location} contains an email address`);
    PRIVATE_EMAIL_PATTERN.lastIndex = 0;
    if (PRIVATE_HOME_PATTERN.test(node)) throw new Error(`${location} contains a private home path`);
    PRIVATE_HOME_PATTERN.lastIndex = 0;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(node)) throw new Error(`${location} contains a private key`);
  }
  inspect(value);
  return value;
}

export function notificationPreviewSummary({ digest, plan }) {
  return {
    schema_version: 1,
    digest_id: digest.digest_id,
    run_id: digest.run_id,
    item_count: digest.items.length,
    enabled: plan.enabled,
    approval_id: plan.approval_id,
    destination_count: plan.requests.length,
    destinations: plan.requests.map((request) => ({
      id: request.destination.id,
      adapter: request.destination.adapter,
      channel: request.destination.channel,
      item_count: request.items.length,
      deferred: request.policy.deferred,
      not_before: request.not_before,
    })),
    classifications: plan.classifications,
    external_delivery_performed: false,
  };
}
