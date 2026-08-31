import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSanitizedNotificationConnectorBinding,
} from "../scripts/notification_connector_runtime.mjs";
import {
  buildSanitizedNotificationConnectorCapabilityCatalog,
} from "../scripts/notification_connector_discovery.mjs";
import {
  buildNotificationConnectorDriftReport,
  validateNotificationConnectorDriftReport,
} from "../scripts/notification_connector_drift.mjs";
import { runNotificationConnectorDriftInspection } from "../scripts/inspect_notification_connector_drift.mjs";

function capabilityExport(overrides = {}) {
  return {
    schema_version: 1,
    export_id: "NCAPEXP-AAAAAAAAAAAAAAAAAAAAAAAA",
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

function connectorProfile(overrides = {}) {
  return {
    schema_version: 2,
    profile_id: "fictional-slack",
    enabled: false,
    connection_ref: "fictional-workspace",
    transport: "https_json_bearer",
    endpoint: "https://connector.example.test/notifications",
    authentication: { type: "bearer_env", environment_variable: "SYNTHETIC_CONNECTOR_BEARER" },
    allowed_destinations: [{
      destination_id: "slack-jobs",
      channel: "slack",
      rendering: { renderer: "slack_blocks_v1", target: "C0123456789" },
    }],
    request_policy: {
      timeout_ms: 4_000,
      max_request_bytes: 65_536,
      max_response_bytes: 8_192,
      max_attempts: 2,
      retry_delays_ms: [250],
    },
    idempotency: { required: true, header: "Idempotency-Key" },
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-connector-drift-"));
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const binding = buildSanitizedNotificationConnectorBinding(connectorProfile());
  const catalogDirectory = path.join(root, "state", "notifications", "discovery");
  const bindingDirectory = path.join(root, "state", "notifications", "connectors");
  await fs.mkdir(catalogDirectory, { recursive: true });
  await fs.mkdir(bindingDirectory, { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const catalogPath = path.join(catalogDirectory, `${catalog.catalog_id}.catalog.json`);
  const bindingPath = path.join(bindingDirectory, `${binding.profile_id}.binding.json`);
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  await fs.writeFile(bindingPath, JSON.stringify(binding, null, 2) + "\n");
  return { root, catalog, binding, catalogPath, bindingPath };
}

test("native target hashes produce deterministic aligned drift without exposing private target data", () => {
  const source = capabilityExport();
  const profile = connectorProfile();
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(source);
  const binding = buildSanitizedNotificationConnectorBinding(profile);
  const first = buildNotificationConnectorDriftReport({ catalog, binding });
  const second = buildNotificationConnectorDriftReport({ catalog, binding });
  assert.deepEqual(first, second);
  assert.equal(first.status, "aligned");
  assert.equal(first.counts.compatible, 1);
  assert.equal(first.counts.bound_catalog_targets, 1);
  assert.equal(first.counts.available_catalog_targets, 1);
  assert.equal(first.binding_destinations[0].matched_target_id, first.catalog_targets.find((target) => target.status === "bound").target_id);
  assert.equal(validateNotificationConnectorDriftReport(first), first);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(source.account_ref), false);
  assert.equal(serialized.includes(source.targets[0].target), false);
  assert.equal(serialized.includes(source.targets[0].label), false);
  assert.equal(serialized.includes(catalog.targets[0].target_sha256), false);
  assert.equal(serialized.includes(profile.endpoint), false);
  assert.equal(serialized.includes(profile.authentication.environment_variable), false);
  assert.equal(first.safety.send_authorization_granted, false);
});

test("non-hash-bound adapter-neutral bindings require manual review without guessing a target", () => {
  const profile = {
    ...connectorProfile(),
    schema_version: 1,
    allowed_destinations: [{ destination_id: "slack-jobs", channel: "slack" }],
  };
  const report = buildNotificationConnectorDriftReport({
    catalog: buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport()),
    binding: buildSanitizedNotificationConnectorBinding(profile),
  });
  assert.equal(report.status, "review_required");
  assert.equal(report.counts.manual_review, 1);
  assert.equal(report.binding_destinations[0].target_hash_bound, false);
  assert.equal(report.binding_destinations[0].matched_target_id, null);
  assert.deepEqual(report.binding_destinations[0].issue_codes, ["target_not_hash_bound"]);
});

test("connection, target, and renderer drift are incompatible", () => {
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const connectionMismatch = buildNotificationConnectorDriftReport({
    catalog,
    binding: buildSanitizedNotificationConnectorBinding(connectorProfile({ connection_ref: "other-workspace" })),
  });
  assert.equal(connectionMismatch.status, "incompatible");
  assert.deepEqual(connectionMismatch.binding_destinations[0].issue_codes, ["connection_ref_mismatch"]);

  const targetMismatch = buildNotificationConnectorDriftReport({
    catalog,
    binding: buildSanitizedNotificationConnectorBinding(connectorProfile({
      allowed_destinations: [{
        destination_id: "slack-jobs",
        channel: "slack",
        rendering: { renderer: "slack_blocks_v1", target: "C9999999999" },
      }],
    })),
  });
  assert.deepEqual(targetMismatch.binding_destinations[0].issue_codes, ["target_missing_from_catalog"]);

  const neutralOnly = capabilityExport({
    renderers: ["adapter_neutral_json_v1"],
    targets: [{
      target: "C0123456789",
      label: "Fictional Engineering Jobs",
      channel: "slack",
      operations: ["notifications.deliver"],
      renderers: ["adapter_neutral_json_v1"],
    }],
  });
  const rendererMismatch = buildNotificationConnectorDriftReport({
    catalog: buildSanitizedNotificationConnectorCapabilityCatalog(neutralOnly),
    binding: buildSanitizedNotificationConnectorBinding(connectorProfile()),
  });
  assert.deepEqual(rendererMismatch.binding_destinations[0].issue_codes, ["renderer_unsupported"]);
});

test("filesystem drift inspection is bounded, contained, symlink-safe, and strictly read-only", async () => {
  const { root, catalogPath, bindingPath } = await workspace();
  const before = await snapshot(root);
  const report = await runNotificationConnectorDriftInspection({ projectRoot: root, catalogPath, bindingPath });
  assert.equal(report.status, "aligned");
  assert.deepEqual(await snapshot(root), before);

  const outside = path.join(root, "outside.catalog.json");
  await fs.writeFile(outside, await fs.readFile(catalogPath));
  await assert.rejects(runNotificationConnectorDriftInspection({
    projectRoot: root, catalogPath: outside, bindingPath,
  }), /remain under/);

  const original = await fs.readFile(catalogPath);
  await fs.rm(catalogPath);
  await fs.symlink(outside, catalogPath);
  await assert.rejects(runNotificationConnectorDriftInspection({
    projectRoot: root, catalogPath, bindingPath,
  }), /regular file/);
  await fs.rm(catalogPath);
  await fs.writeFile(catalogPath, original);

  await fs.writeFile(bindingPath, " ".repeat(64 * 1024 + 1));
  await assert.rejects(runNotificationConnectorDriftInspection({
    projectRoot: root, catalogPath, bindingPath,
  }), /no larger than/);
  await fs.rm(root, { recursive: true, force: true });
});
