import { normalizeText, normalizeUrl, RESUMES } from "./job_tracker_lib.mjs";

const COVERAGE_STATUSES = new Set(["Covered", "Transferable", "Gap"]);
const BULLET_ACTIONS = new Set(["Keep", "Reframe", "Add", "Remove"]);

function requiredText(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(label + " must be a non-empty string");
  return text;
}

function uniqueTexts(values, label) {
  if (!Array.isArray(values)) throw new Error(label + " must be an array");
  const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(label + " must not contain duplicates");
  return normalized;
}

export function extractCandidateEvidence(markdown) {
  const evidence = new Map();
  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^[-*]\s+(?:\*\*|`)(E-[A-Z0-9-]+)(?:\*\*|`)\s+[—-]\s+(.+)$/);
    if (!match) continue;
    const [, id, statement] = match;
    if (evidence.has(id)) throw new Error("Duplicate candidate evidence ID: " + id);
    evidence.set(id, normalizeText(statement));
  }
  if (!evidence.size) throw new Error("Candidate profile does not contain stable evidence IDs");
  return evidence;
}

function referencedEvidence(values, evidence, label, { allowEmpty = false } = {}) {
  const ids = uniqueTexts(values, label);
  if (!allowEmpty && !ids.length) throw new Error(label + " must cite at least one candidate evidence ID");
  for (const id of ids) if (!evidence.has(id)) throw new Error(`${label} references unknown candidate evidence ID: ${id}`);
  return ids;
}

export function validateTailoringReport(raw, evidence) {
  if (!(evidence instanceof Map)) throw new Error("Candidate evidence catalog must be a Map");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Tailoring report must be an object");
  if (raw.schema_version !== 1) throw new Error("Unsupported tailoring report schema_version: " + raw.schema_version);
  const generatedAt = new Date(requiredText(raw.generated_at, "generated_at"));
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("generated_at must be a valid timestamp");
  const job = {
    lead_id: requiredText(raw.job?.lead_id, "job.lead_id"),
    company: requiredText(raw.job?.company, "job.company"),
    role: requiredText(raw.job?.role, "job.role"),
    canonical_url: normalizeUrl(requiredText(raw.job?.canonical_url, "job.canonical_url")),
    description_hash: requiredText(raw.job?.description_hash, "job.description_hash").toLowerCase(),
  };
  if (!/^[a-f0-9]{64}$/.test(job.description_hash)) throw new Error("job.description_hash must be a SHA-256 hash");
  const resumeVersion = requiredText(raw.resume_version, "resume_version");
  if (!RESUMES.has(resumeVersion)) throw new Error("Invalid resume_version: " + resumeVersion);

  if (!Array.isArray(raw.requirements) || !raw.requirements.length) throw new Error("requirements must be a non-empty array");
  const requirementIds = new Set();
  const requirements = raw.requirements.map((item, index) => {
    const id = requiredText(item?.requirement_id, `requirements[${index}].requirement_id`);
    if (requirementIds.has(id)) throw new Error("Duplicate requirement_id: " + id);
    requirementIds.add(id);
    return {
      requirement_id: id,
      text: requiredText(item.text, `requirements[${index}].text`),
      keywords: uniqueTexts(item.keywords, `requirements[${index}].keywords`),
      source_evidence: requiredText(item.source_evidence, `requirements[${index}].source_evidence`),
    };
  });
  const expectedKeywords = new Set(requirements.flatMap((item) => item.keywords.map((keyword) => keyword.toLowerCase())));

  if (!Array.isArray(raw.keyword_coverage)) throw new Error("keyword_coverage must be an array");
  const keywordCoverage = raw.keyword_coverage.map((item, index) => {
    const keyword = requiredText(item?.keyword, `keyword_coverage[${index}].keyword`);
    const key = keyword.toLowerCase();
    if (!expectedKeywords.has(key)) throw new Error("keyword_coverage contains a keyword absent from requirements: " + keyword);
    const status = requiredText(item.status, `keyword_coverage[${index}].status`);
    if (!COVERAGE_STATUSES.has(status)) throw new Error("Invalid keyword coverage status: " + status);
    const requirementRefs = uniqueTexts(item.requirement_ids, `keyword_coverage[${index}].requirement_ids`);
    if (!requirementRefs.length || requirementRefs.some((id) => !requirementIds.has(id))) throw new Error("keyword coverage must reference known requirements");
    const evidenceIds = referencedEvidence(item.evidence_ids ?? [], evidence, `keyword_coverage[${index}].evidence_ids`, { allowEmpty: status === "Gap" });
    if (status === "Gap" && evidenceIds.length) throw new Error("Gap keyword coverage must not cite candidate evidence");
    return { keyword, requirement_ids: requirementRefs, status, evidence_ids: evidenceIds, notes: normalizeText(item.notes) || null };
  });
  const actualKeywords = keywordCoverage.map((item) => item.keyword.toLowerCase());
  if (new Set(actualKeywords).size !== actualKeywords.length) throw new Error("keyword_coverage must not contain duplicate keywords");
  if (actualKeywords.length !== expectedKeywords.size || actualKeywords.some((key) => !expectedKeywords.has(key))) {
    throw new Error("keyword_coverage must contain exactly one entry for every requirement keyword");
  }

  if (!Array.isArray(raw.bullet_recommendations)) throw new Error("bullet_recommendations must be an array");
  const bulletIds = new Set();
  const bullets = raw.bullet_recommendations.map((item, index) => {
    const id = requiredText(item?.bullet_id, `bullet_recommendations[${index}].bullet_id`);
    if (bulletIds.has(id)) throw new Error("Duplicate bullet_id: " + id);
    bulletIds.add(id);
    const action = requiredText(item.action, `bullet_recommendations[${index}].action`);
    if (!BULLET_ACTIONS.has(action)) throw new Error("Invalid bullet action: " + action);
    return {
      bullet_id: id,
      action,
      text: requiredText(item.text, `bullet_recommendations[${index}].text`),
      candidate_evidence_ids: referencedEvidence(item.candidate_evidence_ids, evidence, `bullet_recommendations[${index}].candidate_evidence_ids`),
      source_resume: requiredText(item.source_resume, `bullet_recommendations[${index}].source_resume`),
      rationale: requiredText(item.rationale, `bullet_recommendations[${index}].rationale`),
    };
  });

  if (!Array.isArray(raw.gaps)) throw new Error("gaps must be an array");
  const gaps = raw.gaps.map((item, index) => {
    const requirementId = requiredText(item?.requirement_id, `gaps[${index}].requirement_id`);
    if (!requirementIds.has(requirementId)) throw new Error("Gap references unknown requirement: " + requirementId);
    return { requirement_id: requirementId, handling: requiredText(item.handling, `gaps[${index}].handling`) };
  });
  const prohibitedClaims = uniqueTexts(raw.prohibited_claims ?? [], "prohibited_claims");
  if (!raw.review || raw.review.agent !== "job_judge" || raw.review.status !== "Completed") throw new Error("Tailoring report requires a completed job_judge review");
  const decision = requiredText(raw.review.decision, "review.decision");
  if (!["Approved", "Needs Revision"].includes(decision)) throw new Error("Invalid review.decision");
  const reviewedAt = new Date(requiredText(raw.review.reviewed_at, "review.reviewed_at"));
  if (!Number.isFinite(reviewedAt.getTime())) throw new Error("review.reviewed_at must be a valid timestamp");
  const supported = uniqueTexts(raw.review.supported_bullet_ids ?? [], "review.supported_bullet_ids");
  const unsupported = uniqueTexts(raw.review.unsupported_bullet_ids ?? [], "review.unsupported_bullet_ids");
  for (const id of [...supported, ...unsupported]) if (!bulletIds.has(id)) throw new Error("Review references unknown bullet: " + id);
  if (decision === "Approved" && (unsupported.length || supported.length !== bullets.length || bullets.some((item) => !supported.includes(item.bullet_id)))) {
    throw new Error("Approved tailoring reports must support every bullet and contain no unsupported bullets");
  }
  return {
    schema_version: 1, generated_at: generatedAt.toISOString(), job, resume_version: resumeVersion, requirements,
    keyword_coverage: keywordCoverage, bullet_recommendations: bullets, gaps, prohibited_claims: prohibitedClaims,
    review: { agent: "job_judge", status: "Completed", decision, reviewed_at: reviewedAt.toISOString(), supported_bullet_ids: supported, unsupported_bullet_ids: unsupported, notes: normalizeText(raw.review.notes) || null },
  };
}

