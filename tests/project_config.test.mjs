import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CURRENT_CONFIG_VERSION, DEFAULT_RELIABILITY, upgradeProjectConfig, validateProjectConfig } from "../scripts/project_config.mjs";
import { upgradeConfigFile } from "../scripts/upgrade_config.mjs";

const v1 = {
  version: 1,
  candidate_name: "Example Candidate",
  timezone: "Etc/UTC",
  target_geography: "Worldwide remote",
  tracker_path: "tracker.xlsx",
  candidate_profile_path: "profile/candidate.md",
  resumes_directory: "profile/resumes",
  state_directory: "state",
};

test("config upgrades are deterministic and preserve existing values", () => {
  const result = upgradeProjectConfig(v1);
  assert.equal(result.from_version, 1);
  assert.equal(result.to_version, CURRENT_CONFIG_VERSION);
  assert.equal(result.config.candidate_name, v1.candidate_name);
  assert.deepEqual(result.config.reliability, DEFAULT_RELIABILITY);
  assert.equal(result.config.search_terms_path, "profile/search-terms.json");
  assert.equal(result.config.eligibility_evidence_path, "profile/eligibility-evidence.json");
  assert.equal(result.config.application_packages_directory, "application-packages");
  assert.equal(upgradeProjectConfig(result.config).changed, false);
});

test("version 4 config validates reliability settings", () => {
  const config = upgradeProjectConfig(v1).config;
  assert.equal(validateProjectConfig(config), config);
  assert.throws(() => validateProjectConfig({ ...config, reliability: { ...config.reliability, query_recommendation_window: 0 } }), /positive integer/);
});

test("upgrade preview is read-only and apply creates a backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-search-config-"));
  const configPath = path.join(root, ".job-search.local.json");
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.writeFile(path.join(root, "templates", "search-terms.template.json"), '{"version":1,"synthetic":true}\n');
  await fs.writeFile(path.join(root, "templates", "eligibility-evidence.template.json"), '{"version":1,"entries":[]}\n');
  await fs.writeFile(configPath, JSON.stringify(v1, null, 2) + "\n");
  const before = await fs.readFile(configPath, "utf8");
  const preview = await upgradeConfigFile({ projectRoot: root });
  assert.equal(preview.mode, "preview");
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  const applied = await upgradeConfigFile({ projectRoot: root, apply: true });
  assert.equal(applied.to_version, CURRENT_CONFIG_VERSION);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).version, CURRENT_CONFIG_VERSION);
  assert.equal(await fs.readFile(applied.backup_path, "utf8"), before);
  assert.equal(applied.initialized_artifacts.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "profile", "eligibility-evidence.json"), "utf8")), { version: 1, entries: [] });
  await fs.rm(root, { recursive: true, force: true });
});
