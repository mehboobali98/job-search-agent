import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { allocateLargestRemainder } from "./job_tracker_lib.mjs";
import { argumentValue, loadProjectConfig, resolveProjectPath } from "./project_config.mjs";
import { buildSearchPlan } from "./search_query_lib.mjs";

const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
const config = await loadProjectConfig({
  projectRoot,
  configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
});
const workbookPath = path.resolve(argumentValue(process.argv, "--workbook", config.trackerPath));
const searchTermsPath = resolveProjectPath(projectRoot, argumentValue(
  process.argv,
  "--search-terms",
  config.raw.search_terms_path ?? "profile/search-terms.json",
));
const runDateArgument = argumentValue(process.argv, "--run-date");
const runDate = runDateArgument ? new Date(runDateArgument) : new Date();
if (!Number.isFinite(runDate.getTime())) throw new Error("--run-date must be a valid ISO-8601 date or timestamp");
const runWeekday = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: config.timezone,
}).format(runDate);

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const sheet = workbook.worksheets.getItem("Search Config");
const limits = Object.fromEntries(sheet.getRange("A5:B13").values.map(([key, value]) => [String(key), value]));
const allocations = Object.fromEntries(sheet.getRange("D5:E9").values.map(([key, value]) => [String(key), value]));
const roleQueryBudget = allocateLargestRemainder(Number(limits["Maximum searches"]), allocations);
const rawTerms = JSON.parse(await fs.readFile(searchTermsPath, "utf8"));
const plan = buildSearchPlan({
  rawTerms,
  roleQueryBudget,
  targetGeography: config.raw.target_geography,
  runWeekday,
});

console.log(JSON.stringify({
  generated_at: runDate.toISOString(),
  timezone: config.timezone,
  search_terms_path: path.relative(projectRoot, searchTermsPath),
  ...plan,
}, null, 2));
