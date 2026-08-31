import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSanitizedNotificationConnectorCapabilityCatalog } from "../scripts/notification_connector_discovery.mjs";
import {
  buildNotificationConnectorCatalogHistoryReport,
  validateNotificationConnectorCatalogHistoryReport,
} from "../scripts/notification_connector_catalog_history.mjs";
import { runNotificationConnectorCatalogHistory } from "../scripts/inspect_notification_connector_catalog_history.mjs";

function targets() {
  return [
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
  ];
}

function capabilityExport({
  exportId = "NCAPEXP-AAAAAAAAAAAAAAAAAAAAAAAA",
  exportedAt = "2026-08-31T08:00:00.000Z",
  connectionRef = "fictional-workspace",
  operations = ["notifications.deliver", "notifications.status.read"],
  renderers = ["adapter_neutral_json_v1", "slack_blocks_v1"],
  exportedTargets = targets(),
} = {}) {
  return {
    schema_version: 1,
    export_id: exportId,
    exported_at: exportedAt,
    connection_ref: connectionRef,
    account_ref: "fictional-account-42",
    operations,
    renderers,
    targets: exportedTargets,
    safety: {
      read_only: true,
      credentials_included: false,
      endpoints_included: false,
      external_delivery_performed: false,
    },
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

function changedCatalogs() {
  const beforeCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const afterCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport({
    exportId: "NCAPEXP-BBBBBBBBBBBBBBBBBBBBBBBB",
    exportedAt: "2026-08-31T09:00:00.000Z",
    renderers: ["adapter_neutral_json_v1"],
    exportedTargets: [
      {
        ...targets()[0],
        operations: ["notifications.deliver"],
        renderers: ["adapter_neutral_json_v1"],
      },
      {
        target: "fictional-custom-main",
        label: "Fictional Custom Target",
        channel: "custom",
        operations: ["notifications.deliver"],
        renderers: ["adapter_neutral_json_v1"],
      },
    ],
  }));
  return { beforeCatalog, afterCatalog };
}

async function snapshot(root) {
  const records = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        records.push([
          path.relative(root, target),
          crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex"),
        ]);
      } else records.push([path.relative(root, target), "non-file"]);
    }
  }
  await visit(root);
  return records;
}

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-catalog-history-"));
  const directory = path.join(root, "state", "notifications", "discovery");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const { beforeCatalog, afterCatalog } = changedCatalogs();
  const beforePath = path.join(directory, `${beforeCatalog.catalog_id}.catalog.json`);
  const afterPath = path.join(directory, `${afterCatalog.catalog_id}.catalog.json`);
  await fs.writeFile(beforePath, JSON.stringify(beforeCatalog, null, 2) + "\n");
  await fs.writeFile(afterPath, JSON.stringify(afterCatalog, null, 2) + "\n");
  return { root, beforeCatalog, afterCatalog, beforePath, afterPath };
}

test("semantic catalog equality ignores export and catalog identity churn", () => {
  const beforeSource = capabilityExport();
  const afterSource = capabilityExport({
    exportId: "NCAPEXP-BBBBBBBBBBBBBBBBBBBBBBBB",
    exportedAt: "2026-08-31T09:00:00.000Z",
  });
  const beforeCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(beforeSource);
  const afterCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(afterSource);
  afterCatalog.generated_at = "2026-08-31T09:00:00Z";
  const first = buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog });
  const second = buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog });
  assert.deepEqual(first, second);
  assert.equal(first.status, "unchanged");
  assert.equal(first.counts.target_changes, 0);
  assert.equal(first.counts.global_operation_changes, 0);
  assert.equal(first.counts.global_renderer_changes, 0);
  assert.equal(first.after_generated_at, "2026-08-31T09:00:00.000Z");
  assert.equal(validateNotificationConnectorCatalogHistoryReport(first), first);
  const serialized = JSON.stringify(first);
  for (const target of [...beforeCatalog.targets, ...afterCatalog.targets]) {
    assert.equal(serialized.includes(target.target_id), false);
    assert.equal(serialized.includes(target.target_sha256), false);
  }
  assert.equal(serialized.includes(beforeSource.account_ref), false);
  assert.equal(serialized.includes(beforeSource.targets[0].target), false);
  assert.equal(serialized.includes(beforeSource.targets[0].label), false);
  assert.equal(first.safety.send_authorization_granted, false);
});

