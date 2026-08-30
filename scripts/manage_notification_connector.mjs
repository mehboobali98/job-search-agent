import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteFilesWithRollback } from "./file_transaction.mjs";
import {
  MAX_CONNECTOR_PROFILE_BYTES,
  notificationConnectorProfilePreview,
  validateNotificationConnectorBinding,
} from "./notification_connector_runtime.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function safeSlug(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text)) throw new Error(`${label} is not a safe opaque slug`);
  return text;
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function connectorBindingPath(stateDirectory, binding) {
  validateNotificationConnectorBinding(binding);
  return path.join(
    path.resolve(stateDirectory),
    "notifications",
    "connectors",
    `${safeSlug(binding.profile_id, "Connector profile_id")}.binding.json`,
  );
}

export async function applyNotificationConnectorBinding({ binding, approvalId, stateDirectory } = {}) {
  validateNotificationConnectorBinding(binding);
  if (approvalId !== binding.approval_id) throw new Error("Connector binding import requires the exact preview approval ID");
  const target = connectorBindingPath(stateDirectory, binding);
  const contents = JSON.stringify(binding, null, 2) + "\n";
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await fileExists(target)) {
    if (await fs.readFile(target, "utf8") === contents) {
      return { applied: true, already_applied: true, persistent_files_written: 0, binding_file: path.basename(target) };
    }
  }
  const staged = target + `.staged-${process.pid}-${Date.now()}`;
  await fs.writeFile(staged, contents, { flag: "wx" });
  try {
    await promoteFilesWithRollback([{ staged, target }], async () => {});
  } catch (error) {
    await fs.rm(staged, { force: true });
    throw error;
  }
  return { applied: true, already_applied: false, persistent_files_written: 1, binding_file: path.basename(target) };
}

export async function runNotificationConnectorProfile({
  projectRoot = process.cwd(),
  configPath = ".job-search.local.json",
  profilePath,
  apply = false,
  approvalId = null,
} = {}) {
  if (!profilePath) throw new Error("Connector profile preview requires --profile");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const absoluteProfile = path.resolve(profilePath);
  const stat = await fs.stat(absoluteProfile);
  if (!stat.isFile() || stat.size > MAX_CONNECTOR_PROFILE_BYTES) {
    throw new Error(`Connector profile must be a file no larger than ${MAX_CONNECTOR_PROFILE_BYTES} bytes`);
  }
  const profile = JSON.parse(await fs.readFile(absoluteProfile, "utf8"));
  const preview = notificationConnectorProfilePreview(profile);
  let persistence = { applied: false, already_applied: false, persistent_files_written: 0, binding_file: null };
  if (apply) {
    persistence = await applyNotificationConnectorBinding({
      binding: preview.binding,
      approvalId,
      stateDirectory: config.stateDirectory,
    });
  }
  return {
    schema_version: 1,
    mode: apply ? "apply" : "preview",
    preview,
    persistence,
    endpoint_included: false,
    credential_included: false,
    external_delivery_performed: false,
  };
}

async function main() {
  const result = await runNotificationConnectorProfile({
    projectRoot: path.resolve(argumentValue(process.argv, "--project-root", process.cwd())),
    configPath: argumentValue(process.argv, "--config", ".job-search.local.json"),
    profilePath: argumentValue(process.argv, "--profile"),
    apply: process.argv.includes("--apply"),
    approvalId: argumentValue(process.argv, "--approve"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schema_version: 1,
      applied: false,
      external_delivery_performed: false,
      error: String(error?.message ?? error),
    }, null, 2));
    process.exitCode = 1;
  });
}
