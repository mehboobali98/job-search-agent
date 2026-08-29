import fs from "node:fs/promises";
import path from "node:path";

export const LOCAL_CONFIG_NAME = ".job-search.local.json";
export const CURRENT_CONFIG_VERSION = 4;
export const DEFAULT_RELIABILITY = Object.freeze({
  require_preflight: true,
  pending_retention_days: 30,
  query_recommendation_window: 20,
  query_recommendation_min_attempts: 5,
});

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
  };
}
