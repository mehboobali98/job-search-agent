import fs from "node:fs/promises";
import path from "node:path";
import { buildReplaySnapshot, compareReplaySnapshots } from "./run_replay_lib.mjs";
import { argumentValue } from "./project_config.mjs";

const stateDir = path.resolve(argumentValue(process.argv, "--state-dir", "state"));
function runPath(fileFlag, runFlag) {
  const direct = argumentValue(process.argv, fileFlag);
  if (direct) return path.resolve(direct);
  const runId = argumentValue(process.argv, runFlag);
  if (!runId) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(runId)) throw new Error(runFlag + " has an invalid format");
  return path.join(stateDir, "runs", encodeURIComponent(runId) + ".input.json");
}
const beforePath = runPath("--before", "--before-run");
const afterPath = runPath("--after", "--after-run");
if (!beforePath || !afterPath) throw new Error("Usage: node scripts/compare_runs.mjs (--before <run.json>|--before-run <id>) (--after <run.json>|--after-run <id>) [--state-dir <dir>]");
const before = buildReplaySnapshot(JSON.parse(await fs.readFile(beforePath, "utf8")));
const after = buildReplaySnapshot(JSON.parse(await fs.readFile(afterPath, "utf8")));
console.log(JSON.stringify(compareReplaySnapshots(before, after), null, 2));
