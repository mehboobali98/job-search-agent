import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { queryMetricRecordsFromArchive, recommendQueryBudget } from "./query_budget_lib.mjs";
import { readSearchBudget } from "./search_budget_workbook.mjs";
import { removeWorkbookInspection, resolveXlsxWorkbookPath } from "./workbook_io.mjs";

async function archivedRuns(runsDirectory, window) {
  let entries;
  try { entries = await fs.readdir(runsDirectory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const resultFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".result.json"));
  const ranked = await Promise.all(resultFiles.map(async (entry) => ({ entry, stat: await fs.stat(path.join(runsDirectory, entry.name)) })));
  ranked.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.entry.name.localeCompare(b.entry.name));
  return Promise.all(ranked.slice(0, window).map(async ({ entry }) => {
    const stem = entry.name.slice(0, -".result.json".length);
    const [input, result] = await Promise.all([
      fs.readFile(path.join(runsDirectory, stem + ".input.json"), "utf8").then(JSON.parse).catch(() => null),
      fs.readFile(path.join(runsDirectory, entry.name), "utf8").then(JSON.parse),
    ]);
    return { input, result };
  }));
}

async function main() {
  const explicitWorkbook = argumentValue(process.argv, "--workbook");
  const config = explicitWorkbook ? null : await loadProjectConfig();
  const workbookPath = resolveXlsxWorkbookPath(explicitWorkbook ?? config.trackerPath, "--workbook");
  const stateDirectory = path.resolve(argumentValue(process.argv, "--state-dir", config?.stateDirectory ?? path.join(path.dirname(workbookPath), "state")));
  const window = Number(argumentValue(process.argv, "--window", config?.reliability.query_recommendation_window ?? 20));
  const minimumAttempts = Number(argumentValue(process.argv, "--minimum-attempts", config?.reliability.query_recommendation_min_attempts ?? 5));
  if (!Number.isInteger(window) || window < 1) throw new Error("--window must be a positive integer");
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const budget = readSearchBudget(workbook);
  await removeWorkbookInspection(workbookPath).catch(() => {});
  const runs = await archivedRuns(path.join(stateDirectory, "runs"), window);
  const records = [];
  let unattributed = 0;
  for (const run of runs) {
    const extracted = queryMetricRecordsFromArchive(run.input, run.result);
    records.push(...extracted.records);
    unattributed += extracted.unattributed;
  }
  const recommendation = recommendQueryBudget({ records, currentBudget: budget.role_query_budget, minimumAttempts });
  console.log(JSON.stringify({
    ...recommendation,
    generated_at: new Date().toISOString(),
    archive_runs_considered: runs.length,
    attributed_query_metrics: records.length,
    unattributed_query_metrics: unattributed,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
