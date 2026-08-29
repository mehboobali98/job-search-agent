import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { refreshActionDashboard } from "./action_dashboard_sheet.mjs";
import { applyDashboardFormulas, synchronizeTrackerLabels } from "./dashboard_formulas.mjs";
import { loadProjectConfig } from "./project_config.mjs";
import { removeTemporaryWorkbook, removeWorkbookInspection, resolveXlsxWorkbookPath, workbookTemporaryPath } from "./workbook_io.mjs";

const config = process.argv[2] ? null : await loadProjectConfig();
const workbookPath = resolveXlsxWorkbookPath(process.argv[2] ?? config.trackerPath, "Workbook path");
const stateDir = path.resolve(config?.stateDirectory ?? path.join(path.dirname(workbookPath), "state"));
const temporaryPath = workbookTemporaryPath(workbookPath, "dashboard-tmp");
const pendingPath = path.join(stateDir, "pending-dashboard-refresh.json");
await fs.mkdir(stateDir, { recursive: true });

try {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const dashboard = workbook.worksheets.getItem("Dashboard");
  const configSheet = workbook.worksheets.getItem("Search Config");
  applyDashboardFormulas(dashboard);
  synchronizeTrackerLabels(configSheet);
  refreshActionDashboard(workbook);

  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "dashboard refresh formula scan",
  });
  if (/#[A-Z0-9/]+[!?]/.test(errors.ndjson)) throw new Error("Dashboard refresh formula validation failed: " + errors.ndjson);
  await (await SpreadsheetFile.exportXlsx(workbook)).save(temporaryPath);
  const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(temporaryPath));
  if (!verified.worksheets.getItem("Dashboard").getRange("C5:D6").formulas[0][0]) {
    throw new Error("Dashboard verification failed before workbook commit");
  }
  await fs.rename(temporaryPath, workbookPath);
  try { await removeWorkbookInspection(temporaryPath); } catch { /* Workbook commit already succeeded. */ }
  try { await fs.rm(pendingPath, { force: true }); } catch { /* Workbook commit already succeeded. */ }
} catch (error) {
  try { await removeTemporaryWorkbook(temporaryPath, workbookPath); } catch { /* Preserve the original workbook. */ }
  await fs.writeFile(pendingPath, JSON.stringify({
    workbook: workbookPath,
    error: String(error?.stack ?? error),
    created_at: new Date().toISOString(),
  }, null, 2) + "\n");
  throw error;
}
