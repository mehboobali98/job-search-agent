import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbookPath = process.argv[2];
const renderDir = process.argv[3];
if (!workbookPath || !renderDir) throw new Error("Usage: node scripts/inspect_workbook.mjs <xlsx> <render-dir>");

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const summary = await workbook.inspect({ kind: "workbook,sheet,table,drawing", maxChars: 15000, tableMaxRows: 5, tableMaxCols: 10, tableMaxCellChars: 100 });
console.log(summary.ndjson);

for (const [sheetName, range] of [["Dashboard", "A1:H35"], ["Search Config", "A1:F30"], ["Leads", "A1:AK14"], ["Applications", "A1:AC12"], ["Scan Log", "A1:X12"], ["Run Log", "A1:R10"]]) {
  const check = await workbook.inspect({ kind: "region", sheetId: sheetName, range, maxChars: 5000, tableMaxRows: 12, tableMaxCols: 12, tableMaxCellChars: 100 });
  console.log(check.ndjson);
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

await fs.mkdir(renderDir, { recursive: true });
for (const sheet of workbook.worksheets.items) {
  const rendered = await workbook.render({ sheetName: sheet.name, autoCrop: "all", scale: 1, format: "png" });
  const safeName = sheet.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
  await fs.writeFile(path.join(renderDir, safeName + ".png"), new Uint8Array(await rendered.arrayBuffer()));
}
