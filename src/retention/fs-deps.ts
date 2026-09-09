// Filesystem seam for the retention sweep (flow 237 phase 5, T8).
//
// Injected rather than imported directly by `sweep.ts` for one reason: the
// "unreachable store" behaviour AC-29 requires (incomplete, never a silent
// success) has to be exercised in tests without depending on OS-level
// permission tricks, which are unreliable across platforms and outright
// ineffective when the test runner is root. A fake `RetentionFsDeps` that
// throws on command lets the failure path be tested directly.

import { readdir as fsReaddir, rm as fsRm, stat as fsStat } from "node:fs/promises";
import path from "node:path";

export type RetentionUnit = "file" | "directory";

export interface RetentionEntryStat {
  /** File size in bytes, or — for a directory unit — its recursive total. */
  bytes: number;
  /** The entry's own mtime, in milliseconds since epoch. */
  mtimeMs: number;
}

export interface RetentionFsDeps {
  /** Non-recursive directory listing (names only). Rejects exactly like `fs.readdir`. */
  readdir(dir: string): Promise<string[]>;
  /** Size and age of one entry. Recurses when `unit` is `"directory"`. Rejects on an unreadable entry. */
  statEntry(entryPath: string, unit: RetentionUnit): Promise<RetentionEntryStat>;
  /** Permanently remove one entry. Rejects on failure — never swallows an error itself; the caller decides what a failure means. */
  remove(entryPath: string, unit: RetentionUnit): Promise<void>;
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const names = await fsReaddir(dir);
  for (const name of names) {
    const full = path.join(dir, name);
    const info = await fsStat(full);
    total += info.isDirectory() ? await directoryBytes(full) : info.size;
  }
  return total;
}

/** Render an unknown caught value as a short, stable string: an `Error` with a
 * Node error `code` reports the code (`"EACCES"`), otherwise the message. Used
 * everywhere this module reports WHY a store was unreachable, so a reason
 * string is something a reader can act on rather than `"[object Object]"`. */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : String(error);
}

export const defaultFsDeps: RetentionFsDeps = {
  readdir: (dir) => fsReaddir(dir),
  statEntry: async (entryPath, unit) => {
    const info = await fsStat(entryPath);
    const bytes = unit === "directory" ? await directoryBytes(entryPath) : info.size;
    return { bytes, mtimeMs: info.mtimeMs };
  },
  remove: async (entryPath, unit) => {
    await fsRm(entryPath, { recursive: unit === "directory", force: false });
  },
};
