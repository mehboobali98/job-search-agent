import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { allocateLargestRemainder } from "./job_tracker_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
const config = await loadProjectConfig({ projectRoot, configPath: argumentValue(process.argv, "--config", ".job-search.local.json") });
const workbookPath = path.resolve(argumentValue(process.argv, "--workbook", config.trackerPath));
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const sheet = workbook.worksheets.getItem("Search Config");

const limits = Object.fromEntries(sheet.getRange("A5:B13").values.map(([key, value]) => [String(key), value]));
const allocations = Object.fromEntries(sheet.getRange("D5:E9").values.map(([key, value]) => [String(key), value]));
const scoring = Object.fromEntries(sheet.getRange("A15:B21").values.map(([key, value]) => [String(key), value]));
const policies = sheet.getRange("D15:F21").values.map(([policy, rule, effect]) => ({ policy, rule, effect }));
const roleQueryBudget = allocateLargestRemainder(Number(limits["Maximum searches"]), allocations);
const agentQueryBudget = {
  backend_finder: roleQueryBudget["Backend / Platform"] + roleQueryBudget["Staff / Principal / Tech Lead"],
  ai_product_finder: roleQueryBudget["Applied AI / LLM"] + roleQueryBudget["Developer Productivity / AI Enablement"] + roleQueryBudget["Full-stack / Product"],
};

console.log(JSON.stringify({
  candidate: {
    name: config.raw.candidate_name,
    timezone: config.raw.timezone,
    target_geography: config.raw.target_geography,
    tracker_path: config.raw.tracker_path,
    candidate_profile_path: config.raw.candidate_profile_path,
    resumes_directory: config.raw.resumes_directory,
    state_directory: config.raw.state_directory,
  },
  limits,
  allocations,
  role_query_budget: roleQueryBudget,
  agent_query_budget: agentQueryBudget,
  scoring,
  policies,
}, null, 2));
