import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { loadProjectConfig } from "./project_config.mjs";

const config = process.argv[2] ? null : await loadProjectConfig();
const workbookPath = process.argv[2] ?? config.trackerPath;
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const dashboard = workbook.worksheets.getItem("Dashboard");

dashboard.getRange("C5:D6").formulas = [[
  "=COUNTIFS('Leads'!$W$4:$W$203,\">=\"&'Search Config'!$B$11,'Leads'!$AF$4:$AF$203,\"Judged\",'Leads'!$L$4:$L$203,\"Eligible\",'Leads'!$AA$4:$AA$203,\"<>Dismissed\",'Leads'!$AA$4:$AA$203,\"<>Expired\")+COUNTIFS('Leads'!$W$4:$W$203,\">=\"&'Search Config'!$B$11,'Leads'!$AF$4:$AF$203,\"Judged\",'Leads'!$L$4:$L$203,\"Unclear\",'Leads'!$AA$4:$AA$203,\"<>Dismissed\",'Leads'!$AA$4:$AA$203,\"<>Expired\")",
]];
for (const range of ["A5:B6", "C5:D6", "E5:F6", "G5:H6"]) dashboard.getRange(range).setNumberFormat("0");

for (let row = 10; row <= 14; row += 1) {
  const eligible = "('Leads'!$AF$4:$AF$203=\"Judged\")*('Leads'!$W$4:$W$203>='Search Config'!$B$11)*(('Leads'!$L$4:$L$203=\"Eligible\")+('Leads'!$L$4:$L$203=\"Unclear\"))*('Leads'!$AA$4:$AA$203<>\"Dismissed\")*('Leads'!$AA$4:$AA$203<>\"Expired\")";
  const scoreKeys = "('Leads'!$W$4:$W$203+((204-ROW('Leads'!$W$4:$W$203))/100000))";
  const targetKey = "LARGE(FILTER(" + scoreKeys + "," + eligible + "),$A" + row + ")";
  const position = "MATCH(" + targetKey + "," + scoreKeys + ",0)";
  for (const [column, source] of [["B", "D"], ["C", "E"], ["D", "W"], ["E", "O"], ["F", "L"], ["G", "AA"], ["H", "I"]]) {
    dashboard.getRange(column + row).formulas = [["=IFERROR(INDEX('Leads'!$" + source + "$4:$" + source + "$203," + position + "),\"\")"]];
  }
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "dashboard refresh formula scan",
});
if (/#[A-Z0-9/]+[!?]/.test(errors.ndjson)) throw new Error("Dashboard refresh formula validation failed: " + errors.ndjson);
await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);
