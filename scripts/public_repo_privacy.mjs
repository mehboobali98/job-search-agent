export const BLOCKED_PUBLIC_PATHS = Object.freeze([
  /^\.job-search\.local\.json$/,
  /^Job_Application_Tracker\.xlsx$/i,
  /^profile\/candidate-profile\.md$/,
  /^profile\/search-terms\.json$/,
  /^profile\/eligibility-evidence\.json$/,
  /^profile\/resumes\//,
  /^state\//,
  /^application-packages\//,
  /^(?:gmail|job-alert|email)-imports\//i,
  /^(?:historical|tracker)-imports\//i,
  /^(?:notification|digest)-exports\//i,
  /^(?:notification-health|delivery-health)-exports\//i,
  /^(?:notification-status|provider-status)-exports\//i,
  /^(?:notification-connector|connector-profile)s?\//i,
  /^(?:notification-status-connector|status-connector-profile)s?\//i,
  /^(?:notification-connector-discovery|connector-capability-export|connector-discovery)s?\//i,
  /^(?:notification-connector-drift|connector-drift|notification-drift)-exports?\//i,
  /^(?:notification-connector-history|connector-catalog-history|connector-history)-exports?\//i,
  /^renders?\//,
  /\.inspect\.ndjson$/i,
  /\.(?:xlsx|xls|pdf|docx|eml|mbox|pst|zip|tar|tgz|gz)$/i,
]);

const RESERVED_TEST_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.test", "invalid"]);

function isReservedTestDomain(domain) {
  return [...RESERVED_TEST_DOMAINS].some((reserved) => domain === reserved || domain.endsWith("." + reserved));
}

export function isBlockedPublicPath(name) {
  return BLOCKED_PUBLIC_PATHS.some((pattern) => pattern.test(String(name ?? "")));
}

export function publicContentViolations(content, { fileName = "" } = {}) {
  const text = String(content ?? "");
  const violations = [];
  if (!String(fileName).startsWith("fixtures/")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.transport?.access_mode === "read_only" && Array.isArray(parsed?.messages)
        && parsed.messages.some((message) => message && ("text_body" in message || "html_body" in message || "from" in message))) {
        violations.push("private job-alert message batch");
      }
    } catch {
      // Non-JSON source files are checked by the remaining content rules.
    }
    try {
      const parsed = JSON.parse(text);
      if (/^NREQ-[A-F0-9]{24}$/.test(String(parsed?.request_id ?? "")) && parsed?.destination && Array.isArray(parsed?.items)) {
        violations.push("private notification delivery request");
      }
    } catch {
      // Non-JSON source files are checked by the remaining content rules.
    }
    try {
      const parsed = JSON.parse(text);
      if ([1, 2].includes(parsed?.schema_version) && parsed?.transport === "https_json_bearer"
        && typeof parsed?.endpoint === "string" && parsed?.authentication?.type === "bearer_env") {
        violations.push("private notification connector profile");
      }
      if (/^NCBIND-[A-F0-9]{24}$/.test(String(parsed?.binding_id ?? "")) && parsed?.profile_sha256) {
        violations.push("private notification connector binding");
      }
      if (/^NCREC-[A-F0-9]{24}$/.test(String(parsed?.receipt_id ?? "")) && parsed?.request_sha256) {
        violations.push("private notification connector receipt");
      }
      if (/^NCAPEXP-[A-F0-9]{24}$/.test(String(parsed?.export_id ?? ""))
        && typeof parsed?.account_ref === "string" && Array.isArray(parsed?.targets)) {
        violations.push("private notification connector capability export");
      }
      if (/^NCAPCAT-[A-F0-9]{24}$/.test(String(parsed?.catalog_id ?? ""))
        && parsed?.source_sha256 && Array.isArray(parsed?.targets)) {
        violations.push("private notification connector capability catalog");
      }
      if (/^NCAPDRIFT-[A-F0-9]{24}$/.test(String(parsed?.report_id ?? ""))
        && /^NCAPCAT-[A-F0-9]{24}$/.test(String(parsed?.catalog_id ?? ""))
        && /^NCBIND-[A-F0-9]{24}$/.test(String(parsed?.binding_id ?? ""))
        && Array.isArray(parsed?.binding_destinations) && Array.isArray(parsed?.catalog_targets)) {
        violations.push("private notification connector drift report");
      }
      if (/^NCAPHIST-[A-F0-9]{24}$/.test(String(parsed?.report_id ?? ""))
        && /^NCAPCAT-[A-F0-9]{24}$/.test(String(parsed?.before_catalog_id ?? ""))
        && /^NCAPCAT-[A-F0-9]{24}$/.test(String(parsed?.after_catalog_id ?? ""))
        && Array.isArray(parsed?.target_changes)) {
        violations.push("private notification connector catalog history report");
      }
      if (parsed?.schema_version === 1 && parsed?.transport === "https_json_bearer_status"
        && typeof parsed?.endpoint === "string" && parsed?.authentication?.type === "bearer_env") {
        violations.push("private notification status profile");
      }
      if (/^NSTATBIND-[A-F0-9]{24}$/.test(String(parsed?.binding_id ?? "")) && parsed?.profile_sha256) {
        violations.push("private notification status binding");
      }
      if (/^NSTATOBS-[A-F0-9]{24}$/.test(String(parsed?.observation_id ?? "")) && parsed?.request_sha256) {
        violations.push("private notification status observation");
      }
      if (/^NHEALTH-[A-F0-9]{24}$/.test(String(parsed?.report_id ?? ""))
        && parsed?.counts && Array.isArray(parsed?.requests) && Array.isArray(parsed?.artifact_issues)) {
        violations.push("private notification delivery health report");
      }
    } catch {
      // Non-JSON source files are checked by the remaining content rules.
    }
  }
  if (/\/(?:Users|home)\/[^/\s]+\//.test(text)) violations.push("absolute home-directory path");
  const emails = [...text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)];
  for (const match of emails) {
    if (!isReservedTestDomain(match[1].toLowerCase())) {
      violations.push("email address");
      break;
    }
  }
  if (/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i.test(text)) violations.push("possible secret");
  if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) violations.push("private key");
  return violations;
}
