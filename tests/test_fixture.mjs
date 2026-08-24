import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { createTracker } from "../scripts/create_tracker.mjs";
import { canonicalKey, descriptionHash } from "../scripts/job_tracker_lib.mjs";

export const FIXTURE_LEAD_ID = "L-TEST-001";
export const FIXTURE_URL = "https://jobs.example.test/fixture-role";

export async function createFixtureWorkbook() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-tracker-fixture-"));
  const workbookPath = path.join(directory, "Tracker.xlsx");
  await createTracker({
    outputPath: workbookPath,
    candidateName: "Example Candidate",
    timezone: "Etc/UTC",
    targetGeography: "Worldwide remote",
  });
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const description = "Own backend services for a globally distributed product.";
  const identity = { company: "Fixture Company", title: "Senior Backend Engineer", location: "Worldwide remote", canonical_url: FIXTURE_URL, job_id: "FIXTURE-1" };
  workbook.worksheets.getItem("Leads").tables.getItem("LeadsTable").rows.add(null, [[
    FIXTURE_LEAD_ID, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"),
    identity.company, identity.title, identity.location, "Remote", "Employer careers", FIXTURE_URL, identity.job_id,
    new Date("2026-01-01T00:00:00Z"), "Eligible", "Worldwide remote is explicitly stated.", "High",
    "Backend / Platform", 23, 18, 13, 13, 8, 9, 3, 87, "Strong match",
    "Verified backend ownership", "Compensation is unpublished", "Review", null, canonicalKey(identity),
    descriptionHash(description), "FIXTURE-SEED", "Judged", false, "Reusable test fixture", null, null, null,
  ]]);
  await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);
  return workbookPath;
}
