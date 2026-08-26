const ALERT_THRESHOLD = "INDEX('Search Config'!$B$5:$B$13,MATCH(\"Alert threshold\",'Search Config'!$A$5:$A$13,0))";

const PRIORITY_ELIGIBLE = [
  '(LeadsTable[Judge Status]="Judged")',
  `(LeadsTable[Final Score]>=${ALERT_THRESHOLD})`,
  '((LeadsTable[Eligibility]="Eligible")+(LeadsTable[Eligibility]="Unclear"))',
  '(LeadsTable[Status]<>"Dismissed")',
  '(LeadsTable[Status]<>"Expired")',
].join("*");

const SCORE_KEYS = "(LeadsTable[Final Score]+((1048577-ROW(LeadsTable[Final Score]))/1000000000))";

export const DASHBOARD_CARD_FORMULAS = {
  "A5:B6": '=COUNTIFS(LeadsTable[Lead ID],"<>",LeadsTable[Status],"<>Dismissed",LeadsTable[Eligibility],"<>Ineligible")',
  "C5:D6": `=COUNTIFS(LeadsTable[Final Score],">="&${ALERT_THRESHOLD},LeadsTable[Judge Status],"Judged",LeadsTable[Eligibility],"Eligible",LeadsTable[Status],"<>Dismissed",LeadsTable[Status],"<>Expired")+COUNTIFS(LeadsTable[Final Score],">="&${ALERT_THRESHOLD},LeadsTable[Judge Status],"Judged",LeadsTable[Eligibility],"Unclear",LeadsTable[Status],"<>Dismissed",LeadsTable[Status],"<>Expired")`,
  "E5:F6": '=COUNTIF(ApplicationsTable[Lead ID],"<>")',
  "G5:H6": '=COUNTIFS(ApplicationsTable[Lead ID],"<>",ApplicationsTable[Next Follow-up],"<="&TODAY(),ApplicationsTable[Next Follow-up],"<>")',
};

export function applyDashboardFormulas(dashboard) {
  for (const [range, formula] of Object.entries(DASHBOARD_CARD_FORMULAS)) {
    dashboard.getRange(range).formulas = [[formula]];
    dashboard.getRange(range).setNumberFormat("0");
  }

  for (let row = 10; row <= 14; row += 1) {
    const targetKey = `LARGE(FILTER(${SCORE_KEYS},${PRIORITY_ELIGIBLE}),$A${row})`;
    const position = `MATCH(${targetKey},${SCORE_KEYS},0)`;
    for (const [column, source] of [
      ["B", "Company"], ["C", "Role / Title"], ["D", "Final Score"], ["E", "Best Resume"],
      ["F", "Eligibility"], ["G", "Status"], ["H", "Canonical URL"],
    ]) {
      dashboard.getRange(`${column}${row}`).formulas = [[`=IFERROR(INDEX(LeadsTable[${source}],${position}),"")`]];
    }
  }

  for (let row = 19; row <= 23; row += 1) {
    dashboard.getRange(`B${row}`).formulas = [[`=COUNTIF(LeadsTable[Recommendation],A${row})`]];
  }
}

export function synchronizeTrackerLabels(configSheet) {
  const range = configSheet.getRange("A25:C30");
  const values = range.values;
  const judgeStatus = values.find((row) => String(row[0] ?? "").trim() === "Judge Status");
  if (!judgeStatus) throw new Error("Search Config is missing the Judge Status validation label");
  judgeStatus[1] = "Judged | Needs Judge | Legacy / unjudged | Failed";
  range.values = values;
}
