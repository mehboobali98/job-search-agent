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
