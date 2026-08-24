import path from "node:path";
import { normalizeText, normalizeUrl } from "./job_tracker_lib.mjs";

export const FORM_SCHEMA_VERSION = 1;
export const FORM_AGENT = "application_form_agent";
export const FORM_REVIEWER = "job_judge";

export const FORM_INPUT_TYPES = new Set([
  "text", "textarea", "email", "tel", "number", "url", "date", "select", "radio", "checkbox", "file", "other",
]);
export const FORM_FIELD_CLASSIFICATIONS = new Set([
  "identity", "contact", "experience", "technical", "motivation", "salary", "availability", "location",
  "work_authorization", "sponsorship", "relocation", "sensitive_demographic", "legal_attestation", "signature",
  "resume_upload", "other",
]);
export const FORM_DRAFT_STATUSES = new Set(["Ready", "Needs User Input", "Do Not Answer", "Not Applicable"]);
export const FORM_REVIEW_DECISIONS = new Set(["Accepted", "Rewritten", "Needs User Input", "Do Not Answer", "Not Applicable"]);
export const FORM_CONFIDENCE = new Set(["High", "Medium", "Low"]);
export const COVER_LETTER_REQUIREMENTS = new Set(["Required", "Optional", "Absent", "Unclear"]);
export const COVER_LETTER_INPUT_TYPES = new Set(["textarea", "file", "none", "Unclear"]);
export const COVER_LETTER_DRAFT_STATUSES = new Set(["Ready", "Needs User Input", "Not Drafted"]);

const ALWAYS_MANUAL = new Set(["sensitive_demographic", "legal_attestation", "signature"]);
const CONFIRM_BEFORE_READY = new Set(["salary", "availability", "location", "work_authorization", "sponsorship", "relocation"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(label + " must be an object");
  return value;
}

function requireKeys(value, required, allowed, label) {
  const object = requireObject(value, label);
  for (const key of required) {
    if (!(key in object)) throw new Error(label + " is missing required field: " + key);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new Error(label + " contains unsupported field: " + key);
  }
  return object;
}

function requireText(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(label + " must be non-empty text");
  return text;
}

function optionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function optionalMultiline(value) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  return text || null;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(label + " must be boolean");
  return value;
}

function requireDate(value, label) {
  const text = requireText(value, label);
  if (!Number.isFinite(new Date(text).getTime())) throw new Error(label + " must be an ISO-8601 timestamp");
  return text;
}

