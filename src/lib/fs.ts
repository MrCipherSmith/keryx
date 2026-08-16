import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Generic Node fs-error predicate: true when `error` is an ENOENT (not found). */
export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number; staleMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 30000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(staleMs / 3));
  const startedAt = Date.now();
  const owner = { pid: process.pid, token: randomUUID() };
  const ownerPath = path.join(lockPath, "owner.json");

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await delay(retryMs);
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (await ownsLock(ownerPath, owner.token)) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs <= staleMs) return;
    const owner = await readLockOwner(path.join(lockPath, "owner.json"));
    if (owner && processIsAlive(owner.pid)) return;
    const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
  } catch {
    // Another process may have released the lock between mkdir attempts.
  }
}

async function readLockOwner(ownerPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string"
      ? { pid: Number(value.pid), token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

async function ownsLock(ownerPath: string, token: string): Promise<boolean> {
  return (await readLockOwner(ownerPath))?.token === token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
