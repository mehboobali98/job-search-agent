import crypto from "node:crypto";
import { candidateIdentityKeys, normalizeText, normalizeUrl } from "./job_tracker_lib.mjs";
import { identifyCanonicalSource } from "./canonical_source_adapters.mjs";
import { validateGmailJobAlertsConfig } from "./project_config.mjs";

export const JOB_ALERT_BATCH_SCHEMA_VERSION = 1;
export const JOB_ALERT_PROPOSAL_SCHEMA_VERSION = 1;
export const MAX_JOB_ALERT_BODY_BYTES = 1_000_000;
export const MAX_JOB_ALERT_BATCH_BYTES = 210_000_000;
export const MAX_JOB_ALERT_BATCH_MESSAGES = 1_000;

export const JOB_ALERT_CLASSIFICATIONS = Object.freeze({
  MALFORMED_MESSAGE: "malformed_message",
  SENDER_NOT_ALLOWED: "sender_not_allowed",
  STALE_MESSAGE: "stale_message",
  EXTRACTION_FAILURE: "extraction_failure",
  UNSUPPORTED_LINK: "unsupported_link",
  DUPLICATE_IN_BATCH: "duplicate_in_batch",
  DUPLICATE_IN_TRACKER: "duplicate_in_tracker",
  EXPIRED_LISTING: "expired_listing",
  LIMIT_EXCEEDED: "limit_exceeded",
});

const TRACKING_TARGET_PARAMETERS = [
  "url", "q", "target", "redirect", "redirect_url", "destination", "dest", "continue", "u",
];
const EXPIRED_PATTERN = /\b(?:job|role|position|listing|vacancy)?\s*(?:has been\s+)?(?:expired|closed|filled|removed)|\bno longer accepting applications\b/i;
const PRIVATE_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PRIVATE_HOME_PATTERN = /\/(?:Users|home)\/[^/\s]+\//g;
const PRIVATE_HOME_TEST_PATTERN = /\/(?:Users|home)\/[^/\s]+\//;
const GENERIC_LINK_TEXT = /^(?:apply|apply now|details|learn more|open|view|view job|view role|job details|click here)$/i;
const BATCH_FIELDS = new Set(["schema_version", "batch_id", "transport", "retrieved_at", "messages"]);
const TRANSPORT_FIELDS = new Set(["provider", "access_mode", "query"]);
const MESSAGE_FIELDS = new Set(["message_id", "received_at", "from", "subject", "text_body", "html_body"]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableCanonicalize(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableCanonicalize(value[key])]));
  }
  return value;
}

function validDate(value) {
  return normalizeText(value) && Number.isFinite(new Date(value).getTime());
}

function boundedText(value, maximum = 512) {
  const text = normalizeText(value);
  return text ? text.slice(0, maximum) : null;
}

export function redactPrivateAlertText(value, maximum = 240) {
  const text = normalizeText(value)
    .replace(PRIVATE_EMAIL_PATTERN, "[redacted-email]")
    .replace(PRIVATE_HOME_PATTERN, "/[redacted-home]/");
  return text ? text.slice(0, maximum) : null;
}

function messageReference(batchId, messageId, index) {
  return "msg-" + sha256(`${batchId}\u0000${messageId || `index-${index}`}`).slice(0, 24);
}