function requireUrl(value, label) {
  const text = normalizeUrl(requireText(value, label));
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(label + " must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(label + " must be an absolute HTTP(S) URL");
  return text;
}

function requireEnum(value, allowed, label) {
  const text = requireText(value, label);
  if (!allowed.has(text)) throw new Error(label + " has invalid value: " + text);
  return text;
}

function requireStringArray(value, label, { nonEmpty = false, unique = true } = {}) {
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  const normalized = value.map((entry, index) => requireText(entry, `${label}[${index}]`));
  if (nonEmpty && !normalized.length) throw new Error(label + " must contain at least one value");
  if (unique && new Set(normalized).size !== normalized.length) throw new Error(label + " must not contain duplicates");
  return normalized;
}

function validateStep(value) {
  const step = requireKeys(value, ["index", "title"], ["index", "total", "title"], "form.step");
  if (!Number.isInteger(step.index) || step.index < 1) throw new Error("form.step.index must be a positive integer");
  if (step.total !== undefined && step.total !== null && (!Number.isInteger(step.total) || step.total < step.index)) {
    throw new Error("form.step.total must be an integer greater than or equal to form.step.index");
  }
  return { index: step.index, total: step.total ?? null, title: requireText(step.title, "form.step.title") };
}

function validateSubmissionControl(value) {
  const control = requireKeys(value, ["detected", "interacted"], ["detected", "label", "interacted"], "form.submission_control");
  const interacted = requireBoolean(control.interacted, "form.submission_control.interacted");
  if (interacted) throw new Error("The form agent must not interact with a submission control");
  return {
    detected: requireBoolean(control.detected, "form.submission_control.detected"),
    label: optionalText(control.label),
    interacted: false,
  };
}

function validateField(value, index) {
  const label = `form.fields[${index}]`;
  const field = requireKeys(value,
    ["field_id", "label", "input_type", "required", "required_evidence", "classification", "options", "proposed_status", "proposed_response", "evidence_ids", "confidence", "user_confirmed"],
    ["field_id", "label", "input_type", "required", "required_evidence", "classification", "options", "character_limit", "proposed_status", "proposed_response", "evidence_ids", "confidence", "user_confirmed", "notes"],
    label,
  );
  const classification = requireEnum(field.classification, FORM_FIELD_CLASSIFICATIONS, label + ".classification");
  const proposedStatus = requireEnum(field.proposed_status, FORM_DRAFT_STATUSES, label + ".proposed_status");
  const proposedResponse = optionalMultiline(field.proposed_response);
  const userConfirmed = requireBoolean(field.user_confirmed, label + ".user_confirmed");
  const evidenceIds = requireStringArray(field.evidence_ids, label + ".evidence_ids");
  if (![true, false, "Unclear"].includes(field.required)) throw new Error(label + ".required must be true, false, or Unclear");
  if (field.character_limit !== undefined && field.character_limit !== null && (!Number.isInteger(field.character_limit) || field.character_limit < 1)) {
    throw new Error(label + ".character_limit must be a positive integer or null");
  }
  if (proposedStatus === "Ready") {
    if (!proposedResponse) throw new Error(label + ".proposed_response is required when proposed_status is Ready");
    if (!evidenceIds.length) throw new Error(label + ".evidence_ids is required when proposed_status is Ready");
    if (field.character_limit && [...proposedResponse].length > field.character_limit) {
      throw new Error(label + ".proposed_response exceeds character_limit");
    }
  } else if (proposedResponse) {
    throw new Error(label + ".proposed_response must be empty unless proposed_status is Ready");
  }
  if (ALWAYS_MANUAL.has(classification) && !["Needs User Input", "Do Not Answer"].includes(proposedStatus)) {
    throw new Error(label + " must remain manual because it is sensitive, legal, or a signature");
  }
  if (CONFIRM_BEFORE_READY.has(classification) && proposedStatus === "Ready" && !userConfirmed) {
    throw new Error(label + " requires explicit user confirmation before it can be Ready");
  }
  return {
    field_id: requireText(field.field_id, label + ".field_id"),
    label: requireText(field.label, label + ".label"),
    input_type: requireEnum(field.input_type, FORM_INPUT_TYPES, label + ".input_type"),
    required: field.required,
    required_evidence: requireText(field.required_evidence, label + ".required_evidence"),
    classification,
    options: requireStringArray(field.options, label + ".options", { unique: false }),
    character_limit: field.character_limit ?? null,
    proposed_status: proposedStatus,
    proposed_response: proposedResponse,
    evidence_ids: evidenceIds,
    confidence: requireEnum(field.confidence, FORM_CONFIDENCE, label + ".confidence"),
    user_confirmed: userConfirmed,
    notes: optionalMultiline(field.notes),
  };
}

function validateCoverLetter(value) {
  const label = "form.cover_letter";
  const cover = requireKeys(value,
    ["detected", "field_id", "label", "requirement", "requirement_evidence", "input_type", "accepted_types", "proposed_status", "proposed_text", "evidence_ids"],
    ["detected", "field_id", "label", "requirement", "requirement_evidence", "input_type", "accepted_types", "proposed_status", "proposed_text", "evidence_ids", "notes"],
    label,
  );
  const detected = requireBoolean(cover.detected, label + ".detected");
  const requirement = requireEnum(cover.requirement, COVER_LETTER_REQUIREMENTS, label + ".requirement");
  const inputType = requireEnum(cover.input_type, COVER_LETTER_INPUT_TYPES, label + ".input_type");
  const proposedStatus = requireEnum(cover.proposed_status, COVER_LETTER_DRAFT_STATUSES, label + ".proposed_status");
  const proposedText = optionalMultiline(cover.proposed_text);
  const evidenceIds = requireStringArray(cover.evidence_ids, label + ".evidence_ids");
  if (!detected && requirement !== "Absent") throw new Error("An undetected cover-letter field must have requirement Absent");
  if (detected && requirement === "Absent") throw new Error("A detected cover-letter field cannot have requirement Absent");
  if (!detected && (inputType !== "none" || cover.field_id || cover.label)) {
    throw new Error("An absent cover-letter field must use input_type none and empty field metadata");
  }
  if (["Optional", "Absent", "Unclear"].includes(requirement)) {
    if (proposedStatus !== "Not Drafted" || proposedText || evidenceIds.length) {
      throw new Error("Optional, absent, or unclear cover letters must not be drafted");
    }
  }
  if (requirement === "Required" && proposedStatus === "Ready") {
    if (!proposedText) throw new Error("A ready required cover letter must include proposed_text");
    if (!evidenceIds.length) throw new Error("A ready required cover letter must include evidence_ids");
  }
  if (requirement === "Required" && proposedStatus === "Not Drafted") {
    throw new Error("A required cover letter must be drafted or marked Needs User Input");
  }
  if (proposedStatus !== "Ready" && proposedText) throw new Error("cover_letter.proposed_text is allowed only when proposed_status is Ready");
  return {
    detected,
    field_id: optionalText(cover.field_id),
    label: optionalText(cover.label),
    requirement,
    requirement_evidence: requireText(cover.requirement_evidence, label + ".requirement_evidence"),
    input_type: inputType,
    accepted_types: requireStringArray(cover.accepted_types, label + ".accepted_types"),
    proposed_status: proposedStatus,
    proposed_text: proposedText,
    evidence_ids: evidenceIds,
    notes: optionalMultiline(cover.notes),
  };
}

function validateForm(value) {
  const form = requireKeys(value,
    ["agent", "status", "form_id", "lead_id", "captured_at", "canonical_job_url", "form_url", "ats", "page_scope", "step", "fields", "cover_letter", "submission_control"],
    ["agent", "status", "form_id", "lead_id", "captured_at", "canonical_job_url", "form_url", "ats", "page_scope", "step", "fields", "cover_letter", "submission_control", "notes"],
    "form",
  );
  if (form.agent !== FORM_AGENT) throw new Error("form.agent must be " + FORM_AGENT);
  if (!["Completed", "Partial"].includes(form.status)) throw new Error("form.status must be Completed or Partial");
  const formId = requireText(form.form_id, "form.form_id");
  if (!/^FORM-[A-Z0-9][A-Z0-9_-]{5,80}$/i.test(formId)) throw new Error("form.form_id has invalid format");
  const leadId = requireText(form.lead_id, "form.lead_id");
  if (!/^L-[A-Z0-9][A-Z0-9_-]{2,80}$/i.test(leadId)) throw new Error("form.lead_id has invalid format");
  if (!Array.isArray(form.fields) || form.fields.length > 200) throw new Error("form.fields must be an array with at most 200 items");
  const fields = form.fields.map(validateField);
  const ids = fields.map((field) => field.field_id);
  if (new Set(ids).size !== ids.length) throw new Error("form.fields contains duplicate field_id values");
  return {
    agent: FORM_AGENT,
    status: form.status,
    form_id: formId,
    lead_id: leadId,
    captured_at: requireDate(form.captured_at, "form.captured_at"),
    canonical_job_url: requireUrl(form.canonical_job_url, "form.canonical_job_url"),
    form_url: requireUrl(form.form_url, "form.form_url"),
    ats: requireText(form.ats, "form.ats"),
    page_scope: requireEnum(form.page_scope, new Set(["Current Step", "Complete Form"]), "form.page_scope"),
    step: validateStep(form.step),
    fields,
    cover_letter: validateCoverLetter(form.cover_letter),
    submission_control: validateSubmissionControl(form.submission_control),
    notes: optionalMultiline(form.notes),
  };
}

function validateFieldReview(value, index, fieldsById) {
  const label = `review.fields[${index}]`;
  const result = requireKeys(value,
    ["field_id", "decision", "final_response", "supported_evidence_ids", "unsupported_evidence", "unsupported_details", "notes"],
    ["field_id", "decision", "final_response", "supported_evidence_ids", "unsupported_evidence", "unsupported_details", "notes"],
    label,
  );
  const fieldId = requireText(result.field_id, label + ".field_id");
  const field = fieldsById.get(fieldId);
  if (!field) throw new Error(label + " references unknown field_id: " + fieldId);
  const decision = requireEnum(result.decision, FORM_REVIEW_DECISIONS, label + ".decision");
  const finalResponse = optionalMultiline(result.final_response);
  const supportedEvidenceIds = requireStringArray(result.supported_evidence_ids, label + ".supported_evidence_ids");
  const unsupportedEvidence = requireBoolean(result.unsupported_evidence, label + ".unsupported_evidence");
  const unsupportedDetails = optionalMultiline(result.unsupported_details);
  if (["Accepted", "Rewritten"].includes(decision)) {
    if (!finalResponse) throw new Error(label + ".final_response is required for accepted or rewritten answers");
    if (!supportedEvidenceIds.length) throw new Error(label + ".supported_evidence_ids is required for accepted or rewritten answers");
    if (unsupportedEvidence) throw new Error(label + " cannot be accepted while unsupported_evidence is true");
    if (field.character_limit && [...finalResponse].length > field.character_limit) {
      throw new Error(label + ".final_response exceeds the field character limit");
    }
  } else if (finalResponse) {
    throw new Error(label + ".final_response must be empty unless the answer is accepted or rewritten");
  }
  if (unsupportedEvidence && !unsupportedDetails) throw new Error(label + ".unsupported_details is required when unsupported_evidence is true");
  if (field.proposed_status === "Ready" && !["Accepted", "Rewritten", "Needs User Input"].includes(decision)) {
    throw new Error(label + " has an incompatible review decision for a drafted answer");
  }
  if (field.proposed_status === "Needs User Input" && decision !== "Needs User Input") {
    throw new Error(label + " must remain Needs User Input until the user supplies an answer");
  }
  if (field.proposed_status === "Do Not Answer" && decision !== "Do Not Answer") {
    throw new Error(label + " must remain Do Not Answer");
  }
  if (field.proposed_status === "Not Applicable" && decision !== "Not Applicable") {
    throw new Error(label + " must remain Not Applicable");
  }
  return {
    field_id: fieldId,
    decision,
    final_response: finalResponse,
    supported_evidence_ids: supportedEvidenceIds,
    unsupported_evidence: unsupportedEvidence,
    unsupported_details: unsupportedDetails,
    notes: optionalMultiline(result.notes),
  };
}

function validateCoverLetterReview(value, cover) {
  const label = "review.cover_letter";
  const result = requireKeys(value,
    ["decision", "final_text", "supported_evidence_ids", "unsupported_evidence", "unsupported_details", "notes"],
    ["decision", "final_text", "supported_evidence_ids", "unsupported_evidence", "unsupported_details", "document_path", "notes"],
    label,
  );
  const decision = requireEnum(result.decision, FORM_REVIEW_DECISIONS, label + ".decision");
  const finalText = optionalMultiline(result.final_text);
  const supportedEvidenceIds = requireStringArray(result.supported_evidence_ids, label + ".supported_evidence_ids");
  const unsupportedEvidence = requireBoolean(result.unsupported_evidence, label + ".unsupported_evidence");
  const unsupportedDetails = optionalMultiline(result.unsupported_details);
  const documentPath = optionalText(result.document_path);
  if (cover.requirement === "Required" && cover.proposed_status === "Ready") {
    if (!["Accepted", "Rewritten", "Needs User Input"].includes(decision)) throw new Error("A drafted required cover letter must be reviewed");
    if (["Accepted", "Rewritten"].includes(decision) && (!finalText || !supportedEvidenceIds.length || unsupportedEvidence)) {
      throw new Error("An accepted required cover letter needs supported final text and no unsupported evidence");
    }
  } else if (cover.requirement === "Required") {
    if (decision !== "Needs User Input") throw new Error("An undrafted required cover letter must remain Needs User Input");
  } else if (decision !== "Not Applicable" || finalText || supportedEvidenceIds.length || unsupportedEvidence) {
    throw new Error("Optional, absent, or unclear cover letters must remain Not Applicable with no draft");
  }
  if (!["Accepted", "Rewritten"].includes(decision) && finalText) {
    throw new Error(label + ".final_text is allowed only for accepted or rewritten cover letters");
  }
  if (documentPath) {
    if (cover.requirement !== "Required" || !["Accepted", "Rewritten"].includes(decision)) {
      throw new Error(label + ".document_path is allowed only for a reviewed required cover letter");
    }
    if (path.isAbsolute(documentPath) || documentPath.split(/[\\/]+/).includes("..") || !/\.(docx|pdf)$/i.test(documentPath)) {
      throw new Error(label + ".document_path must be a safe relative DOCX or PDF path");
    }
  }
  if (cover.requirement === "Required" && cover.input_type === "file" && ["Accepted", "Rewritten"].includes(decision) && !documentPath) {
    throw new Error(label + ".document_path is required for a required cover-letter file upload");
  }
  if (unsupportedEvidence && !unsupportedDetails) throw new Error(label + ".unsupported_details is required when unsupported_evidence is true");
  return {
    decision,
    final_text: finalText,
    supported_evidence_ids: supportedEvidenceIds,
    unsupported_evidence: unsupportedEvidence,
    unsupported_details: unsupportedDetails,
    document_path: documentPath,
    notes: optionalMultiline(result.notes),
  };
}

function validateReview(value, form) {
  const review = requireKeys(value,
    ["agent", "status", "reviewed_at", "fields", "cover_letter", "notes"],
    ["agent", "status", "reviewed_at", "fields", "cover_letter", "notes"],
    "review",
  );
  if (review.agent !== FORM_REVIEWER) throw new Error("review.agent must be " + FORM_REVIEWER);
  if (review.status !== "Completed") throw new Error("review.status must be Completed");
  if (!Array.isArray(review.fields)) throw new Error("review.fields must be an array");
  const fieldsById = new Map(form.fields.map((field) => [field.field_id, field]));
  const fields = review.fields.map((item, index) => validateFieldReview(item, index, fieldsById));
  if (fields.length !== form.fields.length || new Set(fields.map((field) => field.field_id)).size !== form.fields.length) {
    throw new Error("review.fields must contain exactly one result for every form field");
  }
  return {
    agent: FORM_REVIEWER,
    status: "Completed",
    reviewed_at: requireDate(review.reviewed_at, "review.reviewed_at"),
    fields,
    cover_letter: validateCoverLetterReview(review.cover_letter, form.cover_letter),
    notes: optionalMultiline(review.notes),
  };
}

export function validateApplicationFormPacket(value) {
  const envelope = requireKeys(value, ["schema_version", "form", "review"], ["schema_version", "form", "review"], "packet");
  if (envelope.schema_version !== FORM_SCHEMA_VERSION) throw new Error("Unsupported application-form schema_version");
  const form = validateForm(envelope.form);
  const review = validateReview(envelope.review, form);
  return { schema_version: FORM_SCHEMA_VERSION, form, review };
}

export function applicationFormSummary(packet) {
  const reviewById = new Map(packet.review.fields.map((field) => [field.field_id, field]));
  const counts = { fields: packet.form.fields.length + (packet.form.cover_letter.detected ? 1 : 0), ready: 0, needs_input: 0, manual: 0, not_applicable: 0 };
  for (const field of packet.form.fields) {
    const decision = reviewById.get(field.field_id).decision;
    if (["Accepted", "Rewritten"].includes(decision)) counts.ready += 1;
    else if (decision === "Needs User Input") counts.needs_input += 1;
    else if (decision === "Do Not Answer") counts.manual += 1;
    else counts.not_applicable += 1;
  }
  const cover = packet.form.cover_letter;
  const coverReview = packet.review.cover_letter;
  if (["Accepted", "Rewritten"].includes(coverReview.decision)) counts.ready += 1;
  else if (coverReview.decision === "Needs User Input") counts.needs_input += 1;
  else if (cover.detected && coverReview.decision === "Do Not Answer") counts.manual += 1;
  else if (cover.detected) counts.not_applicable += 1;
  let coverLetterStatus;
  if (cover.requirement === "Required" && ["Accepted", "Rewritten"].includes(coverReview.decision)) coverLetterStatus = "Required — drafted";
  else if (cover.requirement === "Required") coverLetterStatus = "Required — needs input";
  else if (cover.requirement === "Optional") coverLetterStatus = "Optional — not drafted";
  else if (cover.requirement === "Absent") coverLetterStatus = "Not present";
  else coverLetterStatus = "Unclear — not drafted";
  return {
    ...counts,
    cover_letter_requirement: cover.requirement,
    cover_letter_status: coverLetterStatus,
    review_status: counts.needs_input || counts.manual || coverReview.decision === "Needs User Input" ? "Needs User Input" : "Ready",
  };
}

export function safePacketSegment(value) {
  const safe = requireText(value, "path segment").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
  if (!safe || safe === "." || safe === "..") throw new Error("Unsafe packet path segment");
  return safe;
}

export function resolveInside(baseDirectory, ...segments) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Resolved path escapes the configured directory");
  return resolved;
}

