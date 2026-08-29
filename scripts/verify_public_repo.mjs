import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

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
const blockedPaths = [
  /^\.job-search\.local\.json$/,
  /^Job_Application_Tracker\.xlsx$/i,
  /^profile\/candidate-profile\.md$/,
  /^profile\/search-terms\.json$/,
  /^profile\/eligibility-evidence\.json$/,
  /^profile\/resumes\//,
  /^state\//,
  /^application-packages\//,
  /^renders?\//,
  /\.inspect\.ndjson$/i,
  /\.(xlsx|xls|pdf|docx)$/i,
];
const violations = [];
for (const name of names) {
  if (blockedPaths.some((pattern) => pattern.test(name))) violations.push(name + ": private or generated artifact path");
  if (/\.(png|jpg|jpeg|gif|zip)$/i.test(name)) continue;
  const content = staged
    ? git(["show", ":" + name])
    : existsSync(name)
      ? readFileSync(name, "utf8")
      : git(["show", "HEAD:" + name]);
  const patterns = [
    [/\/(Users|home)\/[^/\s]+\//, "absolute home-directory path"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "email address"],
    [/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i, "possible secret"],
    [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  ];
  for (const [pattern, label] of patterns) if (pattern.test(content)) violations.push(name + ": " + label);
}
if (violations.length) {
  console.error("Public-repository verification failed:\n- " + [...new Set(violations)].join("\n- "));
  process.exit(1);
}
console.log(JSON.stringify({ verified: true, mode: staged ? "staged" : "working-tree", files_checked: names.length }, null, 2));
