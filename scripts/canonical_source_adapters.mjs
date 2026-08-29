import { normalizeUrl } from "./job_tracker_lib.mjs";

export const CANONICAL_SOURCE_ADAPTERS = Object.freeze([
  Object.freeze({ id: "ashby", name: "Ashby", hosts: Object.freeze(["jobs.ashbyhq.com"]) }),
  Object.freeze({
    id: "greenhouse",
    name: "Greenhouse",
    hosts: Object.freeze(["job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io"]),
  }),
  Object.freeze({ id: "workable", name: "Workable", hosts: Object.freeze(["apply.workable.com"]) }),
  Object.freeze({ id: "lever", name: "Lever", hosts: Object.freeze(["jobs.lever.co"]) }),
  Object.freeze({ id: "smartrecruiters", name: "SmartRecruiters", hosts: Object.freeze(["jobs.smartrecruiters.com"]) }),
]);

export function canonicalAtsSites() {
  return [...new Set(CANONICAL_SOURCE_ADAPTERS.flatMap((adapter) => adapter.hosts))];
}

export function canonicalSourceAdapterPlan() {
  return CANONICAL_SOURCE_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    hosts: [...adapter.hosts],
    access: "public_read_only",
    rules: [
      "Open only publicly accessible vacancy pages.",
      "Never use private APIs, authenticated sessions, access-control bypasses, or application submission endpoints.",
      "Treat listing activity and eligibility as evidence-backed observations, never as URL-derived facts.",
    ],
  }));
}

function pathSegments(url) {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function inferredJobId(adapterId, url) {
  const segments = pathSegments(url);
  if (adapterId === "greenhouse") {
    const jobsIndex = segments.findIndex((segment) => segment.toLowerCase() === "jobs");
    return jobsIndex >= 0 ? segments[jobsIndex + 1] ?? null : null;
  }
  if (adapterId === "workable") {
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "j");
    return jobIndex >= 0 ? segments[jobIndex + 1] ?? null : null;
  }
  if (["ashby", "lever"].includes(adapterId)) return segments.length >= 2 ? segments.at(-1) : null;
  if (adapterId === "smartrecruiters") return segments.length >= 2 ? segments.at(-1) : null;
  return null;
}

export function identifyCanonicalSource(value) {
  const canonicalUrl = normalizeUrl(value);
  let url;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return {
      recognized: false,
      adapter_id: null,
      adapter_name: null,
      canonical_url: canonicalUrl,
      inferred_job_id: null,
    };
  }
  const host = url.hostname.toLowerCase();
  const adapter = CANONICAL_SOURCE_ADAPTERS.find((entry) => entry.hosts.includes(host));
  if (!adapter) {
    return {
      recognized: false,
      adapter_id: null,
      adapter_name: null,
      canonical_url: canonicalUrl,
      inferred_job_id: null,
    };
  }
  return {
    recognized: true,
    adapter_id: adapter.id,
    adapter_name: adapter.name,
    canonical_url: canonicalUrl,
    inferred_job_id: inferredJobId(adapter.id, url),
  };
}
