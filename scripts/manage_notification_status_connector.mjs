import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteFilesWithRollback } from "./file_transaction.mjs";
import {
  MAX_NOTIFICATION_STATUS_PROFILE_BYTES,
  notificationStatusProfilePreview,
  validateNotificationStatusBinding,
} from "./notification_status_runtime.mjs";
import { argumentValue, loadProjectConfig } from "./project_config.mjs";

function safeSlug(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text)) throw new Error(`${label} is not a safe opaque slug`);
  return text;
}

function contained(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function notificationStatusBindingPath(stateDirectory, binding) {
  validateNotificationStatusBinding(binding);
  return path.join(
    path.resolve(stateDirectory),
    "notifications",
    "status-connectors",
    `${safeSlug(binding.profile_id, "Notification status profile_id")}.binding.json`,
  );
}

export async function applyNotificationStatusBinding({ binding, approvalId, stateDirectory } = {}) {
  validateNotificationStatusBinding(binding);
  if (approvalId !== binding.approval_id) {
    throw new Error("Notification status binding import requires the exact preview approval ID");
  }
  const target = notificationStatusBindingPath(stateDirectory, binding);
  const contents = JSON.stringify(binding, null, 2) + "\n";
  const state = path.resolve(stateDirectory);
  const stateStat = await fs.lstat(state);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Notification status state directory must be a regular private directory");
  }
  const notificationsDirectory = path.join(state, "notifications");
  try {
    const notificationsStat = await fs.lstat(notificationsDirectory);
    if (!notificationsStat.isDirectory() || notificationsStat.isSymbolicLink()) {
      throw new Error("Notification status notifications directory must be a regular private directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(notificationsDirectory);
  }
  try {
    const targetDirectoryStat = await fs.lstat(path.dirname(target));
    if (!targetDirectoryStat.isDirectory() || targetDirectoryStat.isSymbolicLink()) {
      throw new Error("Notification status binding directory must be a regular private directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(target));
  }
  const targetDirectoryStat = await fs.lstat(path.dirname(target));
  if (!targetDirectoryStat.isDirectory() || targetDirectoryStat.isSymbolicLink()) {
    throw new Error("Notification status binding directory must be a regular private directory");
  }
  const [realTargetDirectory, realStateDirectory] = await Promise.all([
    fs.realpath(path.dirname(target)), fs.realpath(stateDirectory),
  ]);
  if (!contained(realTargetDirectory, realStateDirectory)) {
    throw new Error("Notification status binding directory cannot escape private state through a symbolic link");
  }
  if (await fileExists(target)) {
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("Existing notification status binding must be a regular private file");
    }
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

export async function runNotificationStatusProfile({
  projectRoot = process.cwd(), configPath = ".job-search.local.json", profilePath, apply = false, approvalId = null,
} = {}) {
  if (!profilePath) throw new Error("Notification status profile preview requires --profile");
  const config = await loadProjectConfig({ projectRoot, configPath });
  const profilesDirectory = path.join(config.stateDirectory, "notification-status-connectors");
  const absoluteProfile = path.resolve(profilePath);
  if (!contained(absoluteProfile, profilesDirectory)) {
    throw new Error("Notification status profile must remain under the configured private state directory");
  }
  const stat = await fs.lstat(absoluteProfile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NOTIFICATION_STATUS_PROFILE_BYTES) {
    throw new Error(`Notification status profile must be a regular file no larger than ${MAX_NOTIFICATION_STATUS_PROFILE_BYTES} bytes`);
  }
  const [realProfile, realProfilesDirectory, realStateDirectory] = await Promise.all([
    fs.realpath(absoluteProfile), fs.realpath(profilesDirectory), fs.realpath(config.stateDirectory),
  ]);
  if (!contained(realProfile, realProfilesDirectory) || !contained(realProfilesDirectory, realStateDirectory)) {
    throw new Error("Notification status profile cannot escape private state through a symbolic link");
  }
  const profile = JSON.parse(await fs.readFile(absoluteProfile, "utf8"));
  const preview = notificationStatusProfilePreview(profile);
  if (path.basename(absoluteProfile) !== `${preview.profile_id}.status-profile.json`) {
    throw new Error("Notification status profile filename must match profile_id as <profile_id>.status-profile.json");
  }
  let persistence = { applied: false, already_applied: false, persistent_files_written: 0, binding_file: null };
  if (apply) {
    persistence = await applyNotificationStatusBinding({
      binding: preview.binding, approvalId, stateDirectory: config.stateDirectory,
    });
  }
  return {
    schema_version: 1,
    mode: apply ? "apply" : "preview",
    preview,
    persistence,
    endpoint_included: false,
    credential_included: false,
    credential_environment_name_included: false,
    network_accessed: false,
    external_delivery_performed: false,
  };
}

async function main() {
  const result = await runNotificationStatusProfile({
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
      state_written: false,
      network_accessed: false,
      external_delivery_performed: false,
      error: String(error?.message ?? error),
    }, null, 2));
    process.exitCode = 1;
  });
}
