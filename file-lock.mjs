import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Cross-process lock via an exclusive lock file. Waiting yields to the event loop instead of
// blocking it; a lock older than staleMs is treated as abandoned.
export async function withFileLock(filePath, operation, { attempts = 100, delayMs = 10, staleMs = 30_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  let lock;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
      } catch {}
      await sleep(delayMs);
    }
  }
  if (lock === undefined) throw new Error("Writer-code registry is busy");
  try {
    return await operation();
  } finally {
    fs.closeSync(lock);
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}
