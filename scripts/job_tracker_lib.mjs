import crypto from "node:crypto";

export const SCORE_MAXIMA = Object.freeze({
  responsibilities: 25,
  technical: 20,
  seniority: 15,
  evidence: 15,
  domain: 10,
  location: 10,
  compensation: 5,
});

export const ELIGIBILITY = new Set(["Eligible", "Unclear", "Ineligible", "Needs Human Review", "Needs Judge"]);
export const ELIGIBILITY_DECISIONS = new Set(["Eligible", "Unclear", "Ineligible"]);
export const CONFIDENCE = new Set(["High", "Medium", "Low"]);
export const LISTING_STATUS = new Set(["Active", "Expired", "Inaccessible"]);
export const JUDGE_STATUS = new Set(["Judged", "Needs Judge", "Legacy / unjudged", "Failed"]);
export const RESUMES = new Set([
  "Backend / Platform",
  "Staff / Principal / Tech Lead",
  "Applied AI / LLM",
  "Developer Productivity / AI Enablement",
  "Full-stack / Product",
]);

export function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeUrl(value) {
  const text = normalizeText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|source$|source_|ref$|referrer$|lever-origin$|lever-source$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    const rendered = url.toString();
    return rendered.endsWith("/") ? rendered.slice(0, -1) : rendered;
  } catch {
    return text;
  }
}

export function canonicalKey(candidate) {
  return candidateIdentityKeys(candidate)[0];
}

export function candidateIdentityKeys(candidate) {
  const company = normalizeText(candidate.company).toLowerCase();
  const jobId = normalizeText(candidate.job_id ?? candidate.jobId).toLowerCase();
  const keys = [];
  if (company && jobId) keys.push("job:" + company + ":" + jobId);
  const url = normalizeUrl(candidate.canonical_url ?? candidate.canonicalUrl ?? candidate.url);
  if (url) keys.push("url:" + url.toLowerCase());
  const identity = [company, normalizeText(candidate.title).toLowerCase(), normalizeText(candidate.location).toLowerCase()].join("|");
  if (identity !== "||") keys.push("fallback:" + crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24));
  if (!keys.length) throw new Error("Candidate requires a job ID, canonical URL, or company/title/location identity");
  return keys;
}

export function descriptionHash(text) {
  return crypto.createHash("sha256").update(normalizeText(text)).digest("hex");
}

export function scoreTotal(scores) {
  let total = 0;
  for (const [key, maximum] of Object.entries(SCORE_MAXIMA)) {
    const value = Number(scores?.[key]);
    if (!Number.isFinite(value) || value < 0 || value > maximum) {
      throw new Error("Invalid score for " + key + ": expected 0-" + maximum);
    }
    total += value;
  }
  return total;
}

export function allocateLargestRemainder(total, allocations) {
  if (!Number.isInteger(total) || total < 0) throw new Error("Search total must be a non-negative integer");
  const entries = Object.entries(allocations);
  if (entries.some(([, weight]) => !Number.isFinite(Number(weight)) || Number(weight) < 0)) {
    throw new Error("Search allocations must be finite and non-negative");
  }
  const weightTotal = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  if (!entries.length || !Number.isFinite(weightTotal) || Math.abs(weightTotal - 1) > 1e-9) {
    throw new Error("Search allocations must sum to 1");
  }
  const rows = entries.map(([name, weight], index) => {
    const quota = total * Number(weight);
    return { name, index, count: Math.floor(quota), remainder: quota - Math.floor(quota) };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.count, 0);
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    row.count += 1;
    remaining -= 1;
  }
  return Object.fromEntries(rows.map(({ name, count }) => [name, count]));
}

export function recommendationBand(score, eligibility = "Eligible") {
  if (eligibility === "Ineligible") return "Suppressed";
  if (eligibility === "Needs Human Review") return "Needs Human Review";
  if (eligibility === "Needs Judge") return "Needs Judge";
  if (score >= 90) return "Immediate priority";
  if (score >= 80) return "Strong match";
  if (score >= 70) return "Review";
  if (score >= 60) return "Stretch/watchlist";
  return "Suppressed";
}

export function isAlertable(candidate, alertThreshold = 80) {
  return Number(candidate.final_score ?? candidate.finalScore) >= alertThreshold
    && candidate.listing_status === "Active"
    && ["Eligible", "Unclear"].includes(candidate.eligibility)
    && ["High", "Medium"].includes(candidate.confidence)
    && candidate.judge_status === "Judged"
    && candidate.status !== "Dismissed"
    && candidate.unsupported_evidence === false;
}

export function validateJudgedCandidate(candidate) {
  const required = [
    "company", "title", "location", "work_type", "canonical_url", "source", "eligibility", "eligibility_evidence",
    "confidence", "listing_status", "scores", "final_score", "best_resume", "strengths", "gaps", "judge_status",
  ];
  for (const key of required) {
    if (candidate[key] === undefined || candidate[key] === null || candidate[key] === "") {
      throw new Error("Missing required candidate field: " + key);
    }
  }
  if (!ELIGIBILITY.has(candidate.eligibility)) throw new Error("Invalid eligibility: " + candidate.eligibility);
  if (!CONFIDENCE.has(candidate.confidence)) throw new Error("Invalid confidence: " + candidate.confidence);
  if (!LISTING_STATUS.has(candidate.listing_status)) throw new Error("Invalid listing_status: " + candidate.listing_status);
  if (candidate.listing_status !== "Active" && candidate.eligibility !== "Ineligible") {
    throw new Error("Expired or inaccessible listings must be Ineligible");
  }
  if (!JUDGE_STATUS.has(candidate.judge_status)) throw new Error("Invalid judge_status: " + candidate.judge_status);
  if (candidate.judge_status !== "Judged") throw new Error("A scored candidate must have judge_status Judged");
  if (typeof candidate.unsupported_evidence !== "boolean") throw new Error("unsupported_evidence must be an explicit boolean");
  if (!RESUMES.has(candidate.best_resume)) throw new Error("Invalid best_resume: " + candidate.best_resume);
  if (!(Array.isArray(candidate.strengths) ? candidate.strengths.length : normalizeText(candidate.strengths))) {
    throw new Error("strengths must contain at least one evidence-backed item");
  }
  if (!normalizeText(candidate.job_description ?? candidate.description)) throw new Error("Judged candidate requires a job description");
  if (candidate.unsupported_evidence && !normalizeText(candidate.unsupported_evidence_details)) {
    throw new Error("unsupported_evidence_details is required when unsupported_evidence is true");
  }
  const total = scoreTotal(candidate.scores);
  if (candidate.final_score !== undefined && Number(candidate.final_score) !== total) {
    throw new Error("final_score does not equal component total");
  }
  return {
    ...candidate,
    canonical_url: normalizeUrl(candidate.canonical_url),
    canonical_key: canonicalKey(candidate),
    final_score: total,
    recommendation: recommendationBand(total, candidate.eligibility),
  };
}

export function shouldRepeatAlert(previous, current, alertThreshold = 80) {
  if (!previous?.last_alerted) return isAlertable(current, alertThreshold);
  if (!isAlertable(current, alertThreshold)) return false;
  const priorScore = Number(previous.final_score ?? 0);
  const nextScore = Number(current.final_score ?? 0);
  if (priorScore < alertThreshold && nextScore >= alertThreshold) return true;
  if (previous.eligibility !== "Eligible" && current.eligibility === "Eligible") return true;
  if (previous.description_hash && current.description_hash && previous.description_hash !== current.description_hash && Math.abs(nextScore - priorScore) >= 5) return true;
  return false;
}
