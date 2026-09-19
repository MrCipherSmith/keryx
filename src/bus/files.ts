// File I/O shared by the bus modules: owner-only directories and files
// (specification §2.1 and §9.7: directories 0700, files 0600) and tolerant
// reads. Paths come from `./paths`, which validates every id first.

import { chmod, mkdir, open, readdir, rm } from "node:fs/promises";
import { isNotFound, writeFileAtomic } from "../lib/fs";

export const BUS_DIR_MODE = 0o700;
export const BUS_FILE_MODE = 0o600;

/** Records larger than this are not bus records; they are skipped unread. */
export const MAX_RECORD_BYTES = 64 * 1024;

/**
 * Create `dir` (and missing parents) and force it 0700. `mkdir`'s mode applies
 * at creation only and is filtered by the umask, so the chmod is unconditional.
 */
export async function ensureBusDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: BUS_DIR_MODE });
  if (process.platform !== "win32") await chmod(dir, BUS_DIR_MODE);
}

/** Atomic owner-only write: temp file 0600 beside `file`, then rename. */
export async function writeBusFileAtomic(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, { mode: BUS_FILE_MODE });
}

/** Parsed JSON of `file`, or undefined when it is missing, too large, unreadable or not JSON. */
export async function readJsonRecord(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) return undefined;
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Entry names of `dir`, or [] when it does not exist. */
export async function listDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}
