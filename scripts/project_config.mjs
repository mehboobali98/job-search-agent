import fs from "node:fs/promises";
import path from "node:path";

export const LOCAL_CONFIG_NAME = ".job-search.local.json";
export const CURRENT_CONFIG_VERSION = 6;
export const DEFAULT_RELIABILITY = Object.freeze({
  require_preflight: true,
  pending_retention_days: 30,
  query_recommendation_window: 20,
  query_recommendation_min_attempts: 5,
});
export const DEFAULT_GMAIL_JOB_ALERTS = Object.freeze({
  enabled: false,
  read_only: true,
  query: "newer_than:7d",
  freshness_hours: 168,
  max_messages: 50,
  max_links_per_message: 20,
  sender_allowlist: Object.freeze([]),
});
export const NOTIFICATION_CHANNELS = Object.freeze(["local", "email", "slack", "webhook", "custom"]);
export const NOTIFICATION_ADAPTERS = Object.freeze(["private_file", "connector"]);
export const DEFAULT_NOTIFICATIONS = Object.freeze({
  enabled: false,
  max_items_per_digest: 10,
  quiet_hours: Object.freeze({ enabled: true, start: "22:00", end: "08:00" }),
  destinations: Object.freeze([]),
});

const GMAIL_CONFIG_FIELDS = new Set([
  "enabled", "read_only", "query", "freshness_hours", "max_messages", "max_links_per_message", "sender_allowlist",
]);
const NOTIFICATION_CONFIG_FIELDS = new Set(["enabled", "max_items_per_digest", "quiet_hours", "destinations"]);
const QUIET_HOURS_FIELDS = new Set(["enabled", "start", "end"]);
const DESTINATION_FIELDS = new Set([
  "id", "enabled", "adapter", "channel", "connection_ref", "minimum_score", "max_items", "include_resume",
]);
const CHANNELS = new Set(NOTIFICATION_CHANNELS);
const ADAPTERS = new Set(NOTIFICATION_ADAPTERS);

export function validateGmailJobAlertsConfig(value, { requireAllowlistWhenEnabled = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmail_job_alerts must be an object");
  }
  for (const field of Object.keys(value)) {
    if (!GMAIL_CONFIG_FIELDS.has(field)) throw new Error("Unsupported gmail_job_alerts field: " + field);
  }
  if (typeof value.enabled !== "boolean") throw new Error("gmail_job_alerts.enabled must be a boolean");
  if (value.read_only !== true) throw new Error("gmail_job_alerts.read_only must be true");
  const query = String(value.query ?? "").trim();
  if (!query || query.length > 512) throw new Error("gmail_job_alerts.query must contain 1-512 characters");
  if (/[\r\n]/.test(query)) throw new Error("gmail_job_alerts.query must be a single line");
  for (const [field, maximum] of [["freshness_hours", 720], ["max_messages", 100], ["max_links_per_message", 50]]) {
    if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > maximum) {
      throw new Error(`gmail_job_alerts.${field} must be an integer from 1 to ${maximum}`);
    }
  }
  if (!Array.isArray(value.sender_allowlist) || value.sender_allowlist.length > 100) {
    throw new Error("gmail_job_alerts.sender_allowlist must be an array with at most 100 entries");
  }
  const normalized = value.sender_allowlist.map((entry, index) => {
    const text = String(entry ?? "").trim().toLowerCase().replace(/^@/, "");
    if (!text || text.length > 254 || /\s/.test(text)) {
      throw new Error(`gmail_job_alerts.sender_allowlist[${index}] is invalid`);
    }
    const isAddress = text.includes("@");
    const domain = isAddress ? text.slice(text.lastIndexOf("@") + 1) : text;
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes(".")) {
      throw new Error(`gmail_job_alerts.sender_allowlist[${index}] must be an exact email address or domain`);
    }
    if (isAddress && !/^[^@\s]+@[^@\s]+$/.test(text)) {
      throw new Error(`gmail_job_alerts.sender_allowlist[${index}] must be an exact email address or domain`);
    }
    return text;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("gmail_job_alerts.sender_allowlist contains duplicates");
  if (requireAllowlistWhenEnabled && value.enabled && normalized.length === 0) {
    throw new Error("gmail_job_alerts.sender_allowlist must be non-empty when ingestion is enabled");
  }
  return { ...value, query, sender_allowlist: normalized };
}

function timeOfDay(value, label) {
  const text = String(value ?? "").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`${label} must use 24-hour HH:mm format`);
  return text;
}

