import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { ROLE_FAMILIES } from "./search_query_lib.mjs";
import { validateApplicableRecommendation } from "./query_budget_lib.mjs";
import { readSearchBudget } from "./search_budget_workbook.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

async function main() {
  const explicitWorkbook = argumentValue(process.argv, "--workbook");
  const recommendationArgument = argumentValue(process.argv, "--recommendation");
  const approvalId = argumentValue(process.argv, "--approve");
  if (!recommendationArgument || !approvalId) throw new Error("Usage: node scripts/apply_query_budget.mjs --recommendation <json> --approve <recommendation_id> [--workbook <xlsx>]");
  const config = explicitWorkbook ? null : await loadProjectConfig();
  const workbookPath = resolveXlsxWorkbookPath(explicitWorkbook ?? config.trackerPath, "--workbook");
  const stateDirectory = path.resolve(argumentValue(process.argv, "--state-dir", config?.stateDirectory ?? path.join(path.dirname(workbookPath), "state")));
  const recommendationPath = path.resolve(recommendationArgument);
  const packet = JSON.parse(await fs.readFile(recommendationPath, "utf8"));
  const temporaryPath = workbookTemporaryPath(workbookPath, "query-budget-tmp");
  const pendingPath = path.join(stateDirectory, "pending-query-budget-" + approvalId.replace(/[^a-z0-9_-]/gi, "_") + ".json");
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const before = readSearchBudget(workbook);
  const proposed = validateApplicableRecommendation(packet, approvalId, before.role_query_budget);
  const totalQueries = Object.values(proposed).reduce((sum, value) => sum + value, 0);
  await fs.mkdir(stateDirectory, { recursive: true });
  try {
    const weights = ROLE_FAMILIES.map((role) => proposed[role] / totalQueries);
    workbook.worksheets.getItem("Search Config").getRange("E5:E9").values = weights.map((weight) => [weight]);
    await (await SpreadsheetFile.exportXlsx(workbook)).save(temporaryPath);
    const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(temporaryPath));
    const after = readSearchBudget(verified);
    if (JSON.stringify(after.role_query_budget) !== JSON.stringify(proposed)) throw new Error("Query-budget verification failed before workbook commit");
    await fs.rename(temporaryPath, workbookPath);
    await removeWorkbookInspection(temporaryPath).catch(() => {});
    await fs.rm(pendingPath, { force: true }).catch(() => {});
    console.log(JSON.stringify({
      applied: true,
      recommendation_id: packet.recommendation_id,
      role_query_budget: after.role_query_budget,
      total_queries: totalQueries,
      external_actions_taken: false,
    }, null, 2));
  } catch (error) {
    await removeTemporaryWorkbook(temporaryPath, workbookPath).catch(() => {});
    await fs.writeFile(pendingPath, JSON.stringify({ recommendation_path: recommendationPath, approval_id: approvalId, error: String(error?.stack ?? error), created_at: new Date().toISOString() }, null, 2) + "\n");
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
