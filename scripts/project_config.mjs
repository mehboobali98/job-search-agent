import fs from "node:fs/promises";
import path from "node:path";

export const LOCAL_CONFIG_NAME = ".job-search.local.json";

export function argumentValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function resolveProjectPath(projectRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function validateProjectConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Local configuration must be a JSON object");
  for (const field of [
    "candidate_name", "timezone", "target_geography", "tracker_path",
    "candidate_profile_path", "resumes_directory", "state_directory",
  ]) {
    if (!String(raw[field] ?? "").trim()) throw new Error("Missing local configuration field: " + field);
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw.timezone }).format(new Date());
  } catch {
    throw new Error("Invalid IANA timezone in local configuration: " + raw.timezone);
  }
  return raw;
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
    resumesDirectory: resolveProjectPath(absoluteRoot, raw.resumes_directory),
    stateDirectory: resolveProjectPath(absoluteRoot, raw.state_directory),
  };
}