function validateDestination(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`notifications.destinations[${index}] must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!DESTINATION_FIELDS.has(field)) throw new Error(`Unsupported notifications.destinations[${index}] field: ${field}`);
  }
  const id = String(value.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`notifications.destinations[${index}].id must be a lowercase opaque slug`);
  }
  if (typeof value.enabled !== "boolean") throw new Error(`notifications.destinations[${index}].enabled must be a boolean`);
  if (!ADAPTERS.has(value.adapter)) throw new Error(`notifications.destinations[${index}].adapter is unsupported`);
  if (!CHANNELS.has(value.channel)) throw new Error(`notifications.destinations[${index}].channel is unsupported`);
  if (value.adapter === "private_file" && value.channel !== "local") {
    throw new Error(`notifications.destinations[${index}] private_file adapter requires the local channel`);
  }
  let connectionRef = null;
  if (value.adapter === "connector") {
    connectionRef = String(value.connection_ref ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(connectionRef) || /(?:secret|token|password|api[_-]?key)/i.test(connectionRef)) {
      throw new Error(`notifications.destinations[${index}].connection_ref must be a non-secret opaque reference`);
    }
    if (value.channel === "local") throw new Error(`notifications.destinations[${index}] connector adapter requires a non-local channel`);
  } else if (value.connection_ref !== undefined && value.connection_ref !== null) {
    throw new Error(`notifications.destinations[${index}].connection_ref is only allowed for connector adapters`);
  }
  if (!Number.isInteger(value.minimum_score) || value.minimum_score < 0 || value.minimum_score > 100) {
    throw new Error(`notifications.destinations[${index}].minimum_score must be an integer from 0 to 100`);
  }
  if (!Number.isInteger(value.max_items) || value.max_items < 1 || value.max_items > 20) {
    throw new Error(`notifications.destinations[${index}].max_items must be an integer from 1 to 20`);
  }
  if (typeof value.include_resume !== "boolean") {
    throw new Error(`notifications.destinations[${index}].include_resume must be a boolean`);
  }
  return { ...value, id, connection_ref: connectionRef };
}

export function validateNotificationsConfig(value, { requireDestinationWhenEnabled = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("notifications must be an object");
  for (const field of Object.keys(value)) {
    if (!NOTIFICATION_CONFIG_FIELDS.has(field)) throw new Error("Unsupported notifications field: " + field);
  }
  if (typeof value.enabled !== "boolean") throw new Error("notifications.enabled must be a boolean");
  if (!Number.isInteger(value.max_items_per_digest) || value.max_items_per_digest < 1 || value.max_items_per_digest > 20) {
    throw new Error("notifications.max_items_per_digest must be an integer from 1 to 20");
  }
  const quiet = value.quiet_hours;
  if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) throw new Error("notifications.quiet_hours must be an object");
  for (const field of Object.keys(quiet)) {
    if (!QUIET_HOURS_FIELDS.has(field)) throw new Error("Unsupported notifications.quiet_hours field: " + field);
  }
  if (typeof quiet.enabled !== "boolean") throw new Error("notifications.quiet_hours.enabled must be a boolean");
  const start = timeOfDay(quiet.start, "notifications.quiet_hours.start");
  const end = timeOfDay(quiet.end, "notifications.quiet_hours.end");
  if (start === end) throw new Error("notifications.quiet_hours start and end must differ");
  if (!Array.isArray(value.destinations) || value.destinations.length > 10) {
    throw new Error("notifications.destinations must be an array with at most 10 entries");
  }
  const destinations = value.destinations.map(validateDestination);
  if (new Set(destinations.map((destination) => destination.id)).size !== destinations.length) {
    throw new Error("notifications.destinations contains duplicate IDs");
  }
  if (requireDestinationWhenEnabled && value.enabled && !destinations.some((destination) => destination.enabled)) {
    throw new Error("notifications.destinations must contain an enabled destination when notifications are enabled");
  }
  return { ...value, quiet_hours: { ...quiet, start, end }, destinations };
}

export function argumentValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(name + " requires a value");
  }
  return value;
}

export function resolveProjectPath(projectRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function validateProjectConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Local configuration must be a JSON object");
  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > CURRENT_CONFIG_VERSION) {
    throw new Error("Unsupported local configuration version: " + raw.version);
  }
  for (const field of [
    "candidate_name", "timezone", "target_geography", "tracker_path",
    "candidate_profile_path", "resumes_directory", "state_directory",
  ]) {
    if (!String(raw[field] ?? "").trim()) throw new Error("Missing local configuration field: " + field);
  }
  if (raw.application_packages_directory !== undefined && !String(raw.application_packages_directory).trim()) {
    throw new Error("application_packages_directory must be non-empty when provided");
  }
  if (raw.search_terms_path !== undefined && !String(raw.search_terms_path).trim()) {
    throw new Error("search_terms_path must be non-empty when provided");
  }
  if (raw.eligibility_evidence_path !== undefined && !String(raw.eligibility_evidence_path).trim()) {
    throw new Error("eligibility_evidence_path must be non-empty when provided");
  }
  if (raw.version >= 4) {
    const reliability = raw.reliability;
    if (!reliability || typeof reliability !== "object" || Array.isArray(reliability)) {
      throw new Error("Version 4 local configuration requires a reliability object");
    }
    if (typeof reliability.require_preflight !== "boolean") {
      throw new Error("reliability.require_preflight must be a boolean");
    }
    for (const field of ["pending_retention_days", "query_recommendation_window", "query_recommendation_min_attempts"]) {
      if (!Number.isInteger(reliability[field]) || reliability[field] < 1) {
        throw new Error("reliability." + field + " must be a positive integer");
      }
    }
  }
  if (raw.version >= 5) validateGmailJobAlertsConfig(raw.gmail_job_alerts);
  if (raw.version >= 6) validateNotificationsConfig(raw.notifications);
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw.timezone }).format(new Date());
  } catch {
    throw new Error("Invalid IANA timezone in local configuration: " + raw.timezone);
  }
  return raw;
}

export function upgradeProjectConfig(raw) {
  validateProjectConfig(raw);
  const fromVersion = raw.version;
  const config = JSON.parse(JSON.stringify(raw));
  const changes = [];
  const addDefault = (field, value, version) => {
    if (config[field] === undefined) {
      config[field] = value;
      changes.push({ version, field, value });
    }
  };

  if (config.version < 2) {
    addDefault("search_terms_path", "profile/search-terms.json", 2);
    addDefault("application_packages_directory", "application-packages", 2);
    config.version = 2;
  }
  if (config.version < 3) {
    addDefault("eligibility_evidence_path", "profile/eligibility-evidence.json", 3);
    config.version = 3;
  }
  if (config.version < 4) {
    config.reliability = { ...DEFAULT_RELIABILITY };
    changes.push({ version: 4, field: "reliability", value: { ...DEFAULT_RELIABILITY } });
    config.version = 4;
  }
  if (config.version < 5) {
    config.gmail_job_alerts = { ...DEFAULT_GMAIL_JOB_ALERTS, sender_allowlist: [] };
    changes.push({ version: 5, field: "gmail_job_alerts", value: config.gmail_job_alerts });
    config.version = 5;
  }
  if (config.version < 6) {
    config.notifications = {
      ...DEFAULT_NOTIFICATIONS,
      quiet_hours: { ...DEFAULT_NOTIFICATIONS.quiet_hours },
      destinations: [],
    };
    changes.push({ version: 6, field: "notifications", value: config.notifications });
    config.version = 6;
  }

  validateProjectConfig(config);
  return {
    config,
    from_version: fromVersion,
    to_version: config.version,
    changed: fromVersion !== config.version || changes.length > 0,
    changes,
  };
}

export async function loadProjectConfig({ projectRoot = process.cwd(), configPath = LOCAL_CONFIG_NAME } = {}) {
  const absoluteRoot = path.resolve(projectRoot);
  const absoluteConfigPath = resolveProjectPath(absoluteRoot, configPath);
  let raw;
  try {
    raw = validateProjectConfig(JSON.parse(await fs.readFile(absoluteConfigPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing " + absoluteConfigPath + ". Run `npm run setup -- --name \"Candidate Name\" --timezone \"Etc/UTC\" --geography \"Worldwide remote\"` first.");
    }
    throw error;
  }
  return {
    projectRoot: absoluteRoot,
    configPath: absoluteConfigPath,
    raw,
    trackerPath: resolveProjectPath(absoluteRoot, raw.tracker_path),
    candidateProfilePath: resolveProjectPath(absoluteRoot, raw.candidate_profile_path),
    searchTermsPath: resolveProjectPath(absoluteRoot, raw.search_terms_path ?? "profile/search-terms.json"),
    eligibilityEvidencePath: resolveProjectPath(absoluteRoot, raw.eligibility_evidence_path ?? "profile/eligibility-evidence.json"),
    resumesDirectory: resolveProjectPath(absoluteRoot, raw.resumes_directory),
    stateDirectory: resolveProjectPath(absoluteRoot, raw.state_directory),
    applicationPackagesDirectory: resolveProjectPath(absoluteRoot, raw.application_packages_directory ?? "application-packages"),
    reliability: { ...DEFAULT_RELIABILITY, ...(raw.reliability ?? {}) },
    gmailJobAlerts: validateGmailJobAlertsConfig({
      ...DEFAULT_GMAIL_JOB_ALERTS,
      ...(raw.gmail_job_alerts ?? {}),
      sender_allowlist: [...(raw.gmail_job_alerts?.sender_allowlist ?? DEFAULT_GMAIL_JOB_ALERTS.sender_allowlist)],
    }),
    notifications: validateNotificationsConfig({
      ...DEFAULT_NOTIFICATIONS,
      ...(raw.notifications ?? {}),
      quiet_hours: { ...DEFAULT_NOTIFICATIONS.quiet_hours, ...(raw.notifications?.quiet_hours ?? {}) },
      destinations: [...(raw.notifications?.destinations ?? DEFAULT_NOTIFICATIONS.destinations)],
    }),
  };
}
