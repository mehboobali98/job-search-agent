export const TABLE_BODY_FORMAT = {
  font: { name: "Arial", size: 9, color: "#262626" },
  verticalAlignment: "top",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#E6EAF0" },
};

const NEXT_APPEND_ROW = new WeakMap();

export function styleTrackerRow(sheet, rowNumber, endColumn, {
  numberFormats = {},
  validations = {},
  conditionalFormats = [],
  rowHeight = null,
} = {}) {
  if (!Number.isInteger(rowNumber) || rowNumber < 4) throw new Error("Tracker row number must be at least 4");
  const rowRange = sheet.getRange(`A${rowNumber}:${endColumn}${rowNumber}`);
  rowRange.format = TABLE_BODY_FORMAT;
  for (const [columnOrRange, numberFormat] of Object.entries(numberFormats)) {
    const columns = columnOrRange.split(":");
    const range = columns.length === 2
      ? `${columns[0]}${rowNumber}:${columns[1]}${rowNumber}`
      : `${columnOrRange}${rowNumber}`;
    sheet.getRange(range).setNumberFormat(numberFormat);
  }
  for (const [column, values] of Object.entries(validations)) {
    sheet.getRange(`${column}${rowNumber}`).dataValidation = { rule: { type: "list", values } };
  }
  for (const { column, type, options } of conditionalFormats) {
    sheet.getRange(`${column}${rowNumber}`).conditionalFormats.add(type, options);
  }
  if (rowHeight === null) rowRange.format.autofitRows();
  else rowRange.format.rowHeight = rowHeight;
  return rowRange;
}

export function appendStyledRow(table, sheet, values, endColumn, options = {}) {
  const rowNumber = NEXT_APPEND_ROW.get(table) ?? (4 + table.getDataRows().length);
  table.rows.add(null, [values]);
  NEXT_APPEND_ROW.set(table, rowNumber + 1);
  styleTrackerRow(sheet, rowNumber, endColumn, options);
  return rowNumber;
}
