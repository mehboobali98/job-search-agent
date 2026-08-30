import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestJobAlertBatch } from "../scripts/job_alert_ingestion_lib.mjs";
import {
  applyJobAlertProposal,
  loadTrackerIdentityKeys,
  recoverJobAlertProposal,
  runJobAlertIngestion,
} from "../scripts/ingest_job_alerts.mjs";
import { createFixtureWorkbook, FIXTURE_URL } from "./test_fixture.mjs";

const NOW = "2026-08-30T08:00:00Z";
const enabledConfig = {
  enabled: true, read_only: true, query: "newer_than:7d", freshness_hours: 168,
  max_messages: 50, max_links_per_message: 20, sender_allowlist: ["notifications.example.test"],
};

function batch(url = "https://jobs.ashbyhq.com/fictional/recovery-role") {
  return {
    schema_version: 1,
    batch_id: "synthetic-integration-batch-" + url.split("/").at(-1),
    transport: { provider: "gmail", access_mode: "read_only", query: "newer_than:7d" },
    retrieved_at: NOW,
    messages: [{
      message_id: "synthetic-integration-message",
      received_at: "2026-08-30T07:00:00Z",
      from: "Alerts <alerts@notifications.example.test>",
      subject: "Fictional role",
      text_body: url,
    }],
  };
}

test("tracker identity loading suppresses an already tracked alert URL", async () => {
  const workbook = await createFixtureWorkbook();
  const identities = await loadTrackerIdentityKeys(workbook);
  const result = ingestJobAlertBatch(batch(FIXTURE_URL), { config: enabledConfig, existingIdentityKeys: identities, now: NOW });
  assert.equal(result.proposed_candidates.length, 0);
  assert.equal(result.diagnostics.classification_counts.duplicate_in_tracker, 1);
});

test("preview writes no private state and apply is explicit and idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-alert-preview-"));
  const workbook = path.join(root, "Tracker.xlsx");
  const sourceWorkbook = await createFixtureWorkbook();
  await fs.copyFile(sourceWorkbook, workbook);
  const input = path.join(root, "private-batch.json");
  await fs.writeFile(input, JSON.stringify(batch()));
  const configPath = path.join(root, ".job-search.local.json");
  await fs.writeFile(configPath, JSON.stringify({
    version: 5,
    candidate_name: "Synthetic Candidate", timezone: "Etc/UTC", target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx", candidate_profile_path: "profile/candidate.md", search_terms_path: "profile/search.json",
    eligibility_evidence_path: "profile/eligibility.json", resumes_directory: "profile/resumes", state_directory: "state",
    application_packages_directory: "application-packages",
    reliability: { require_preflight: true, pending_retention_days: 30, query_recommendation_window: 20, query_recommendation_min_attempts: 5 },
    gmail_job_alerts: enabledConfig,
  }));
  const preview = await runJobAlertIngestion({ projectRoot: root, inputPath: input, now: NOW });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.persistent_state_written, false);
  await assert.rejects(fs.access(path.join(root, "state")), /ENOENT/);

  const applied = await runJobAlertIngestion({ projectRoot: root, inputPath: input, apply: true, now: NOW });
  assert.equal(applied.persistence.applied, true);
  const repeated = await runJobAlertIngestion({ projectRoot: root, inputPath: input, apply: true, now: NOW });
  assert.equal(repeated.persistence.already_applied, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("forced promotion failure preserves only a sanitized recoverable marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-alert-recovery-"));
  const proposal = ingestJobAlertBatch(batch("https://jobs.ashbyhq.com/fictional/failure-role"), { config: enabledConfig, now: NOW });
  await assert.rejects(applyJobAlertProposal({
    proposal,
    stateDirectory: root,
    beforePromote: async () => { throw new Error("Synthetic promotion failure"); },
  }), /Synthetic promotion failure/);
  const markerName = (await fs.readdir(root)).find((name) => name.startsWith("pending-job-alert-"));
  assert.ok(markerName);
  const markerPath = path.join(root, markerName);
  const markerText = await fs.readFile(markerPath, "utf8");
  assert.match(markerText, /Synthetic promotion failure/);
  assert.doesNotMatch(markerText, /alerts@notifications\.example\.test|synthetic-integration-message|text_body|html_body/);
  const recovered = await recoverJobAlertProposal({ markerPath, stateDirectory: root });
  assert.equal(recovered.recovered, true);
  await assert.rejects(fs.access(markerPath), /ENOENT/);
  assert.equal(JSON.parse(await fs.readFile(recovered.proposal_path, "utf8")).proposal_id, proposal.proposal_id);
  await fs.rm(root, { recursive: true, force: true });
});
