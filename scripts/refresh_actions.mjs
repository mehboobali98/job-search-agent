import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const config = process.argv.includes("--workbook") ? null : await loadProjectConfig();
const workbookPath = resolveXlsxWorkbookPath(argumentValue(process.argv, "--workbook", config?.trackerPath), "--workbook");
const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", config?.stateDirectory ?? path.join(path.dirname(workbookPath), "state")));
const asOfValue = argumentValue(process.argv, "--as-of", new Date().toISOString());
const asOf = new Date(asOfValue);
if (!Number.isFinite(asOf.getTime())) throw new Error("--as-of must be a valid date or timestamp");
const tempPath = workbookTemporaryPath(workbookPath, "actions-tmp");
const pendingPath = path.join(stateDir, "pending-action-dashboard.json");
await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const result = refreshActionDashboard(workbook, { asOf });
  await (await SpreadsheetFile.exportXlsx(workbook)).save(tempPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(tempPath));
  if (!verified.worksheets.getItem("Action Dashboard").tables.getItem("ActionDashboardTable")) throw new Error("Action Dashboard verification failed");
  await fs.rename(tempPath, workbookPath);
  try { await removeWorkbookInspection(tempPath); } catch { /* Workbook commit already succeeded. */ }
  await fs.rm(pendingPath, { force: true });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try { await removeTemporaryWorkbook(tempPath, workbookPath); } catch { /* Preserve the original workbook. */ }
  await fs.writeFile(pendingPath, JSON.stringify({ workbook: workbookPath, error: String(error?.stack ?? error), created_at: new Date().toISOString() }, null, 2) + "\n");
  throw error;
}
