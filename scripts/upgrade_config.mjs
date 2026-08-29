import fs from "node:fs/promises";
import path from "node:path";
import { argumentValue, CURRENT_CONFIG_VERSION, LOCAL_CONFIG_NAME, resolveProjectPath, upgradeProjectConfig } from "./project_config.mjs";

function compactTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-");
}

export async function upgradeConfigFile({ projectRoot = process.cwd(), configPath = LOCAL_CONFIG_NAME, apply = false } = {}) {
  const absoluteRoot = path.resolve(projectRoot);
  const absoluteConfigPath = resolveProjectPath(absoluteRoot, configPath);
  const raw = JSON.parse(await fs.readFile(absoluteConfigPath, "utf8"));
  const upgrade = upgradeProjectConfig(raw);
  const result = {
    mode: apply ? "apply" : "preview",
    config_path: absoluteConfigPath,
    from_version: upgrade.from_version,
    to_version: upgrade.to_version,
    current_version: CURRENT_CONFIG_VERSION,
    changed: upgrade.changed,
    changes: upgrade.changes,
    backup_path: null,
    initialized_artifacts: [],
  };
  if (!apply || !upgrade.changed) return result;

  const stateDirectory = resolveProjectPath(absoluteRoot, upgrade.config.state_directory);
  const backupDirectory = path.join(stateDirectory, "config-backups");
  const backupPath = path.join(backupDirectory, `job-search.local.v${upgrade.from_version}.${compactTimestamp()}.json`);
  const temporaryPath = absoluteConfigPath + ".upgrade-tmp";
  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.writeFile(backupPath, JSON.stringify(raw, null, 2) + "\n", { flag: "wx" });
  try {
    const directories = [
      upgrade.config.resumes_directory,
      upgrade.config.state_directory,
      upgrade.config.application_packages_directory,
    ].map((value) => resolveProjectPath(absoluteRoot, value));
    for (const directory of directories) {
      await fs.mkdir(directory, { recursive: true });
    }
    for (const [field, template] of [
      ["search_terms_path", "search-terms.template.json"],
      ["eligibility_evidence_path", "eligibility-evidence.template.json"],
    ]) {
      const target = resolveProjectPath(absoluteRoot, upgrade.config[field]);
      try {
        await fs.access(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(absoluteRoot, "templates", template), target, fs.constants.COPYFILE_EXCL);
        result.initialized_artifacts.push(target);
      }
    }
    await fs.writeFile(temporaryPath, JSON.stringify(upgrade.config, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temporaryPath, absoluteConfigPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  result.backup_path = backupPath;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const result = await upgradeConfigFile({
    projectRoot: argumentValue(process.argv, "--project-root", process.cwd()),
    configPath: argumentValue(process.argv, "--config", LOCAL_CONFIG_NAME),
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
}