function cell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

export function renderTailoringReportMarkdown(report, evidence) {
  const lines = [
    `# Tailoring report — ${report.job.company} — ${report.job.role}`,
    "",
    `- Lead: ${report.job.lead_id}`,
    `- Resume: ${report.resume_version}`,
    `- Canonical job: ${report.job.canonical_url}`,
    `- Description hash: \`${report.job.description_hash}\``,
    `- Independent review: ${report.review.decision}`,
    "",
    "## ATS keyword coverage", "", "| Keyword | Coverage | Evidence | Notes |", "|---|---|---|---|",
    ...report.keyword_coverage.map((item) => `| ${cell(item.keyword)} | ${item.status} | ${cell(item.evidence_ids.join(", ") || "—")} | ${cell(item.notes || "—")} |`),
    "", "## Evidence-backed bullet recommendations", "",
  ];
  for (const item of report.bullet_recommendations) {
    lines.push(`### ${item.action}: ${item.bullet_id}`, "", item.text, "", `Evidence: ${item.candidate_evidence_ids.join(", ")}`, "", `Rationale: ${item.rationale}`, "");
  }
  lines.push("## Gaps", "");
  if (!report.gaps.length) lines.push("No explicit gaps recorded.", "");
  for (const item of report.gaps) lines.push(`- **${item.requirement_id}:** ${item.handling}`);
  lines.push("", "## Prohibited unsupported claims", "");
  if (!report.prohibited_claims.length) lines.push("No additional prohibited claims were supplied.");
  for (const item of report.prohibited_claims) lines.push(`- ${item}`);
  lines.push("", "## Cited candidate evidence", "");
  const cited = new Set(report.bullet_recommendations.flatMap((item) => item.candidate_evidence_ids).concat(report.keyword_coverage.flatMap((item) => item.evidence_ids)));
  for (const id of [...cited].sort()) lines.push(`- **${id}:** ${evidence.get(id)}`);
  lines.push("", "This report is advisory. It does not modify a resume, populate an application, or submit anything.", "");
  return lines.join("\n");
}