test("catalog history reports bounded added, removed, modified, and global capability changes", () => {
  const { beforeCatalog, afterCatalog } = changedCatalogs();
  const report = buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog });
  assert.equal(report.status, "changed");
  assert.deepEqual(report.counts, {
    before_targets: 2,
    after_targets: 2,
    added_targets: 1,
    removed_targets: 1,
    modified_targets: 1,
    target_changes: 3,
    global_operation_changes: 0,
    global_renderer_changes: 1,
  });
  assert.deepEqual(report.global_changes.renderers_removed, ["slack_blocks_v1"]);
  assert.deepEqual(report.target_changes.map((change) => change.change_type).sort(), ["added", "modified", "removed"]);
  assert.ok(report.target_changes.every((change) => /^NCAPHISTTGT-[A-F0-9]{24}$/.test(change.target_ref)));
  assert.ok(report.target_changes.every((change) => /^NCAPHCHG-[A-F0-9]{24}$/.test(change.change_id)));
  assert.equal(report.target_changes.find((change) => change.change_type === "modified")
    .renderers_removed.includes("slack_blocks_v1"), true);
});

test("catalog history fails closed for different connections or reversed chronology", () => {
  const beforeCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const otherConnection = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport({
    exportId: "NCAPEXP-BBBBBBBBBBBBBBBBBBBBBBBB",
    exportedAt: "2026-08-31T09:00:00.000Z",
    connectionRef: "other-fictional-workspace",
  }));
  assert.throws(() => buildNotificationConnectorCatalogHistoryReport({
    beforeCatalog, afterCatalog: otherConnection,
  }), /same opaque connection/);
  const olderCatalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport({
    exportId: "NCAPEXP-CCCCCCCCCCCCCCCCCCCCCCCC",
    exportedAt: "2026-08-31T07:00:00.000Z",
  }));
  assert.throws(() => buildNotificationConnectorCatalogHistoryReport({
    beforeCatalog, afterCatalog: olderCatalog,
  }), /nondecreasing/);
});

test("catalog history validation rejects impossible target counts", () => {
  const { beforeCatalog, afterCatalog } = changedCatalogs();
  const report = buildNotificationConnectorCatalogHistoryReport({ beforeCatalog, afterCatalog });
  const impossible = structuredClone(report);
  impossible.counts.before_targets = 1;
  impossible.report_id = report.report_id;
  assert.throws(
    () => validateNotificationConnectorCatalogHistoryReport(impossible),
    /internally inconsistent/,
  );
});

test("filesystem catalog history is bounded, contained, symlink-safe, and strictly read-only", async () => {
  const { root, beforePath, afterPath } = await workspace();
  const beforeSnapshot = await snapshot(root);
  const report = await runNotificationConnectorCatalogHistory({ projectRoot: root, beforePath, afterPath });
  assert.equal(report.status, "changed");
  assert.deepEqual(await snapshot(root), beforeSnapshot);

  const outside = path.join(root, "outside.catalog.json");
  await fs.writeFile(outside, await fs.readFile(beforePath));
  await assert.rejects(runNotificationConnectorCatalogHistory({
    projectRoot: root, beforePath: outside, afterPath,
  }), /remain under/);

  const original = await fs.readFile(beforePath);
  await fs.rm(beforePath);
  await fs.symlink(outside, beforePath);
  await assert.rejects(runNotificationConnectorCatalogHistory({
    projectRoot: root, beforePath, afterPath,
  }), /regular file/);
  await fs.rm(beforePath);
  await fs.writeFile(beforePath, original);

  await fs.writeFile(afterPath, " ".repeat(256 * 1024 + 1));
  await assert.rejects(runNotificationConnectorCatalogHistory({
    projectRoot: root, beforePath, afterPath,
  }), /no larger than/);
  await fs.rm(root, { recursive: true, force: true });
});
