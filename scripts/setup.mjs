import fs from "node:fs/promises";
import path from "node:path";
import { createTracker } from "./create_tracker.mjs";
import { argumentValue, CURRENT_CONFIG_VERSION, DEFAULT_RELIABILITY, LOCAL_CONFIG_NAME, resolveProjectPath, validateProjectConfig } from "./project_config.mjs";

const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
const candidateName = argumentValue(process.argv, "--name");
const timezone = argumentValue(process.argv, "--timezone", "Etc/UTC");
const targetGeography = argumentValue(process.argv, "--geography", "Worldwide remote and roles offering credible relocation or work-authorization support");
const force = process.argv.includes("--force");
if (!candidateName) throw new Error("Usage: npm run setup -- --name \"Candidate Name\" [--timezone \"Etc/UTC\"] [--geography \"Worldwide remote\"] [--force]");

const config = validateProjectConfig({
  version: CURRENT_CONFIG_VERSION,
  candidate_name: candidateName,
  timezone,
  target_geography: targetGeography,
  tracker_path: "Job_Application_Tracker.xlsx",
  candidate_profile_path: "profile/candidate-profile.md",
  search_terms_path: "profile/search-terms.json",
  eligibility_evidence_path: "profile/eligibility-evidence.json",
  resumes_directory: "profile/resumes",
  state_directory: "state",
  application_packages_directory: "application-packages",
  reliability: { ...DEFAULT_RELIABILITY },
});
const configPath = path.join(projectRoot, LOCAL_CONFIG_NAME);
const trackerPath = resolveProjectPath(projectRoot, config.tracker_path);
const profilePath = resolveProjectPath(projectRoot, config.candidate_profile_path);
const searchTermsPath = resolveProjectPath(projectRoot, config.search_terms_path);
const eligibilityEvidencePath = resolveProjectPath(projectRoot, config.eligibility_evidence_path);
for (const target of [configPath, trackerPath, profilePath, searchTermsPath, eligibilityEvidencePath]) {
  if (!force) {
    try {
      await fs.access(target);
      throw new Error("Refusing to overwrite existing local artifact: " + target + ". Add --force only if replacement is intentional.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
await fs.mkdir(path.dirname(profilePath), { recursive: true });
await fs.mkdir(resolveProjectPath(projectRoot, config.resumes_directory), { recursive: true });
await fs.mkdir(resolveProjectPath(projectRoot, config.state_directory), { recursive: true });
await fs.mkdir(resolveProjectPath(projectRoot, config.application_packages_directory), { recursive: true });
const profileTemplate = await fs.readFile(path.join(projectRoot, "templates/candidate-profile.template.md"), "utf8");
await fs.writeFile(profilePath, profileTemplate
  .replaceAll("{{CANDIDATE_NAME}}", candidateName)
  .replaceAll("{{TARGET_GEOGRAPHY}}", targetGeography));
await fs.copyFile(path.join(projectRoot, "templates/search-terms.template.json"), searchTermsPath);
await fs.copyFile(path.join(projectRoot, "templates/eligibility-evidence.template.json"), eligibilityEvidencePath);
await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
await createTracker({ outputPath: trackerPath, candidateName, timezone, targetGeography });
console.log(JSON.stringify({
  configured: true,
  config: LOCAL_CONFIG_NAME,
  tracker: config.tracker_path,
  candidate_profile: config.candidate_profile_path,
  search_terms: config.search_terms_path,
  eligibility_evidence: config.eligibility_evidence_path,
  resumes_directory: config.resumes_directory,
  application_packages_directory: config.application_packages_directory,
  next: "Complete the candidate profile, add resume files, run npm run install-skill, then run npm run preflight.",
}, null, 2));
