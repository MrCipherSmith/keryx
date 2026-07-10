import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
  options: { timeoutMs?: number; retryMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 30000;
  const startedAt = Date.now();

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
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

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const stats = await stat(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch {
    // Another process may have released the lock between mkdir attempts.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
