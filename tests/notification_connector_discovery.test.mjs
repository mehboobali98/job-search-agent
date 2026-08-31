import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSanitizedNotificationConnectorCapabilityCatalog,
  validateNotificationConnectorCapabilityExport,
  validateNotificationConnectorCapabilityCatalog,
} from "../scripts/notification_connector_discovery.mjs";
import { runNotificationConnectorDiscoveryImport } from "../scripts/import_notification_connector_discovery.mjs";

const EXPORT_ID = "NCAPEXP-AAAAAAAAAAAAAAAAAAAAAAAA";

function capabilityExport(overrides = {}) {
  return {
    schema_version: 1,
    export_id: EXPORT_ID,
    exported_at: "2026-08-31T08:00:00.000Z",
    connection_ref: "fictional-workspace",
    account_ref: "fictional-account-42",
    operations: ["notifications.deliver", "notifications.status.read"],
    renderers: ["adapter_neutral_json_v1", "slack_blocks_v1"],
    targets: [
      {
        target: "C0123456789",
        label: "Fictional Engineering Jobs",
        channel: "slack",
        operations: ["notifications.deliver", "notifications.status.read"],
        renderers: ["adapter_neutral_json_v1", "slack_blocks_v1"],
      },
      {
        target: "fictional-webhook-main",
        label: "Fictional Webhook",
        channel: "webhook",
        operations: ["notifications.deliver"],
        renderers: ["adapter_neutral_json_v1"],
      },
    ],
    safety: {
      read_only: true,
      credentials_included: false,
      endpoints_included: false,
      external_delivery_performed: false,
    },
    ...overrides,
  };
}

function localConfig() {
  return {
    version: 6,
    candidate_name: "Synthetic Candidate",
    timezone: "Etc/UTC",
    target_geography: "Worldwide remote",
    tracker_path: "Tracker.xlsx",
    candidate_profile_path: "profile/candidate.md",
    search_terms_path: "profile/search-terms.json",
    eligibility_evidence_path: "profile/eligibility.json",
    resumes_directory: "profile/resumes",
    state_directory: "state",
    application_packages_directory: "application-packages",
    reliability: {
      require_preflight: true,
      pending_retention_days: 30,
      query_recommendation_window: 20,
      query_recommendation_min_attempts: 5,
    },
    gmail_job_alerts: {
      enabled: false,
      read_only: true,
      query: "newer_than:7d",
      freshness_hours: 168,
      max_messages: 50,
      max_links_per_message: 20,
      sender_allowlist: [],
    },
    notifications: {
      enabled: false,
      max_items_per_digest: 5,
      quiet_hours: { enabled: false, start: "22:00", end: "08:00" },
      destinations: [],
    },
  };
}

async function workspace(source = capabilityExport()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-discovery-"));
  const exportDirectory = path.join(root, "state", "notification-connector-discovery", "exports");
  await fs.mkdir(exportDirectory, { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const inputPath = path.join(exportDirectory, `${source.export_id}.capabilities.json`);
  await fs.writeFile(inputPath, JSON.stringify(source, null, 2) + "\n");
  return { root, inputPath };
}

test("private capability exports produce deterministic sanitized catalogs", () => {
  const source = capabilityExport();
  const first = buildSanitizedNotificationConnectorCapabilityCatalog(source);
  const second = buildSanitizedNotificationConnectorCapabilityCatalog(source);
  assert.deepEqual(first, second);
  assert.match(first.catalog_id, /^NCAPCAT-[A-F0-9]{24}$/);
  assert.match(first.approval_id, /^NCAP-[A-F0-9]{24}$/);
  assert.equal(first.counts.targets, 2);
  assert.equal(first.safety.account_identifier_included, false);
  assert.equal(first.safety.native_target_included, false);
  assert.equal(first.safety.target_label_included, false);
  assert.ok(first.targets.every((target) => /^NCAPTGT-[A-F0-9]{24}$/.test(target.target_id)));
  assert.ok(first.targets.every((target) => /^[a-f0-9]{64}$/.test(target.target_sha256)));
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(source.account_ref), false);
  assert.equal(serialized.includes(source.targets[0].target), false);
  assert.equal(serialized.includes(source.targets[0].label), false);
  assert.equal(validateNotificationConnectorCapabilityCatalog(first), first);
});

test("capability validation rejects widening, duplicates, and non-Slack native rendering", () => {
  assert.throws(() => validateNotificationConnectorCapabilityExport(capabilityExport({
    unexpected_field: true,
  })), /Unsupported/);
  assert.throws(() => validateNotificationConnectorCapabilityExport(capabilityExport({
    safety: { ...capabilityExport().safety, credentials_included: true },
  })), /safety flags/);
  assert.throws(() => validateNotificationConnectorCapabilityExport(capabilityExport({
    operations: ["notifications.status.read"],
  })), /must include notifications\.deliver/);
  assert.throws(() => validateNotificationConnectorCapabilityExport(capabilityExport({
    targets: [{
      target: "fictional-email",
      label: "Fictional Email",
      channel: "email",
      operations: ["notifications.deliver"],
      renderers: ["slack_blocks_v1"],
    }],
  })), /Slack rendering/);
  const duplicate = capabilityExport();
  duplicate.targets = [duplicate.targets[0], { ...duplicate.targets[0] }];
  assert.throws(() => validateNotificationConnectorCapabilityExport(duplicate), /duplicates/);
  const excessive = capabilityExport();
  excessive.targets = Array.from({ length: 101 }, (_, index) => ({
    ...excessive.targets[0],
    target: `fictional-target-${index}`,
  }));
  assert.throws(() => validateNotificationConnectorCapabilityExport(excessive), /1-100 entries/);
});

test("discovery import enforces private containment, exact filenames, and source size limits", async () => {
  const { root, inputPath } = await workspace();
  const outside = path.join(root, "outside.capabilities.json");
  await fs.writeFile(outside, await fs.readFile(inputPath));
  await assert.rejects(runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath: outside }), /remain under/);

  const mismatched = path.join(path.dirname(inputPath), "mismatched.capabilities.json");
  await fs.rename(inputPath, mismatched);
  await assert.rejects(runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath: mismatched }), /filename must match/);

  await fs.writeFile(mismatched, " ".repeat(256 * 1024 + 1));
  await assert.rejects(runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath: mismatched }), /no larger than/);
  await fs.rm(root, { recursive: true, force: true });
});