function requiredEnvelopeText(value, label, maximum = 512) {
  const text = normalizeText(value);
  if (!text || text.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`);
  return text;
}

export function validateJobAlertBatchEnvelope(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new Error("Job-alert batch must be an object");
  for (const field of Object.keys(batch)) if (!BATCH_FIELDS.has(field)) throw new Error("Unsupported job-alert batch field: " + field);
  if (batch.schema_version !== JOB_ALERT_BATCH_SCHEMA_VERSION) {
    throw new Error(`Unsupported job-alert batch schema_version: ${batch.schema_version}`);
  }
  const batchId = requiredEnvelopeText(batch.batch_id, "batch_id", 128);
  if (batchId !== batch.batch_id) throw new Error("batch_id must not contain surrounding or repeated whitespace");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(batchId)) throw new Error("batch_id must be an opaque alphanumeric slug");
  if (!batch.transport || typeof batch.transport !== "object" || Array.isArray(batch.transport)) {
    throw new Error("Job-alert batch requires transport");
  }
  for (const field of Object.keys(batch.transport)) if (!TRANSPORT_FIELDS.has(field)) throw new Error("Unsupported transport field: " + field);
  const providerValue = requiredEnvelopeText(batch.transport.provider, "transport.provider", 64);
  const provider = providerValue.toLowerCase();
  if (provider !== providerValue) throw new Error("transport.provider must be lowercase");
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(provider)) throw new Error("transport.provider must be a lowercase slug");
  if (batch.transport.access_mode !== "read_only") throw new Error("transport.access_mode must be read_only");
  if (batch.transport.query !== undefined && String(batch.transport.query).length > 512) {
    throw new Error("transport.query must not exceed 512 characters");
  }
  if (typeof batch.retrieved_at !== "string" || !validDate(batch.retrieved_at)) throw new Error("retrieved_at must be an ISO-compatible timestamp");
  if (!Array.isArray(batch.messages)) throw new Error("Job-alert batch requires messages[]");
  if (batch.messages.length > MAX_JOB_ALERT_BATCH_MESSAGES) {
    throw new Error(`Job-alert batch must not exceed ${MAX_JOB_ALERT_BATCH_MESSAGES} messages`);
  }
  return batch;
}

function validateMessage(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`messages[${index}] must be an object`);
  for (const field of Object.keys(raw)) if (!MESSAGE_FIELDS.has(field)) throw new Error(`messages[${index}] has unsupported field: ${field}`);
  const messageId = requiredEnvelopeText(raw.message_id, `messages[${index}].message_id`, 512);
  if (typeof raw.received_at !== "string" || !validDate(raw.received_at)) throw new Error(`messages[${index}].received_at must be a timestamp`);
  const from = requiredEnvelopeText(raw.from, `messages[${index}].from`, 998);
  if (raw.subject !== undefined && typeof raw.subject !== "string") throw new Error(`messages[${index}].subject must be a string`);
  if (String(raw.subject ?? "").length > 998) throw new Error(`messages[${index}].subject exceeds 998 characters`);
  for (const field of ["text_body", "html_body"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`messages[${index}].${field} must be a string`);
    if (Buffer.byteLength(raw[field] ?? "", "utf8") > MAX_JOB_ALERT_BODY_BYTES) {
      throw new Error(`messages[${index}].${field} exceeds the private import limit`);
    }
  }
  if (!String(raw.text_body ?? "").trim() && !String(raw.html_body ?? "").trim()) {
    throw new Error(`messages[${index}] requires text_body or html_body`);
  }
  return { ...raw, message_id: messageId, from };
}

function senderAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const angled = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const plain = text.match(/(?:^|\s)([^<>\s]+@[^<>\s]+)(?:$|\s)/);
  return (angled?.[1] ?? plain?.[1] ?? (/^[^@\s]+@[^@\s]+$/.test(text) ? text : "")).replace(/[>,;]+$/, "");
}

export function isAllowlistedSender(value, allowlist) {
  const address = senderAddress(value);
  if (!address) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return allowlist.some((entry) => entry.includes("@") ? address === entry : domain === entry);
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([a-f0-9]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value ?? "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/article|\/section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

function trimUrlPunctuation(value) {
  let text = decodeHtmlEntities(value).trim().replace(/^[<(\[]+/, "");
  while (/[.,;:!?\])>]$/.test(text)) text = text.slice(0, -1);
  return text;
}

function decodeTrackingTarget(value) {
  let text = decodeHtmlEntities(value).trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (/^https?:\/\//i.test(text)) return text;
    try { text = decodeURIComponent(text); } catch { break; }
  }
  return /^https?:\/\//i.test(text) ? text : null;
}

export function unwrapTrackedJobUrl(value) {
  let current = trimUrlPunctuation(value);
  for (let depth = 0; depth < 4; depth += 1) {
    let parsed;
    try { parsed = new URL(current); } catch { return current; }
    if (identifyCanonicalSource(current).recognized) break;
    let target = null;
    for (const parameter of TRACKING_TARGET_PARAMETERS) {
      const candidate = parsed.searchParams.get(parameter);
      const decoded = candidate ? decodeTrackingTarget(candidate) : null;
      if (decoded) { target = decoded; break; }
    }
    if (!target || target === current) break;
    current = target;
  }
  return current;
}

function privacySafeUrl(value) {
  let parsed;
  try { parsed = new URL(unwrapTrackedJobUrl(value)); } catch { return null; }
  if (parsed.protocol !== "https:" || PRIVATE_EMAIL_PATTERN.test(parsed.toString())) {
    PRIVATE_EMAIL_PATTERN.lastIndex = 0;
    return null;
  }
  PRIVATE_EMAIL_PATTERN.lastIndex = 0;
  for (const key of [...parsed.searchParams.keys()]) {
    const paramValue = parsed.searchParams.get(key) ?? "";
    if (/email|e-mail|user|account|token|signature|auth|recipient|subscriber/i.test(key) || PRIVATE_EMAIL_PATTERN.test(paramValue)) {
      parsed.searchParams.delete(key);
    }
    PRIVATE_EMAIL_PATTERN.lastIndex = 0;
  }
  return normalizeUrl(parsed.toString());
}

function labeledMetadata(context) {
  const metadata = {};
  const labels = {
    company: /^(?:company|employer|organization)\s*[:\-]\s*(.+)$/i,
    title: /^(?:role|title|position|job)\s*[:\-]\s*(.+)$/i,
    location: /^location\s*[:\-]\s*(.+)$/i,
    work_type: /^(?:work\s*type|workplace|arrangement)\s*[:\-]\s*(.+)$/i,
    posted_date: /^(?:posted|posted\s*date|date)\s*[:\-]\s*(.+)$/i,
  };
  for (const line of htmlToText(context).split(/\r?\n/).map((item) => normalizeText(item)).filter(Boolean)) {
    for (const [field, pattern] of Object.entries(labels)) {
      const match = line.match(pattern);
      if (match && !metadata[field]) metadata[field] = redactPrivateAlertText(match[1], field === "title" ? 240 : 160);
    }
  }
  if (metadata.posted_date && !validDate(metadata.posted_date)) delete metadata.posted_date;
  else if (metadata.posted_date) metadata.posted_date = new Date(metadata.posted_date).toISOString().slice(0, 10);
  return metadata;
}

function blockForOffset(text, offset) {
  const before = text.lastIndexOf("\n\n", offset);
  const after = text.indexOf("\n\n", offset);
  return text.slice(before < 0 ? 0 : before + 2, after < 0 ? text.length : after);
}

function plainLinks(text, sourceFormat) {
  const results = [];
  for (const match of String(text ?? "").matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const context = blockForOffset(String(text), match.index ?? 0);
    results.push({
      raw_url: trimUrlPunctuation(match[0]),
      metadata: labeledMetadata(context),
      expired: EXPIRED_PATTERN.test(context),
      source_format: sourceFormat,
    });
  }
  return results;
}

function enclosingHtmlFragment(html, start, end) {
  const prefix = html.slice(0, start);
  const opening = Math.max(...["<tr", "<li", "<article", "<section", "<div", "<p"].map((tag) => prefix.toLowerCase().lastIndexOf(tag)));
  const closeIndex = html.indexOf(">", end);
  const from = opening >= 0 ? opening : Math.max(0, start - 800);
  const to = closeIndex >= 0 ? Math.min(html.length, closeIndex + 800) : Math.min(html.length, end + 800);
  return html.slice(from, to);
}

function htmlLinks(html) {
  const source = String(html ?? "");
  const results = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const rawUrl = decodeHtmlEntities(match[2] ?? match[3] ?? "");
    const context = enclosingHtmlFragment(source, match.index ?? 0, (match.index ?? 0) + match[0].length);
    const metadata = labeledMetadata(context);
    const linkText = redactPrivateAlertText(htmlToText(match[4]), 240);
    if (!metadata.title && linkText && !GENERIC_LINK_TEXT.test(linkText)) metadata.title = linkText;
    results.push({ raw_url: rawUrl, metadata, expired: EXPIRED_PATTERN.test(htmlToText(context)), source_format: "html" });
  }
  const visibleText = htmlToText(source);
  results.push(...plainLinks(visibleText, "html_text"));
  return results;
}

export function extractJobAlertLinks(message) {
  const extracted = [
    ...plainLinks(message.text_body ?? "", "text"),
    ...htmlLinks(message.html_body ?? ""),
  ];
  const byUrl = new Map();
  for (const item of extracted) {
    const unwrapped = unwrapTrackedJobUrl(item.raw_url);
    if (!unwrapped) continue;
    const key = unwrapped.toLowerCase();
    const previous = byUrl.get(key);
    if (!previous) byUrl.set(key, { ...item, raw_url: unwrapped });
    else byUrl.set(key, {
      ...previous,
      metadata: { ...item.metadata, ...previous.metadata },
      expired: previous.expired || item.expired,
    });
  }
  return [...byUrl.values()];
}

function supportForUrl(value) {
  const safeUrl = privacySafeUrl(value);
  if (!safeUrl) return { supported: false, reason: "Link is not a privacy-safe public HTTPS URL.", canonical_url: null, source: null };
  const canonical = identifyCanonicalSource(safeUrl);
  if (canonical.recognized) return { supported: true, reason: null, canonical_url: canonical.canonical_url, source: canonical };
  const parsed = new URL(safeUrl);
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const linkedinJob = /(^|\.)linkedin\.com$/.test(host) && /\/jobs\/view\//.test(pathname);
  const employerJob = /^(?:jobs|careers)\./.test(host) || /\/(?:jobs?|careers?|positions?|openings?|vacancies?)(?:\/|$)/.test(pathname);
  if (linkedinJob || employerJob) return { supported: true, reason: null, canonical_url: canonical.canonical_url, source: canonical };
  return { supported: false, reason: "Link is not a recognized ATS or identifiable public job page.", canonical_url: safeUrl, source: canonical };
}

function classification(code, messageRef, reason, extras = {}) {
  return { code, message_ref: messageRef, reason, ...extras };
}

function classificationCounts(items) {
  const counts = Object.fromEntries(Object.values(JOB_ALERT_CLASSIFICATIONS).map((code) => [code, 0]));
  for (const item of items) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return counts;
}

function proposedCandidate({ item, support, queryId, batchId, messageRef, receivedAt, linkIndex }) {
  return {
    discovery_query_id: queryId,
    finder: "gmail_alert_finder",
    discovery_source: "gmail_job_alert",
    source: "Gmail job alert",
    company: boundedText(item.metadata.company, 160),
    title: boundedText(item.metadata.title, 240),
    location: boundedText(item.metadata.location, 160),
    work_type: boundedText(item.metadata.work_type, 80),
    posted_date: item.metadata.posted_date ?? null,
    canonical_url: support.canonical_url,
    canonical_source_adapter: support.source?.adapter_id ?? null,
    job_id: support.source?.inferred_job_id ?? null,
    requires_public_verification: true,
    requires_judge: true,
    provenance: {
      transport: "gmail",
      batch_id: batchId,
      message_ref: messageRef,
      received_at: new Date(receivedAt).toISOString(),
      link_index: linkIndex,
      body_retained: false,
    },
  };
}

export function assertSanitizedJobAlertProposal(proposal) {
  const forbiddenKeys = new Set(["from", "sender", "subject", "text_body", "html_body", "body", "raw", "raw_text", "raw_html", "message_id"]);
  function inspect(value, path = "proposal") {
    if (Array.isArray(value)) return value.forEach((item, index) => inspect(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && PRIVATE_EMAIL_PATTERN.test(value)) {
        PRIVATE_EMAIL_PATTERN.lastIndex = 0;
        throw new Error(`${path} contains an email address`);
      }
      PRIVATE_EMAIL_PATTERN.lastIndex = 0;
      if (typeof value === "string" && PRIVATE_HOME_TEST_PATTERN.test(value)) {
        throw new Error(`${path} contains an absolute home-directory path`);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) throw new Error(`${path}.${key} is forbidden in a sanitized proposal`);
      inspect(child, `${path}.${key}`);
    }
  }
  inspect(proposal);
  return proposal;
}

export function ingestJobAlertBatch(batch, { config, existingIdentityKeys = [], now = null } = {}) {
  validateJobAlertBatchEnvelope(batch);
  const gmailConfig = validateGmailJobAlertsConfig(config);
  if (!gmailConfig.enabled) throw new Error("Gmail job-alert ingestion is disabled in local configuration");
  if (batch.transport.provider !== "gmail") throw new Error("Gmail ingestion requires transport.provider gmail");
  if (batch.transport.query !== undefined && normalizeText(batch.transport.query) !== gmailConfig.query) {
    throw new Error("Job-alert batch query does not match the configured Gmail query");
  }
  const asOf = now ? new Date(now) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error("Ingestion now timestamp is invalid");
  const queryId = "GMAIL-" + sha256(batch.batch_id).slice(0, 12).toUpperCase();
  const existing = existingIdentityKeys instanceof Set ? new Set(existingIdentityKeys) : new Set(existingIdentityKeys ?? []);
  const seen = new Set();
  const proposedCandidates = [];
  const classifications = [];
  const messageLimit = Math.min(batch.messages.length, gmailConfig.max_messages);

  for (let index = 0; index < batch.messages.length; index += 1) {
    const raw = batch.messages[index];
    const fallbackRef = messageReference(batch.batch_id, raw?.message_id, index);
    if (index >= messageLimit) {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.LIMIT_EXCEEDED, fallbackRef, "Message was outside the configured batch limit."));
      continue;
    }
    let message;
    try {
      message = validateMessage(raw, index);
    } catch {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.MALFORMED_MESSAGE, fallbackRef, "Message did not satisfy the versioned job-alert contract."));
      continue;
    }
    const messageRef = messageReference(batch.batch_id, message.message_id, index);
    if (!isAllowlistedSender(message.from, gmailConfig.sender_allowlist)) {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.SENDER_NOT_ALLOWED, messageRef, "Message sender is not on the configured allowlist."));
      continue;
    }
    const receivedAt = new Date(message.received_at);
    const ageHours = (asOf.getTime() - receivedAt.getTime()) / 3_600_000;
    if (ageHours < -1) {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.MALFORMED_MESSAGE, messageRef, "Message timestamp is unreasonably in the future."));
      continue;
    }
    if (ageHours > gmailConfig.freshness_hours) {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.STALE_MESSAGE, messageRef, "Message is outside the configured freshness window."));
      continue;
    }
    const extracted = extractJobAlertLinks(message);
    if (extracted.length === 0) {
      classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.EXTRACTION_FAILURE, messageRef, "No job URL could be extracted from the available text or HTML body."));
      continue;
    }
    const explicitMessageExpiry = EXPIRED_PATTERN.test(String(message.subject ?? ""));
    for (let linkIndex = 0; linkIndex < extracted.length; linkIndex += 1) {
      if (linkIndex >= gmailConfig.max_links_per_message) {
        classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.LIMIT_EXCEEDED, messageRef, "Link was outside the configured per-message limit.", { link_index: linkIndex }));
        continue;
      }
      const item = extracted[linkIndex];
      const support = supportForUrl(item.raw_url);
      if (!support.supported) {
        classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.UNSUPPORTED_LINK, messageRef, support.reason, { link_index: linkIndex }));
        continue;
      }
      if (item.expired || explicitMessageExpiry) {
        classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.EXPIRED_LISTING, messageRef, "Alert explicitly indicates that the listing is expired or unavailable.", { link_index: linkIndex, canonical_url: support.canonical_url }));
        continue;
      }
      const candidate = proposedCandidate({
        item, support, queryId, batchId: batch.batch_id, messageRef,
        receivedAt: message.received_at, linkIndex,
      });
      const keys = candidateIdentityKeys(candidate);
      if (keys.some((key) => seen.has(key))) {
        classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.DUPLICATE_IN_BATCH, messageRef, "Candidate duplicates an earlier identity in this batch.", { link_index: linkIndex, canonical_url: candidate.canonical_url }));
        continue;
      }
      if (keys.some((key) => existing.has(key))) {
        classifications.push(classification(JOB_ALERT_CLASSIFICATIONS.DUPLICATE_IN_TRACKER, messageRef, "Candidate already exists in the tracker identity index.", { link_index: linkIndex, canonical_url: candidate.canonical_url }));
        for (const key of keys) seen.add(key);
        continue;
      }
      for (const key of keys) seen.add(key);
      proposedCandidates.push(candidate);
    }
  }

  const proposalCore = {
    schema_version: JOB_ALERT_PROPOSAL_SCHEMA_VERSION,
    generated_at: new Date(batch.retrieved_at).toISOString(),
    transport: { provider: batch.transport.provider, access_mode: "read_only" },
    source: "gmail_job_alert",
    batch: {
      batch_id: batch.batch_id,
      message_count: batch.messages.length,
      query_sha256: sha256(normalizeText(batch.transport.query ?? gmailConfig.query)),
    },
    query_attempt: {
      query_id: queryId,
      finder: "gmail_alert_finder",
      role_family: null,
      source: "gmail_job_alert",
      lane: "allowlisted_inbox_alerts",
      status: "Completed",
    },
    proposed_candidates: proposedCandidates,
    classifications,
    diagnostics: {
      messages_received: batch.messages.length,
      messages_processed: messageLimit,
      candidates_proposed: proposedCandidates.length,
      classification_counts: classificationCounts(classifications),
    },
    privacy: {
      full_bodies_retained: false,
      subjects_retained: false,
      sender_addresses_retained: false,
      transport_message_ids_retained: false,
      provenance_uses_hashed_message_references: true,
    },
    next_boundary: "Publicly verify each proposed vacancy, run the existing blind judge, then use scripts/update_tracker.mjs for any tracker write.",
  };
  const proposal = {
    ...proposalCore,
    proposal_id: "JAP-" + sha256(JSON.stringify(stableCanonicalize(proposalCore))).slice(0, 24).toUpperCase(),
  };
  return assertSanitizedJobAlertProposal(proposal);
}
