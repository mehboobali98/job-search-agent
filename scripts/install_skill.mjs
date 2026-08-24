import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { argumentValue } from "./project_config.mjs";

const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
const source = path.join(projectRoot, "skill/job-search");
const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
const destination = path.resolve(argumentValue(process.argv, "--destination", path.join(codexHome, "skills/job-search")));
const temporary = destination + ".installing";
const backup = destination + ".previous";
await fs.access(path.join(source, "SKILL.md"));
await fs.rm(temporary, { recursive: true, force: true });
await fs.cp(source, temporary, { recursive: true });
let hadExisting = false;
try {
  await fs.access(destination);
  hadExisting = true;
  await fs.rm(backup, { recursive: true, force: true });
  await fs.rename(destination, backup);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(temporary, destination);
  if (hadExisting) await fs.rm(backup, { recursive: true, force: true });
} catch (error) {
  if (hadExisting) {
    try { await fs.rename(backup, destination); } catch { /* Keep the original backup for manual recovery. */ }
  }
  throw error;
}
console.log(JSON.stringify({ installed: true, destination }, null, 2));
