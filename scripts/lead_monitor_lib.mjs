import { descriptionHash, normalizeText, normalizeUrl } from "./job_tracker_lib.mjs";

const LISTING_STATUSES = new Set(["Active", "Expired", "Inaccessible"]);
const ELIGIBILITY = new Set(["Eligible", "Unclear", "Ineligible"]);

function requiredText(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(label + " must be a non-empty string");
  return text;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  const values = value.map((item, index) => requiredText(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(label + " contains duplicates");
  return values;
}

export function validateLeadMonitorCheck(raw, lead) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each monitor check must be an object");
  const leadId = requiredText(raw.lead_id, "monitor check lead_id");
  if (lead && leadId.toLowerCase() !== String(lead[0] ?? "").toLowerCase()) throw new Error("Monitor check lead_id does not match the lead");
  const canonicalUrl = normalizeUrl(requiredText(raw.canonical_url, "monitor check canonical_url"));
  if (lead && canonicalUrl !== normalizeUrl(lead[8])) throw new Error("Monitor check canonical_url does not match lead " + leadId);
  const listingStatus = requiredText(raw.listing_status ?? raw.result, "monitor check listing_status");
  if (!LISTING_STATUSES.has(listingStatus)) throw new Error("monitor check listing_status must be Active, Expired, or Inaccessible");
  const evidence = requiredText(raw.evidence, "monitor check evidence");
  const ids = stringList(raw.eligibility_evidence_ids, "monitor check eligibility_evidence_ids");
  if (listingStatus !== "Active") {
    return {
      lead_id: leadId,
      canonical_url: canonicalUrl,
      listing_status: listingStatus,
      evidence,
      location: null,
      work_type: null,
      description_hash: null,
      compensation_published: null,
      compensation: null,
      eligibility: "Ineligible",
      eligibility_evidence: evidence,
      eligibility_evidence_ids: ids,
    };
  }
  const description = requiredText(raw.job_description ?? raw.description, "active monitor check job_description");
  const hash = requiredText(raw.description_hash, "active monitor check description_hash").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("active monitor check requires a SHA-256 description_hash");
  if (hash !== descriptionHash(description)) throw new Error("active monitor check description_hash does not match the normalized job description");
  if (!raw.compensation || typeof raw.compensation !== "object" || Array.isArray(raw.compensation)) {
    throw new Error("active monitor check requires compensation");
  }
  if (typeof raw.compensation.published !== "boolean") throw new Error("monitor check compensation.published must be boolean");
  const compensation = normalizeText(raw.compensation.text) || null;
  if (raw.compensation.published && !compensation) throw new Error("published compensation requires compensation.text");
  if (!raw.compensation.published && compensation) throw new Error("unpublished compensation must not contain compensation.text");
  const eligibility = requiredText(raw.eligibility, "active monitor check eligibility");
  if (!ELIGIBILITY.has(eligibility)) throw new Error("active monitor check eligibility is invalid");
  return {
    lead_id: leadId,
    canonical_url: canonicalUrl,
    listing_status: listingStatus,
    evidence,
    location: requiredText(raw.location, "active monitor check location"),
    work_type: requiredText(raw.work_type, "active monitor check work_type"),
    description_hash: hash,
    compensation_published: raw.compensation.published,
    compensation,
    eligibility,
    eligibility_evidence: requiredText(raw.eligibility_evidence, "active monitor check eligibility_evidence"),
    eligibility_evidence_ids: ids,
  };
}

export function leadSnapshotFromRow(lead) {
  return {
    listing_status: String(lead[26] ?? "") === "Expired" ? "Expired" : "Active",
    location: normalizeText(lead[5]) || null,
    work_type: normalizeText(lead[6]) || null,
    description_hash: normalizeText(lead[29]) || null,
    compensation_published: null,
    compensation: null,
    eligibility: normalizeText(lead[11]) || null,
    eligibility_evidence: normalizeText(lead[12]) || null,
  };
}

function same(left, right) {
  return normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase();
}

export function compareLeadSnapshots(previous, current) {
  const changes = [];
  if (previous.listing_status !== current.listing_status) {
    changes.push({ type: "Listing Status", summary: `${previous.listing_status} → ${current.listing_status}` });
  }
  if (current.listing_status === "Active") {
    if (!same(previous.location, current.location)) changes.push({ type: "Location", summary: `${previous.location ?? "Unpublished"} → ${current.location}` });
    if (!same(previous.work_type, current.work_type)) changes.push({ type: "Work Type", summary: `${previous.work_type ?? "Unpublished"} → ${current.work_type}` });
    if (previous.description_hash && current.description_hash && previous.description_hash !== current.description_hash) {
      changes.push({ type: "Description", summary: "Canonical job description changed" });
    }
    if (previous.compensation_published === null && current.compensation_published === true) {
      changes.push({ type: "Compensation", summary: `Compensation published: ${current.compensation}` });
    } else if (previous.compensation_published !== null && previous.compensation_published !== current.compensation_published) {
      changes.push({
        type: "Compensation",
        summary: current.compensation_published ? `Compensation published: ${current.compensation}` : "Published compensation removed",
      });
    } else if (current.compensation_published && !same(previous.compensation, current.compensation)) {
      changes.push({ type: "Compensation", summary: `${previous.compensation ?? "Unpublished"} → ${current.compensation}` });
    }
    if (!same(previous.eligibility, current.eligibility)) {
      changes.push({ type: "Eligibility", summary: `${previous.eligibility ?? "Unclear"} → ${current.eligibility}` });
    }
  }
  return {
    changed: changes.length > 0,
    change_types: changes.map((change) => change.type),
    summary: changes.map((change) => `${change.type}: ${change.summary}`).join(" | ") || "No material change",
  };
}
