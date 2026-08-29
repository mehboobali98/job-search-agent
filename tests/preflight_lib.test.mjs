import assert from "node:assert/strict";
import test from "node:test";
import { inspectCandidateProfile, inspectResumeInventory, summarizePreflight } from "../scripts/preflight_lib.mjs";

const completeProfile = `
# Candidate profile — Example Candidate
- Work authorization: Unknown
- \`E-BE-01\` — Built a reliable service.
- \`E-LEAD-01\` — Led a small delivery team.
- \`E-AI-01\` — Evaluated a synthetic retrieval pipeline.
- \`E-DX-01\` — Automated a verified workflow.
- \`E-FS-01\` — Shipped a user-facing feature.
## Resume inventory
- Backend / Platform — backend.pdf
- Staff / Principal / Tech Lead — staff.docx
- Applied AI / LLM — ai.pdf
- Developer Productivity / AI Enablement — dx.docx
- Full-stack / Product — product.pdf
`;

test("candidate profile inspection rejects placeholders and duplicate evidence", () => {
  const valid = inspectCandidateProfile(completeProfile);
  assert.equal(valid.valid, true);
  assert.equal(inspectCandidateProfile(completeProfile + "\n- `E-BE-01` — duplicate").valid, false);
  assert.equal(inspectCandidateProfile(completeProfile + "\n[VERIFIED FACTS]").has_placeholders, true);
});

test("candidate profile inspection accepts stable evidence IDs in bold Markdown", () => {
  const boldProfile = completeProfile.replaceAll(/`(E-[^`]+)`/g, "**$1**");
  const inspection = inspectCandidateProfile(boldProfile);
  assert.equal(inspection.valid, true);
  assert.equal(inspection.evidence_id_count, 5);
});

test("resume inventory requires exact supported files for every variant", () => {
  const profile = inspectCandidateProfile(completeProfile);
  const entries = ["backend.pdf", "staff.docx", "ai.pdf", "dx.docx", "product.pdf"].map((name) => ({ name, isFile: true, size: 10 }));
  assert.equal(inspectResumeInventory(profile, entries).valid, true);
  assert.equal(inspectResumeInventory(profile, entries.slice(1)).valid, false);
  assert.equal(inspectResumeInventory(profile, [{ name: "backend.pdf", isFile: true, size: 0 }]).supported_file_count, 0);
});

test("preflight summary treats warnings as ready and failures as blocking", () => {
  assert.equal(summarizePreflight([{ status: "Passed" }, { status: "Warning" }]).ready, true);
  assert.equal(summarizePreflight([{ status: "Failed" }]).ready, false);
});
