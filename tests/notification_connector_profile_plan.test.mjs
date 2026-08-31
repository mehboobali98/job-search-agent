import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSanitizedNotificationConnectorCapabilityCatalog } from "../scripts/notification_connector_discovery.mjs";
import {
  buildNotificationConnectorProfilePlan,
  validateNotificationConnectorProfilePlan,
} from "../scripts/notification_connector_profile_plan.mjs";
import { runNotificationConnectorProfilePlan } from "../scripts/plan_notification_connector_profile.mjs";

function capabilityExport() {
  return {
    schema_version: 1,
    export_id: "NCAPEXP-AAAAAAAAAAAAAAAAAAAAAAAA",
    exported_at: "2026-08-31T10:00:00.000Z",
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
  };
}

function destination(overrides = {}) {
  return {
    id: "slack-jobs",
    enabled: false,
    adapter: "connector",
    channel: "slack",
    connection_ref: "fictional-workspace",
    minimum_score: 80,
    max_items: 5,
    include_resume: false,
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
      destinations: [destination(), destination({
        id: "webhook-jobs",
        channel: "webhook",
      })],
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-profile-plan-"));
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const directory = path.join(root, "state", "notifications", "discovery");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, ".job-search.local.json"), JSON.stringify(localConfig(), null, 2) + "\n");
  const catalogPath = path.join(directory, `${catalog.catalog_id}.catalog.json`);
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  return { root, catalog, catalogPath };
}

test("Slack catalog targets produce deterministic disabled authoring plans without private identifiers", () => {
  const source = capabilityExport();
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(source);
  const target = catalog.targets.find((entry) => entry.channel === "slack");
  const first = buildNotificationConnectorProfilePlan({
    catalog,
    destination: destination(),
    targetId: target.target_id,
    renderer: "slack_blocks_v1",
  });
  const second = buildNotificationConnectorProfilePlan({
    catalog,
    destination: destination(),
    targetId: target.target_id,
    renderer: "slack_blocks_v1",
  });
  assert.deepEqual(first, second);
  assert.equal(validateNotificationConnectorProfilePlan(first), first);
  assert.equal(first.profile_schema_version, 2);
  assert.equal(first.profile_enabled_default, false);
  assert.equal(first.destination_enabled, false);
  assert.deepEqual(first.required_manual_inputs, [
    "profile_id", "https_endpoint", "bearer_environment_variable", "native_target",
  ]);
  assert.equal(first.verification.native_target_hash_match_required, true);
  assert.equal(first.verification.expected_drift_status, "aligned_only_if_native_target_matches");
  assert.equal(first.safety.approval_id_issued, false);
  assert.equal(first.safety.send_authorization_granted, false);
  const serialized = JSON.stringify(first);
  for (const privateValue of [
    source.account_ref,
    source.connection_ref,
    source.targets[0].target,
    source.targets[0].label,
    target.target_id,
    target.target_sha256,
  ]) assert.equal(serialized.includes(privateValue), false, privateValue);
});

test("adapter-neutral planning preserves deliberate target uncertainty", () => {
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const target = catalog.targets.find((entry) => entry.channel === "webhook");
  const plan = buildNotificationConnectorProfilePlan({
    catalog,
    destination: destination({ id: "webhook-jobs", channel: "webhook" }),
    targetId: target.target_id,
    renderer: "adapter_neutral_json_v1",
  });
  assert.deepEqual(plan.required_manual_inputs, [
    "profile_id", "https_endpoint", "bearer_environment_variable",
  ]);
  assert.equal(plan.verification.native_target_hash_match_required, false);
  assert.equal(plan.verification.expected_drift_status, "review_required_target_not_hash_bound");
});

test("profile planning rejects inferred or incompatible selections", () => {
  const catalog = buildSanitizedNotificationConnectorCapabilityCatalog(capabilityExport());
  const slack = catalog.targets.find((entry) => entry.channel === "slack");
  const webhook = catalog.targets.find((entry) => entry.channel === "webhook");
  assert.throws(() => buildNotificationConnectorProfilePlan({
    catalog, destination: destination(), targetId: "NCAPTGT-BBBBBBBBBBBBBBBBBBBBBBBB", renderer: "slack_blocks_v1",
  }), /exact catalog target/);
  assert.throws(() => buildNotificationConnectorProfilePlan({
    catalog, destination: destination({ connection_ref: "other-workspace" }), targetId: slack.target_id, renderer: "slack_blocks_v1",
  }), /connection does not match/);
  assert.throws(() => buildNotificationConnectorProfilePlan({
    catalog, destination: destination(), targetId: webhook.target_id, renderer: "adapter_neutral_json_v1",
  }), /channel does not match/);
  assert.throws(() => buildNotificationConnectorProfilePlan({
    catalog,
    destination: destination({ id: "webhook-jobs", channel: "webhook" }),
    targetId: webhook.target_id,
    renderer: "slack_blocks_v1",
  }), /does not support/);
  assert.throws(() => buildNotificationConnectorProfilePlan({
    catalog, destination: destination({ adapter: "private_file" }), targetId: slack.target_id, renderer: "slack_blocks_v1",
  }), /configured connector destination/);
});

test("filesystem profile planning is bounded, contained, symlink-safe, and strictly read-only", async () => {
  const { root, catalog, catalogPath } = await workspace();
  const target = catalog.targets.find((entry) => entry.channel === "slack");
  const before = await snapshot(root);
  const plan = await runNotificationConnectorProfilePlan({
    projectRoot: root,
    catalogPath,
    targetId: target.target_id,
    destinationId: "slack-jobs",
    renderer: "slack_blocks_v1",
  });
  assert.match(plan.plan_id, /^NCAPPROF-[A-F0-9]{24}$/);
  assert.deepEqual(await snapshot(root), before);

  const outside = path.join(root, "outside.catalog.json");
  await fs.writeFile(outside, await fs.readFile(catalogPath));
  await assert.rejects(runNotificationConnectorProfilePlan({
    projectRoot: root,
    catalogPath: outside,
    targetId: target.target_id,
    destinationId: "slack-jobs",
    renderer: "slack_blocks_v1",
  }), /remain under/);

  const original = await fs.readFile(catalogPath);
  await fs.rm(catalogPath);
  await fs.symlink(outside, catalogPath);
  await assert.rejects(runNotificationConnectorProfilePlan({
    projectRoot: root,
    catalogPath,
    targetId: target.target_id,
    destinationId: "slack-jobs",
    renderer: "slack_blocks_v1",
  }), /regular file/);
  await fs.rm(catalogPath);
  await fs.writeFile(catalogPath, original);

  await fs.writeFile(catalogPath, " ".repeat(256 * 1024 + 1));
  await assert.rejects(runNotificationConnectorProfilePlan({
    projectRoot: root,
    catalogPath,
    targetId: target.target_id,
    destinationId: "slack-jobs",
    renderer: "slack_blocks_v1",
  }), /no larger than/);
  await fs.rm(root, { recursive: true, force: true });
});