export function renderApplicationFormMarkdown(packet, application, packetJsonPath) {
  const summary = applicationFormSummary(packet);
  const reviews = new Map(packet.review.fields.map((field) => [field.field_id, field]));
  const lines = [
    `# Application form responses — ${application.company} — ${application.role}`,
    "",
    `- Lead ID: ${packet.form.lead_id}`,
    `- Form ID: ${packet.form.form_id}`,
    `- ATS: ${packet.form.ats}`,
    `- Form: ${packet.form.form_url}`,
    `- Captured: ${packet.form.captured_at}`,
    `- Step: ${packet.form.step.index}${packet.form.step.total ? ` of ${packet.form.step.total}` : ""} — ${packet.form.step.title}`,
    `- Recommended resume: ${application.resume}`,
    `- Review status: ${summary.review_status}`,
    "",
    "## Ready to paste",
    "",
  ];
  const ready = packet.form.fields.filter((field) => ["Accepted", "Rewritten"].includes(reviews.get(field.field_id).decision));
  if (!ready.length) lines.push("No responses are ready yet.", "");
  for (const field of ready) {
    const review = reviews.get(field.field_id);
    lines.push(
      `### ${field.label}`,
      "",
      review.final_response,
      "",
      `Evidence: ${review.supported_evidence_ids.join(", ")} · Confidence: ${field.confidence}`,
      "",
    );
  }
  lines.push("## Needs your input", "");
  const pending = packet.form.fields.filter((field) => reviews.get(field.field_id).decision === "Needs User Input");
  if (!pending.length) lines.push("None.", "");
  for (const field of pending) {
    const review = reviews.get(field.field_id);
    lines.push(`- **${field.label}:** ${review.unsupported_details || review.notes || field.notes || "A verified answer is required."}`);
  }
  if (pending.length) lines.push("");
  lines.push("## Manual or skipped fields", "");
  const manual = packet.form.fields.filter((field) => ["Do Not Answer", "Not Applicable"].includes(reviews.get(field.field_id).decision));
  if (!manual.length) lines.push("None.", "");
  for (const field of manual) lines.push(`- **${field.label}:** ${reviews.get(field.field_id).decision}`);
  if (manual.length) lines.push("");
  lines.push("## Cover letter", "", `Status: ${summary.cover_letter_status}`, "");
  if (["Accepted", "Rewritten"].includes(packet.review.cover_letter.decision)) {
    lines.push(packet.review.cover_letter.final_text, "", `Evidence: ${packet.review.cover_letter.supported_evidence_ids.join(", ")}`, "");
  }
  lines.push(
    "## Safety boundary",
    "",
    "These are drafts for manual review. No form fields were populated, no files were uploaded, and no application was submitted.",
    "",
    `Validated packet: ${packetJsonPath}`,
    "",
  );
  return lines.join("\n");
}
