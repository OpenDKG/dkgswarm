import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

function sameFile(expected, current) {
  return expected.dev === current.dev && expected.ino === current.ino && current.isFile();
}

function unlinkOwned(path, identity) {
  try {
    if (sameFile(identity, fs.lstatSync(path))) fs.unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function ownerIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function isStaleLock(identity, staleMs) {
  return identity.isFile() && identity.size <= 128 && Date.now() - identity.mtimeMs > staleMs;
}

function reapStaleLock(lockPath, staleMs) {
  const candidate = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!candidate || !isStaleLock(candidate, staleMs)) return;
  const reaperPath = `${lockPath}.reap`;
  let reaper;
  try {
    reaper = fs.openSync(reaperPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return;
  }
  const reaperIdentity = fs.fstatSync(reaper);
  try {
    // Serialize reapers so another one cannot unlink the next owner's lock.
    const identity = fs.lstatSync(lockPath);
    if (!sameFile(candidate, identity) || !isStaleLock(identity, staleMs)) return;
    const observed = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!sameFile(identity, fs.fstatSync(observed))) return;
      const buffer = Buffer.alloc(128);
      const size = fs.readSync(observed, buffer, 0, buffer.length, 0);
      const owner = /^(\d+) ([0-9a-f-]{36})\n$/.exec(buffer.toString("utf8", 0, size));
      const pid = Number(owner?.[1]);
      if (Number.isSafeInteger(pid) && pid > 0 && ownerIsDead(pid)) unlinkOwned(lockPath, identity);
    } finally {
      fs.closeSync(observed);
    }
  } catch (error) {
    if (!["ENOENT", "ELOOP"].includes(error.code)) throw error;
  } finally {
    try {
      unlinkOwned(reaperPath, reaperIdentity);
    } finally {
      fs.closeSync(reaper);
    }
  }
}

// Exclusive lock on a local filesystem. Allow time for the owner to write its
// identity, and only reclaim a stale lock whose owning process has exited.
export async function withFileLock(filePath, operation, { attempts = 100, delayMs = 10, staleMs = 30_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  let lock;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reapStaleLock(lockPath, staleMs);
      await sleep(delayMs);
    }
  }
  if (lock === undefined) throw new Error("Writer-code registry is busy");
  const identity = fs.fstatSync(lock);
  try {
    fs.writeFileSync(lock, `${process.pid} ${randomUUID()}\n`);
    return await operation();
  } finally {
    try {
      unlinkOwned(lockPath, identity);
    } finally {
      fs.closeSync(lock);
    }
  }
}
