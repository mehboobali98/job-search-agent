import fs from "node:fs/promises";
import path from "node:path";
import { buildReplaySnapshot } from "./run_replay_lib.mjs";
import { argumentValue } from "./project_config.mjs";

const inputArgument = argumentValue(process.argv, "--input");
const outputArgument = argumentValue(process.argv, "--output");
if (!inputArgument) throw new Error("Usage: node scripts/replay_run.mjs --input <run.json> [--output <snapshot.json>]");
const inputPath = path.resolve(inputArgument);
const snapshot = buildReplaySnapshot(JSON.parse(await fs.readFile(inputPath, "utf8")));
if (outputArgument) {
  const outputPath = path.resolve(outputArgument);
  if (inputPath === outputPath) throw new Error("Replay output must be distinct from input");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = outputPath + `.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n");
  await fs.rename(temporaryPath, outputPath);
}
console.log(JSON.stringify(snapshot, null, 2));
