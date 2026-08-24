import fs from "node:fs/promises";

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function promoteFilesWithRollback(replacements, commit) {
  if (!Array.isArray(replacements) || !replacements.length) throw new Error("At least one staged file is required");
  if (typeof commit !== "function") throw new Error("A commit callback is required");
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promoted = [];
  try {
    for (const [index, replacement] of replacements.entries()) {
      const staged = replacement?.staged;
      const target = replacement?.target;
      if (!staged || !target || staged === target) throw new Error(`Invalid staged replacement at index ${index}`);
      const backup = target + `.rollback-${nonce}`;
      const hadExisting = await exists(target);
      if (hadExisting) await fs.rename(target, backup);
      try {
        await fs.rename(staged, target);
      } catch (error) {
        if (hadExisting) await fs.rename(backup, target);
        throw error;
      }
      promoted.push({ target, backup, hadExisting });
    }
    await commit();
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...promoted].reverse()) {
      try {
        await fs.rm(item.target, { force: true });
        if (item.hadExisting) await fs.rename(item.backup, item.target);
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError?.stack ?? rollbackError));
      }
    }
    if (rollbackErrors.length) error.rollback_errors = rollbackErrors;
    throw error;
  }
  await Promise.allSettled(promoted.filter((item) => item.hadExisting).map((item) => fs.rm(item.backup, { force: true })));
}
