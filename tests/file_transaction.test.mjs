import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promoteFilesWithRollback } from "../scripts/file_transaction.mjs";

test("restores prior files when the final commit fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-file-transaction-"));
  const firstTarget = path.join(directory, "packet.json");
  const secondTarget = path.join(directory, "responses.md");
  const firstStaged = path.join(directory, "packet.staged");
  const secondStaged = path.join(directory, "responses.staged");
  await fs.writeFile(firstTarget, "old packet");
  await fs.writeFile(secondTarget, "old responses");
  await fs.writeFile(firstStaged, "new packet");
  await fs.writeFile(secondStaged, "new responses");

  await assert.rejects(promoteFilesWithRollback([
    { staged: firstStaged, target: firstTarget },
    { staged: secondStaged, target: secondTarget },
  ], async () => { throw new Error("workbook commit failed"); }), /workbook commit failed/);

  assert.equal(await fs.readFile(firstTarget, "utf8"), "old packet");
  assert.equal(await fs.readFile(secondTarget, "utf8"), "old responses");
  assert.equal((await fs.readdir(directory)).some((name) => name.includes(".rollback-")), false);
});

test("promotes all staged files after a successful commit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-file-transaction-"));
  const target = path.join(directory, "packet.json");
  const staged = path.join(directory, "packet.staged");
  await fs.writeFile(staged, "new packet");
  let committed = false;
  await promoteFilesWithRollback([{ staged, target }], async () => { committed = true; });
  assert.equal(committed, true);
  assert.equal(await fs.readFile(target, "utf8"), "new packet");
  assert.equal((await fs.readdir(directory)).some((name) => name.includes(".rollback-")), false);
});
