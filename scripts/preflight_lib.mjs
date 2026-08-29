import path from "node:path";
import { RESUMES } from "./job_tracker_lib.mjs";

export const SUPPORTED_RESUME_EXTENSIONS = new Set([".pdf", ".docx"]);

function cleanInventoryValue(value) {
  return String(value ?? "").trim().replace(/^`|`$/g, "").trim();
}

export function inspectCandidateProfile(text) {
  const source = String(text ?? "");
  const placeholderPatterns = [
    /\{\{[^}]+\}\}/,
    /\[(?:VERIFIED|FILE NAME|PUBLIC PROJECT|PUBLIC URL|REMOTE \/ HYBRID|EXAMPLE:)[^\]]*\]/i,
  ];
  const evidenceIds = [...source.matchAll(/`(E-[A-Z0-9]+(?:-[A-Z0-9]+)*)`/g)].map((match) => match[1]);
  const duplicateEvidenceIds = [...new Set(evidenceIds.filter((id, index) => evidenceIds.indexOf(id) !== index))];
  const inventory = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(.+?)\s+—\s+(.+?)\s*$/);
    if (!match || !RESUMES.has(match[1])) continue;
    inventory[match[1]] = cleanInventoryValue(match[2]);
  }
  const missingEvidenceSections = ["E-BE-", "E-LEAD-", "E-AI-", "E-DX-", "E-FS-"].filter(
    (prefix) => !evidenceIds.some((id) => id.startsWith(prefix)),
  );
  return {
    valid: source.trim().length > 0 && !placeholderPatterns.some((pattern) => pattern.test(source))
      && evidenceIds.length > 0 && duplicateEvidenceIds.length === 0 && missingEvidenceSections.length === 0,
    has_placeholders: placeholderPatterns.some((pattern) => pattern.test(source)),
    evidence_id_count: evidenceIds.length,
    duplicate_evidence_ids: duplicateEvidenceIds,
    missing_evidence_sections: missingEvidenceSections,
    inventory,
  };
}

export function inspectResumeInventory(profileInspection, directoryEntries) {
  const files = directoryEntries
    .filter((entry) => entry.isFile === true && Number(entry.size ?? 0) > 0 && SUPPORTED_RESUME_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  const emptyFiles = directoryEntries
    .filter((entry) => entry.isFile === true && Number(entry.size ?? 0) <= 0 && SUPPORTED_RESUME_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  const fileNames = new Set(files);
  const missingRoles = [...RESUMES].filter((role) => !profileInspection.inventory[role]);
  const missingFiles = [...RESUMES]
    .map((role) => ({ role, file: profileInspection.inventory[role] }))
    .filter((item) => item.file && !fileNames.has(item.file));
  const unsupportedInventoryFiles = [...RESUMES]
    .map((role) => ({ role, file: profileInspection.inventory[role] }))
    .filter((item) => item.file && !SUPPORTED_RESUME_EXTENSIONS.has(path.extname(item.file).toLowerCase()));
  return {
    valid: files.length > 0 && missingRoles.length === 0 && missingFiles.length === 0 && unsupportedInventoryFiles.length === 0,
    supported_file_count: files.length,
    missing_roles: missingRoles,
    missing_files: missingFiles,
    unsupported_inventory_files: unsupportedInventoryFiles,
    empty_files: emptyFiles,
  };
}

export function summarizePreflight(checks) {
  const counts = { Passed: 0, Warning: 0, Failed: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { ready: counts.Failed === 0, counts, checks };
}
