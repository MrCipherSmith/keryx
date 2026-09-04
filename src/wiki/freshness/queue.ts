// LWG-9 freshness queue (flow 226, phase 1).
//
// The hook's whole job is one appended line. It does not build the graph, does
// not call a model, and does not read the file back — a `post-commit` that
// slows `git commit` gets disabled, and then the entire mechanism is dead code
// that looks alive. Budget is 50 ms at p95 (flow 226 AC6).
//
// Everything expensive is deferred to the drain, which runs when someone asks
// for a report. That is the same pull-based shape as `src/sac/catch-up.ts`:
// accumulation is cheap and continuous, interpretation is expensive and on
// demand.

import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";

export const QUEUE_FILE = "freshness-queue.jsonl";
export const ROTATED_FILE = "freshness-queue.1.jsonl";
export const MAX_LINES = 10_000;
export const MAX_BYTES = 5 * 1024 * 1024;

export type QueueEvent = "post-commit" | "post-merge" | "post-checkout" | "manual";

export interface QueueEntry {
  schemaVersion: 1;
  event: QueueEvent;
  rev: string;
  previousRev?: string;
  recordedAt: string;
  paths: string[];
  truncated?: boolean;
  branch?: string;
}

export interface DrainResult {
  entries: QueueEntry[];
  /** Lines that could not be parsed. Reported, never fatal (AC14). */
  corruptLines: number;
  /** True when any entry was written with a capped path list. */
  truncated: boolean;
}

export function queuePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", QUEUE_FILE);
}

export function rotatedQueuePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", ROTATED_FILE);
}

/**
 * Read the queue, oldest first, tolerating damage.
 *
 * A corrupt line is skipped and counted, never thrown. The queue is written by
 * a shell hook that can be interrupted mid-append by a killed commit or a full
 * disk; a half-written line must cost that one revision, not the whole report.
 * The count is surfaced so a reader learns the drain was incomplete rather
 * than inferring a quiet repository.
 */
export async function drainQueue(cwd: string): Promise<DrainResult> {
  const entries: QueueEntry[] = [];
  let corruptLines = 0;
  let truncated = false;

  for (const file of [rotatedQueuePath(cwd), queuePath(cwd)]) {
    if (!(await pathExists(file))) {
      continue;
    }
    const raw = await readFile(file, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const entry = parseEntry(line);
      if (entry === null) {
        corruptLines += 1;
        continue;
      }
      if (entry.truncated) {
        truncated = true;
      }
      entries.push(entry);
    }
  }

  return { entries, corruptLines, truncated };
}

/** Remove the consumed queue files. Called only after a report is persisted. */
export async function clearQueue(cwd: string): Promise<void> {
  for (const file of [rotatedQueuePath(cwd), queuePath(cwd)]) {
    if (await pathExists(file)) {
      await unlink(file).catch(() => undefined);
    }
  }
}

/**
 * Append one entry. The TypeScript path exists for `--record` and for tests;
 * the hot path in production is the shell hook, which must not pay for a
 * runtime start-up.
 */
export async function appendEntry(cwd: string, entry: QueueEntry): Promise<void> {
  const file = queuePath(cwd);
  await rotateIfNeeded(cwd, file);
  const existing = (await pathExists(file)) ? await readFile(file, "utf8") : "";
  await writeFile(file, `${existing}${JSON.stringify(entry)}\n`, "utf8");
}

async function rotateIfNeeded(cwd: string, file: string): Promise<void> {
  if (!(await pathExists(file))) {
    return;
  }
  const info = await stat(file).catch(() => null);
  if (info === null) {
    return;
  }
  if (info.size < MAX_BYTES) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (raw.split("\n").length - 1 < MAX_LINES) {
      return;
    }
  }
  // One generation only. A queue nobody drains is already a symptom; keeping
  // ten generations of it would turn that symptom into a disk problem.
  await rename(file, rotatedQueuePath(cwd)).catch(() => undefined);
}

function parseEntry(line: string): QueueEntry | null {
  try {
    const value = JSON.parse(line) as Partial<QueueEntry>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.rev !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.rev) ||
      typeof value.recordedAt !== "string" ||
      !Array.isArray(value.paths)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      event: (value.event ?? "post-commit") as QueueEvent,
      rev: value.rev,
      recordedAt: value.recordedAt,
      paths: value.paths.filter((entry): entry is string => typeof entry === "string"),
      ...(value.previousRev ? { previousRev: value.previousRev } : {}),
      ...(value.truncated ? { truncated: true } : {}),
      ...(value.branch ? { branch: value.branch } : {}),
    };
  } catch {
    return null;
  }
}

/** Oldest revision in the drained set — the base a report should measure from. */
export function earliestRev(entries: readonly QueueEntry[]): string | undefined {
  const first = entries[0];
  if (!first) {
    return undefined;
  }
  // `previousRev` is the base of the FIRST recorded change; without it the
  // best available base is that revision's own parent, which the caller
  // resolves through git.
  return first.previousRev ?? first.rev;
}