test("preview is read-only and exact apply is private, atomic, and idempotent", async () => {
  const source = capabilityExport();
  const { root, inputPath } = await workspace(source);
  const sourceBefore = await fs.readFile(inputPath, "utf8");
  const preview = await runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.persistence.persistent_files_written, 0);
  assert.equal(preview.network_accessed, false);
  assert.equal(preview.external_delivery_performed, false);
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes(source.account_ref), false);
  assert.equal(serialized.includes(source.targets[0].target), false);
  assert.equal(serialized.includes(source.targets[0].label), false);
  await assert.rejects(fs.access(path.join(root, "state", "notifications")), /ENOENT/);
  assert.equal(await fs.readFile(inputPath, "utf8"), sourceBefore);

  await assert.rejects(runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: "NCAP-000000000000000000000000",
  }), /exact preview approval/);
  const applied = await runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
  });
  assert.equal(applied.persistence.persistent_files_written, 1);
  const catalogPath = path.join(
    root, "state", "notifications", "discovery", `${preview.preview.catalog.catalog_id}.catalog.json`,
  );
  const catalogText = await fs.readFile(catalogPath, "utf8");
  assert.equal(catalogText.includes(source.account_ref), false);
  assert.equal(catalogText.includes(source.targets[0].target), false);
  assert.equal(catalogText.includes(source.targets[0].label), false);
  const repeated = await runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
  });
  assert.equal(repeated.persistence.already_applied, true);
  assert.equal(repeated.persistence.persistent_files_written, 0);
  assert.equal(await fs.readFile(inputPath, "utf8"), sourceBefore);
  await fs.rm(root, { recursive: true, force: true });
});

test("discovery paths reject source and catalog symbolic-link escapes", async () => {
  const { root, inputPath } = await workspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "notification-discovery-outside-"));
  const outsideInput = path.join(outside, "outside.json");
  await fs.writeFile(outsideInput, await fs.readFile(inputPath));
  await fs.rm(inputPath);
  await fs.symlink(outsideInput, inputPath);
  await assert.rejects(runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath }), /regular file/);

  await fs.rm(inputPath);
  await fs.writeFile(inputPath, JSON.stringify(capabilityExport(), null, 2) + "\n");
  const preview = await runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath });
  await fs.mkdir(path.join(root, "state", "notifications"), { recursive: true });
  await fs.symlink(outside, path.join(root, "state", "notifications", "discovery"));
  await assert.rejects(runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
  }), /regular private directory/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test("failed catalog commit leaves only redacted exact recovery state", async () => {
  const source = capabilityExport();
  const { root, inputPath } = await workspace(source);
  const preview = await runNotificationConnectorDiscoveryImport({ projectRoot: root, inputPath });
  let pendingPath;
  await assert.rejects(runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
    beforeCatalogCommit: async () => { throw new Error(`Synthetic failure for ${source.targets[0].target}`); },
  }), (error) => {
    pendingPath = error.pending_marker;
    return /exact private recovery/.test(error.message);
  });
  const markerText = await fs.readFile(pendingPath, "utf8");
  assert.equal(markerText.includes(source.account_ref), false);
  assert.equal(markerText.includes(source.targets[0].target), false);
  assert.equal(markerText.includes(source.targets[0].label), false);
  assert.equal(markerText.includes("Synthetic failure"), false);
  await assert.rejects(runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
  }), /pending connector discovery/);
  const recovered = await runNotificationConnectorDiscoveryImport({
    projectRoot: root,
    inputPath,
    apply: true,
    approvalId: preview.preview.approval_id,
    recoverPath: pendingPath,
  });
  assert.equal(recovered.persistence.recovered, true);
  assert.equal(recovered.persistence.persistent_files_written, 1);
  await assert.rejects(fs.access(pendingPath), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});
