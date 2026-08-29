import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { buildOutcomeCalibration } from "./application_outcomes_lib.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";
import { resolveXlsxWorkbookPath } from "./workbook_io.mjs";

const config = process.argv.includes("--workbook") ? null : await loadProjectConfig();
const workbookPath = resolveXlsxWorkbookPath(argumentValue(process.argv, "--workbook", config?.trackerPath), "--workbook");
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const sheet = workbook.worksheets.items.find((item) => item.name === "Application Outcomes");
const rows = sheet?.tables.items.find((item) => item.name === "ApplicationOutcomesTable")?.getDataRows() ?? [];
const calibration = buildOutcomeCalibration(rows.map((row) => ({
  lead_id: row[1], outcome: row[5], final_score: row[10], resume_version: row[11],
})));
console.log(JSON.stringify(calibration, null, 2));
