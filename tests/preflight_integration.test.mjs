import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_GMAIL_JOB_ALERTS, DEFAULT_RELIABILITY } from "../scripts/project_config.mjs";
import { runPreflight } from "../scripts/preflight.mjs";
import { createFixtureWorkbook } from "./test_fixture.mjs";

const profile = `
# Candidate profile — Synthetic Candidate
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

test("preflight validates a complete synthetic fresh-clone contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-preflight-integration-"));
  const resumeDirectory = path.join(root, "profile", "resumes");
  await fs.mkdir(resumeDirectory, { recursive: true });
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  await fs.mkdir(path.join(root, "application-packages"), { recursive: true });
  await fs.copyFile(await createFixtureWorkbook(), path.join(root, "Tracker.xlsx"));
  await fs.writeFile(path.join(root, "profile", "candidate-profile.md"), profile);
  for (const file of ["backend.pdf", "staff.docx", "ai.pdf", "dx.docx", "product.pdf"]) {
    await fs.writeFile(path.join(resumeDirectory, file), "synthetic resume fixture\n");
  }
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  await fs.copyFile(path.join(projectRoot, "templates", "search-terms.template.json"), path.join(root, "profile", "search-terms.json"));
  await fs.copyFile(path.join(projectRoot, "templates", "eligibility-evidence.template.json"), path.join(root, "profile", "eligibility-evidence.json"));
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify({
    version: 5,
    candidate_name: "Synthetic Candidate",
    timezone: "Etc/UTC",
    target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx",
    candidate_profile_path: "profile/candidate-profile.md",
    search_terms_path: "profile/search-terms.json",
    eligibility_evidence_path: "profile/eligibility-evidence.json",
    resumes_directory: "profile/resumes",
    state_directory: "state",
    application_packages_directory: "application-packages",
    reliability: { ...DEFAULT_RELIABILITY },
    gmail_job_alerts: { ...DEFAULT_GMAIL_JOB_ALERTS, sender_allowlist: [] },
  }, null, 2));
  const result = await runPreflight({ projectRoot: root });
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.counts.Failed, 0);
  assert.ok(result.checks.every((check) => check.status === "Passed"));
  await fs.rm(root, { recursive: true, force: true });
});
