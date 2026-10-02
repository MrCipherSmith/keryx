// Flow 389 (AC4): the snapshot a digest run is compared with.
//
// After every run the digest stores `(id, updatedAt)` of everything it saw in
// `.metaproject/data/digest/<schedule>/snapshot.json`. The next run reads it back
// and lists only what differs. The first run has nothing to compare with: it is
// marked a BASELINE, lists no changes, and writes the snapshot.
//
// A source that FAILED this run (gh was down, a repo answered an error) must not
// look like "everything closed": its previous entries are carried over and it
// produces no "gone" entries. The next good run compares against them.
//
// The directory ignores itself (`.gitignore` with `*`), like the trigger data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, writeFileAtomic } from "../lib/fs";

export type DigestSourceKind = "pr" | "issue" | "review" | "ci" | "board";

/** One thing the digest saw. `key` is stable across runs: `<kind>:<repo>#<id>`, or `board:<intent id>`. */
export interface DigestItem {
  readonly key: string;
  readonly kind: DigestSourceKind;
  readonly repo?: string;
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  /** The stamp compared across runs: `updatedAt` (a failed run's `createdAt`, a board entry's `status|closedAt|verdict`). */
  readonly stamp: string;
  readonly author?: string;
  readonly draft?: boolean;
  readonly reviewDecision?: string;
}

export interface DigestSnapshot {
  readonly version: 1;
  readonly takenAt: string;
  /** item key -> stamp. */
  readonly entries: Readonly<Record<string, string>>;
}

export interface DigestDiff {
  /** True when there was no previous snapshot: nothing is reported as changed. */
  readonly baseline: boolean;
  readonly added: readonly DigestItem[];
  readonly updated: readonly DigestItem[];
  /** Keys that were in the previous snapshot and are not in this run's data (closed or merged). */
  readonly gone: readonly string[];
}

/** Sources whose disappearance is a change worth a line. A review or CI entry leaving the list is not. */
const REPORTS_GONE: ReadonlySet<DigestSourceKind> = new Set(["pr", "issue"]);

export function sourceOfKey(key: string): string {
  if (key.startsWith("board:")) return "board";
  const hash = key.indexOf("#");
  return hash === -1 ? key.slice(0, key.indexOf(":")) : key.slice(0, hash);
}

export function kindOfKey(key: string): DigestSourceKind {
  return key.slice(0, key.indexOf(":")) as DigestSourceKind;
}

/**
 * Compare this run's items with the previous snapshot.
 * `failedSources` names the sources (`pr:<repo>`, `board`, ...) that could not be read this run, or
 * that were read only in part (an answer of a full 100-row window): none of their previous entries is "gone".
 */
export function diffSnapshot(previous: DigestSnapshot | undefined, items: readonly DigestItem[], failedSources: ReadonlySet<string>): DigestDiff {
  if (previous === undefined) return { baseline: true, added: [], updated: [], gone: [] };
  const added: DigestItem[] = [];
  const updated: DigestItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(item.key);
    const before = previous.entries[item.key];
    if (before === undefined) added.push(item);
    else if (before !== item.stamp) updated.push(item);
  }
  const gone: string[] = [];
  for (const key of Object.keys(previous.entries)) {
    if (seen.has(key) || failedSources.has(sourceOfKey(key)) || !REPORTS_GONE.has(kindOfKey(key))) continue;
    gone.push(key);
  }
  return { baseline: false, added, updated, gone };
}

/** The snapshot to store after this run: this run's items, plus the previous entries of every source that failed or was read only in part. */
export function nextSnapshot(
  previous: DigestSnapshot | undefined,
  items: readonly DigestItem[],
  failedSources: ReadonlySet<string>,
  takenAt: string,
): DigestSnapshot {
  const entries: Record<string, string> = {};
  if (previous !== undefined) {
    for (const [key, stamp] of Object.entries(previous.entries)) {
      if (failedSources.has(sourceOfKey(key))) entries[key] = stamp;
    }
  }
  for (const item of items) entries[item.key] = item.stamp;
  return { version: 1, takenAt, entries };
}

export function digestDataDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "digest");
}

/** `.metaproject/data/digest/<schedule>`. The name is a schedule name, already restricted to a safe charset by the store. */
export function digestScheduleDir(projectRoot: string, name: string): string {
  return path.join(digestDataDir(projectRoot), name.replace(/[^A-Za-z0-9._-]/g, "-"));
}

export function snapshotPath(projectRoot: string, name: string): string {
  return path.join(digestScheduleDir(projectRoot, name), "snapshot.json");
}

/** Make `.metaproject/data/digest/` ignore everything in it. Idempotent. */
export async function ensureDigestDataIgnored(projectRoot: string): Promise<void> {
  const dir = digestDataDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(file, "# Scheduled digest state: snapshots, delivery queue, fired slots. Never committed.\n*\n!.gitignore\n", "utf8");
  }
}

function parseSnapshot(text: string): DigestSnapshot | undefined {
  try {
    const raw = JSON.parse(text) as { version?: unknown; takenAt?: unknown; entries?: unknown } | null;
    if (raw === null || raw.version !== 1 || typeof raw.takenAt !== "string") return undefined;
    if (typeof raw.entries !== "object" || raw.entries === null || Array.isArray(raw.entries)) return undefined;
    const entries: Record<string, string> = {};
    for (const [key, stamp] of Object.entries(raw.entries as Record<string, unknown>)) {
      if (typeof stamp === "string") entries[key] = stamp;
    }
    return { version: 1, takenAt: raw.takenAt, entries };
  } catch {
    return undefined;
  }
}

/** The stored snapshot, or `undefined` when there is none or it is unreadable (the run is then a baseline again). */
export async function readSnapshot(projectRoot: string, name: string): Promise<DigestSnapshot | undefined> {
  try {
    return parseSnapshot(await readFile(snapshotPath(projectRoot, name), "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
}

export async function writeSnapshot(projectRoot: string, name: string, snapshot: DigestSnapshot): Promise<void> {
  await ensureDigestDataIgnored(projectRoot);
  await writeFileAtomic(snapshotPath(projectRoot, name), `${JSON.stringify(snapshot, null, 2)}\n`);
}
