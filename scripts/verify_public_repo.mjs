import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isBlockedPublicPath, publicContentViolations } from "./public_repo_privacy.mjs";

const staged = process.argv.includes("--staged");
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || "Git command failed: git " + args.join(" "));
  return result.stdout;
}

const names = (staged
  ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  : git(["ls-files", "--cached", "--others", "--exclude-standard"]))
  .split("\n").map((value) => value.trim()).filter(Boolean);
const violations = [];
for (const name of names) {
  if (isBlockedPublicPath(name)) violations.push(name + ": private or generated artifact path");
  if (/\.(png|jpg|jpeg|gif|zip)$/i.test(name)) continue;
  const content = staged
    ? git(["show", ":" + name])
    : existsSync(name)
      ? readFileSync(name, "utf8")
      : git(["show", "HEAD:" + name]);
  for (const label of publicContentViolations(content, { fileName: name })) violations.push(name + ": " + label);
}
if (violations.length) {
  console.error("Public-repository verification failed:\n- " + [...new Set(violations)].join("\n- "));
  process.exit(1);
}
console.log(JSON.stringify({ verified: true, mode: staged ? "staged" : "working-tree", files_checked: names.length }, null, 2));
