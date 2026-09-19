// Agent bus storage paths (specification §2.1, decisions D-02).
//
//   <git-common-dir>/keryx/bus/<project-key>/
//     presence/<instanceId>.json
//     leases/<leaseId>.json
//     events.jsonl            current segment
//     events.<n>.jsonl        rotated segments
//     head.json               { seq, segment, segmentInode }
//     append.lock/            withFileLock directory
//
// This module does no file I/O of its own. `config-dir.readers.test.ts` and
// `config-dir.writers.test.ts` flag any file that both names a data-dir
// resolver and makes a raw fs call; the one resolver call lives here and every
// read and write lives in the sibling modules. The git lookups and the
// realpath are delegated to `src/lib/clone-scope.ts`.

import path from "node:path";
import { canonicalPath, gitCommonDir, gitToplevel } from "../lib/clone-scope";
import { keryxDataDir, projectKeyFromPath, resolveProjectRoot } from "../session/paths";
import { BusRefusal } from "./errors";

export type BusRootKind = "git" | "data-dir";

export interface BusRoot {
  /** Absolute bus directory. */
  root: string;
  /** `<project-key>`: the project path inside the repo, slugified, or `root`. */
  projectKey: string;
  kind: BusRootKind;
}

/** What `busRootFor` needs; all paths absolute and already canonical. */
export interface BusRootInput {
  commonDir: string | null;
  toplevel: string | null;
  projectRoot: string;
  /** Data-dir override for the non-git fallback; defaults to `keryxDataDir()`. */
  dataDir?: string | undefined;
}

/**
 * Filesystem-safe key for a project path inside a repository. A local copy of
 * the flow store's slug rule (`src/flow` is not imported from the bus), with
 * `root` rather than `flow` as the empty fallback.
 */
export function slugifyProjectPath(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "root"
  );
}

/** Pure: the bus root for already-resolved clone facts. */
export function busRootFor(input: BusRootInput): BusRoot {
  if (input.commonDir === null) {
    const projectKey = projectKeyFromPath(input.projectRoot);
    return { root: path.join(keryxDataDir(input.dataDir), "bus", projectKey), projectKey, kind: "data-dir" };
  }
  const relative = input.toplevel === null ? "" : path.relative(input.toplevel, input.projectRoot);
  const projectKey = relative === "" ? "root" : slugifyProjectPath(relative);
  return { root: path.join(input.commonDir, "keryx", "bus", projectKey), projectKey, kind: "git" };
}

/**
 * The bus root for `cwd`. The key comes from `resolveProjectRoot(cwd)`, not the
 * raw cwd, so a shell started in a subdirectory joins the same bus, and every
 * linked worktree of one clone shares the git common directory.
 */
export async function resolveBusRoot(cwd: string, options: { dataDir?: string | undefined } = {}): Promise<BusRoot> {
  const commonDir = await gitCommonDir(cwd);
  const projectRoot = await canonicalPath(resolveProjectRoot(cwd));
  if (commonDir === null) {
    return busRootFor({ commonDir: null, toplevel: null, projectRoot, dataDir: options.dataDir });
  }
  const toplevel = await gitToplevel(cwd);
  return busRootFor({
    commonDir: await canonicalPath(commonDir),
    toplevel: toplevel === null ? null : await canonicalPath(toplevel),
    projectRoot,
    dataDir: options.dataDir,
  });
}

// ---------------------------------------------------------------------------
// Ids. Paths built from bus data accept UUID-shaped values only (§9.4), checked
// here, before any path is joined — the one choke point, as external slates do.
// ---------------------------------------------------------------------------

export const BUS_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBusId(value: unknown): value is string {
  return typeof value === "string" && BUS_UUID_PATTERN.test(value);
}

export function assertBusId(id: unknown, label = "id"): asserts id is string {
  if (!isBusId(id)) {
    throw new BusRefusal("invalid-id", `${label} ${JSON.stringify(id)} is not a UUID`);
  }
}

// ---------------------------------------------------------------------------
// Path builders.
// ---------------------------------------------------------------------------

export const PRESENCE_DIR = "presence";
export const LEASES_DIR = "leases";
export const CURRENT_SEGMENT_FILE = "events.jsonl";
export const HEAD_FILE = "head.json";
export const APPEND_LOCK_DIR = "append.lock";

const ROTATED_SEGMENT_PATTERN = /^events\.(\d{1,9})\.jsonl$/;

export function presenceDir(root: string): string {
  return path.join(root, PRESENCE_DIR);
}

export function presencePath(root: string, instanceId: string): string {
  assertBusId(instanceId, "instanceId");
  return path.join(root, PRESENCE_DIR, `${instanceId}.json`);
}

export function leasesDir(root: string): string {
  return path.join(root, LEASES_DIR);
}

export function leasePath(root: string, leaseId: string): string {
  assertBusId(leaseId, "leaseId");
  return path.join(root, LEASES_DIR, `${leaseId}.json`);
}

export function eventsPath(root: string): string {
  return path.join(root, CURRENT_SEGMENT_FILE);
}

export function rotatedSegmentPath(root: string, segment: number): string {
  if (!Number.isSafeInteger(segment) || segment < 1) {
    throw new BusRefusal("invalid-id", `segment ${JSON.stringify(segment)} is not a positive integer`);
  }
  return path.join(root, `events.${segment}.jsonl`);
}

/** The segment number of a rotated segment's file name, or undefined. */
export function parseRotatedSegmentName(fileName: string): number | undefined {
  const match = ROTATED_SEGMENT_PATTERN.exec(fileName);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return value >= 1 ? value : undefined;
}

export function headPath(root: string): string {
  return path.join(root, HEAD_FILE);
}

export function appendLockPath(root: string): string {
  return path.join(root, APPEND_LOCK_DIR);
}

/** The id a `presence/` or `leases/` file name carries, or undefined. */
export function idFromRecordFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(".json")) return undefined;
  const id = fileName.slice(0, -".json".length);
  return isBusId(id) ? id : undefined;
}
