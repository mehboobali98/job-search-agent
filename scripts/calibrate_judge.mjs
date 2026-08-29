import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argumentValue } from "./project_config.mjs";
import { evaluateJudgeCalibration, prepareCalibrationPacket } from "./judge_calibration_lib.mjs";

async function main() {
  const projectRoot = path.resolve(argumentValue(process.argv, "--project-root", process.cwd()));
  const fixturePath = path.resolve(argumentValue(process.argv, "--fixtures", path.join(projectRoot, "fixtures/judge-calibration.json")));
  const fixtures = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const inputPath = argumentValue(process.argv, "--input");
  if (!inputPath) {
    console.log(JSON.stringify(prepareCalibrationPacket(fixtures), null, 2));
    return;
  }
  const results = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
  const report = evaluateJudgeCalibration(fixtures, results);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "Passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
