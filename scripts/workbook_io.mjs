import fs from "node:fs/promises";
import path from "node:path";

export function resolveXlsxWorkbookPath(value, label = "Workbook path") {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(label + " is required");
  const resolved = path.resolve(text);
  if (path.extname(resolved).toLowerCase() !== ".xlsx") {
    throw new Error(label + " must end with .xlsx");
  }
  return resolved;
}

export function workbookTemporaryPath(workbookPath, marker = "tmp") {
  const resolved = resolveXlsxWorkbookPath(workbookPath);
  const safeMarker = String(marker ?? "tmp").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!safeMarker) throw new Error("Temporary workbook marker is required");
  const temporary = resolved.slice(0, -5) + "." + safeMarker + ".xlsx";
  if (temporary === resolved) throw new Error("Temporary workbook path must differ from the live workbook");
  return temporary;
}

export function workbookInspectionPath(workbookPath) {
  return resolveXlsxWorkbookPath(workbookPath) + ".inspect.ndjson";
}

export async function removeWorkbookInspection(workbookPath) {
  await fs.rm(workbookInspectionPath(workbookPath), { force: true });
}

export async function removeTemporaryWorkbook(temporaryPath, workbookPath) {
  const temporary = path.resolve(temporaryPath);
  const workbook = resolveXlsxWorkbookPath(workbookPath);
  if (temporary === workbook) throw new Error("Refusing to remove the live workbook as a temporary file");
  await fs.rm(temporary, { force: true });
  await removeWorkbookInspection(temporary);
}
