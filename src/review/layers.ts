// Metaproject layers for a managed review (flow 431).
//
// Before a reviewer reads a diff, the graph, the wiki and the memory index are
// brought up to date, with no model and no operator step. This module owns that
// refresh and the `layers.json` it leaves in the review package.
//
// Three rules shape it:
//   * No model. The refresh runs `gdgraph build`, `wiki refresh` and `memory
//     index` only. `wiki enrich` is the one model step in the wiki and is never
//     reachable from here (`layers-no-model.test.ts` walks the import closure).
//   * Nothing outside the package changes. The graph is built into the
//     package's own directory, so the tracked `.provenance.json` and
//     `artifacts/*` of the review worktree are never rewritten. The wiki refresh
//     runs as a dry run unless `writeWiki` is asked for, because it would
//     otherwise rewrite tracked wiki pages in the operator's working copy.
//   * A graph from another commit is never read. The commit a graph was built
//     from is recorded next to it, and a reader that finds it differing from the
//     PR head gets a refusal, not a stale answer.
//
// One refresh runs per package at a time (a lock beside the graph), the graph is
// built into a staging directory and renamed into place, and `layers.json` is
// written atomically, so a reader never meets a half-built graph. A reader that
// finds the lock held treats the package as not ready.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildGraph } from "../gdgraph/build";
import { isLockHeld, withFileLock, writeFileAtomic } from "../lib/fs";
import { assertGitRevision } from "../lib/git-revision";
import { shellWord } from "../lib/shell-quote";
import { loadGraph } from "../gdgraph/query";
import type { GraphData } from "../gdgraph/types";
import { createMemoryService } from "../memory/service";
import { refreshPages, type RefreshInput, type RefreshResult } from "../wiki/refresh";
import { HEAD_NOT_REQUESTED } from "../wiki/staleness";
import { previewFreshness, type PreviewFreshnessInput } from "../wiki/freshness/run";
import type { FreshnessReport } from "../wiki/freshness/report";
import { readJsonFileOr } from "../lib/json";

const execFileAsync = promisify(execFile);

export const LAYERS_FILE = "layers.json";
export const LAYERS_VERSION = 1;
const LAYERS_DIR = "layers";
const GRAPH_DIR = "graph";
const GRAPH_BUILD_FILE = "build.json";
const MEMORY_DIR = "memory";
const LOCK_NAME = "refresh.lock";
const MANIFEST_FILE = "manifest.json";
const LOCK_STALE_MS = 60_000;
// A refresh scales with the repository and the TUI lets its child run 15 minutes; the lock is
// heartbeat-based, so a waiter waits as long as the holder is alive instead of failing early.
const LOCK_WAIT_MS = 16 * 60_000;
const WORKTREE_PREFIX = "keryx-layers-";
const WORKTREE_SWEEP_AGE_MS = 30 * 60_000;
/** A graph build that failed at a head is not retried at that head inside this window unless the refresh is forced. */
const FAILED_RETRY_WINDOW_MS = 5 * 60_000;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
/** The most a signal waits for registered cleanups before it removes the lock and re-raises. */
const SIGNAL_CLEANUP_MAX_MS = 5_000;
const WIKI_PATH_PREFIX = ".metaproject/wiki";
const MEMORY_PATH_PREFIX = ".metaproject/memory";

export type LayerStatus = "ok" | "failed" | "skipped";

export interface Divergence {
  /** `none` when the working copy is at the PR head; `unknown` when git could not compare. */
  state: "none" | "differs" | "unknown";
  workingCopyCommit: string | null;
  prHead: string;
  commitsBetween: number | null;
  changedPaths: string[];
}

export interface GraphLayerRecord {
  status: LayerStatus;
  commit: string | null;
  builtAt: string | null;
  nodes: number;
  edges: number;
  error?: string;
  /** When a failed build ended; the retry window runs from here, so a refresh that keeps this record does not extend it. */
  failedAt?: string;
}

export interface WikiLayerRecord {
  status: LayerStatus;
  commit: string | null;
  builtAt: string | null;
  /** Pages the refresh regenerated, or would have when `written` is false. */
  pagesRefreshed: number;
  /** Pages whose prose is behind the PR's changes; `null` when it could not be measured. */
  pagesStaleProse: number | null;
  written: boolean;
  divergence: Divergence;
  error?: string;
}

export interface MemoryLayerRecord {
  status: LayerStatus;
  commit: string | null;
  builtAt: string | null;
  entries: number;
  divergence: Divergence;
  error?: string;
}

/** Where `prHead` came from: the caller, the package manifest's `target.head`, or the checkout's HEAD. */
export type HeadSource = "input" | "manifest" | "checkout";

export interface LayersFile {
  version: typeof LAYERS_VERSION;
  refreshedAt: string;
  prHead: string | null;
  headSource?: HeadSource;
  base: string | null;
  /** The commit the package graph was built from. Equals `prHead` or the graph layer is `failed`. */
  graphCommit: string | null;
  graph: GraphLayerRecord;
  wiki: WikiLayerRecord;
  memory: MemoryLayerRecord;
}

export interface LayerDeps {
  /** Trimmed stdout of `git <args>` in `cwd`, or `null` when git failed. */
  git(cwd: string, args: string[]): Promise<string | null>;
  buildGraph(projectRoot: string, options: { dataDir?: string }): Promise<{ nodes: number; edges: number }>;
  refreshWiki(input: RefreshInput): Promise<RefreshResult>;
  previewFreshness(input: PreviewFreshnessInput): Promise<FreshnessReport>;
  indexMemory(cwd: string, indexDir: string): Promise<{ entryCount: number }>;
  /** Writes `layers.json`; a test replaces it to stop the refresh in its last phase. */
  writeLayers(file: string, text: string): Promise<void>;
  now(): Date;
}

export const defaultLayerDeps: LayerDeps = {
  async git(cwd, args) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return null;
    }
  },
  async buildGraph(projectRoot, options) {
    const result = await buildGraph(projectRoot, options);
    return { nodes: result.nodes, edges: result.edges };
  },
  refreshWiki: refreshPages,
  previewFreshness,
  async indexMemory(cwd, indexDir) {
    return createMemoryService().index({ cwd, embeddings: false, indexDir });
  },
  writeLayers: writeFileAtomic,
  now: () => new Date(),
};

export interface RefreshLayersInput {
  /** The operator's project: wiki and memory are read from its working copy. */
  projectRoot: string;
  /** The review package directory (`.metaproject/reviews/<id>`). */
  packageDir: string;
  /** The checkout the PR head is at. Defaults to `projectRoot`. */
  reviewRoot?: string;
  /** The commit reviewed. Defaults to HEAD of `reviewRoot`. */
  prHead?: string;
  /** Base of the PR; the wiki staleness range is `base..prHead`. Defaults to the manifest's target ref, else `prHead~1`. */
  base?: string;
  /** Rebuild the graph even when the recorded one is intact and at this head. */
  force?: boolean;
  /** Let the wiki refresh rewrite pages in the working copy. Default: a dry run. */
  writeWiki?: boolean;
  deps?: Partial<LayerDeps>;
}

export function packageGraphDir(packageDir: string): string {
  return path.join(packageDir, LAYERS_DIR, GRAPH_DIR);
}

export function layersFilePath(packageDir: string): string {
  return path.join(packageDir, LAYERS_FILE);
}

export function layersLockPath(packageDir: string): string {
  return path.join(packageDir, LAYERS_DIR, LOCK_NAME);
}

function packageMemoryDir(packageDir: string): string {
  return path.join(packageDir, LAYERS_DIR, MEMORY_DIR);
}

function failedRecently(existing: LayersFile, now: Date): boolean {
  if (existing.graph.status !== "failed") return false;
  const age = now.getTime() - Date.parse(existing.graph.failedAt ?? existing.refreshedAt);
  return age >= 0 && age < FAILED_RETRY_WINDOW_MS;
}

/** True while a refresh of this package holds its lock. */
export function layersRefreshInFlight(packageDir: string): Promise<boolean> {
  return isLockHeld(layersLockPath(packageDir), LOCK_STALE_MS);
}

/** Wait (bounded) for a refresh of this package to finish; true when none is running afterwards. */
export async function waitForLayersRefresh(packageDir: string, timeoutMs = LOCK_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await layersRefreshInFlight(packageDir)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

async function manifestTarget(packageDir: string): Promise<{ head: string | null; ref: string | null }> {
  const manifest = await readJsonFileOr<{ target?: { head?: unknown; ref?: unknown } } | null>(path.join(packageDir, MANIFEST_FILE), null);
  const head = manifest?.target?.head;
  const ref = manifest?.target?.ref;
  return {
    head: typeof head === "string" && COMMIT_ID.test(head) ? head : null,
    ref: typeof ref === "string" && ref !== "" ? ref : null,
  };
}

/** The commit the package reviews, from its manifest's `target.head`; `null` when it records none. */
export async function manifestHead(packageDir: string): Promise<string | null> {
  return (await manifestTarget(packageDir)).head;
}

/** The full commit `rev` names in `projectRoot`, or `null` when it names none (or looks like an option). */
export async function resolveCommit(projectRoot: string, rev: string, deps: Pick<LayerDeps, "git"> = defaultLayerDeps): Promise<string | null> {
  try {
    assertGitRevision(rev);
  } catch {
    return null;
  }
  const full = await deps.git(projectRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return full !== null && /^[0-9a-f]{40,64}$/.test(full) ? full : null;
}

/** True when `layers` records a graph built at its own head whose directory is still there and complete. */
async function graphIntact(packageDir: string, layers: LayersFile): Promise<boolean> {
  if (layers.graph.status !== "ok" || layers.graphCommit === null) return false;
  const dataDir = packageGraphDir(packageDir);
  const build = await readJsonFileOr<{ commit?: unknown } | null>(path.join(dataDir, GRAPH_BUILD_FILE), null);
  if (build?.commit !== layers.graphCommit) return false;
  if (layers.graph.nodes === 0) return true;
  try {
    return (await stat(path.join(dataDir, "storage", "nodes.jsonl"))).size > 0;
  } catch {
    return false;
  }
}

/** True when `existing` can be used as is for `head` (any head when undefined): graph ok at that commit, directory intact. */
export async function layersCurrent(packageDir: string, existing: LayersFile | null, head?: string | null): Promise<boolean> {
  if (existing === null || existing.graph.status !== "ok") return false;
  if (head !== undefined && existing.prHead !== head) return false;
  return existing.graphCommit === existing.prHead && (await graphIntact(packageDir, existing));
}

export async function readLayers(packageDir: string): Promise<LayersFile | null> {
  const parsed = await readJsonFileOr<LayersFile | null>(layersFilePath(packageDir), null);
  return parsed !== null && parsed.version === LAYERS_VERSION ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function divergenceOf(
  deps: LayerDeps,
  projectRoot: string,
  prHead: string | null,
  prefix: string,
): Promise<Divergence> {
  const workingCopyCommit = await deps.git(projectRoot, ["rev-parse", "HEAD"]);
  const head = prHead ?? "";
  const partial = { workingCopyCommit, prHead: head, commitsBetween: null, changedPaths: [] as string[] };
  if (workingCopyCommit === null || prHead === null) return { state: "unknown", ...partial };
  if (workingCopyCommit === prHead) return { state: "none", ...partial, commitsBetween: 0 };
  const count = await deps.git(projectRoot, ["rev-list", "--count", "--end-of-options", `${workingCopyCommit}...${prHead}`]);
  const names = await deps.git(projectRoot, ["diff", "--name-only", "--end-of-options", workingCopyCommit, prHead, "--", prefix]);
  if (count === null || names === null) return { state: "unknown", ...partial };
  return {
    state: "differs",
    ...partial,
    commitsBetween: Number.parseInt(count, 10),
    changedPaths: names === "" ? [] : names.split("\n").sort(),
  };
}

async function writeSelfIgnoringDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), "*\n", "utf8");
}

/** Move a finished staging directory into place; the previous graph is put back if the move fails. */
export async function publishDirectory(staging: string, finalDir: string): Promise<void> {
  const previous = `${finalDir}.old.${randomUUID()}`;
  let hadPrevious = true;
  try {
    await rename(finalDir, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hadPrevious = false;
  }
  try {
    await rename(staging, finalDir);
  } catch (error) {
    if (hadPrevious) await rename(previous, finalDir).catch(() => {});
    throw error;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
}

/** A publish killed between its two renames leaves the graph under `graph.old.*`; put it back and drop other leftovers. */
async function recoverGraphDirectory(packageDir: string): Promise<void> {
  const finalDir = packageGraphDir(packageDir);
  const parent = path.dirname(finalDir);
  const name = path.basename(finalDir);
  const leftovers = (await readdir(parent).catch(() => [] as string[])).filter((entry) => entry.startsWith(`${name}.`));
  let missing = await stat(finalDir).then(() => false, () => true);
  for (const entry of leftovers.sort()) {
    const full = path.join(parent, entry);
    if (missing && entry.startsWith(`${name}.old.`)) {
      await rename(full, finalDir).then(() => { missing = false; }, () => {});
    } else {
      await rm(full, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Remove checkouts a killed refresh left behind: keryx's own temp worktrees of this repository, older than any live build. */
async function sweepStaleWorktrees(deps: LayerDeps, projectRoot: string): Promise<void> {
  const listing = await deps.git(projectRoot, ["worktree", "list", "--porcelain"]);
  if (listing === null) return;
  const temp = await realpath(tmpdir()).catch(() => tmpdir());
  const registered = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1);
  for (const worktree of registered) {
    if (path.dirname(worktree) !== temp || !path.basename(worktree).startsWith(WORKTREE_PREFIX)) continue;
    const age = await stat(worktree).then((entry) => Date.now() - entry.mtimeMs, () => 0);
    if (age < WORKTREE_SWEEP_AGE_MS) continue;
    await deps.git(projectRoot, ["worktree", "remove", "--force", "--end-of-options", worktree]);
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

type Cleanup = () => Promise<void>;

/**
 * Runs `body` with a SIGINT/SIGTERM handler for the whole time the refresh lock is held: on a signal it runs
 * every registered cleanup, removes the lock, and re-raises the signal so the process still dies by it.
 */
async function withSignalCleanup<T>(packageDir: string, body: (register: (cleanup: Cleanup) => () => void) => Promise<T>): Promise<T> {
  const cleanups = new Set<Cleanup>();
  const onSignal = (signal: NodeJS.Signals): void => {
    for (const name of SIGNALS) process.off(name, onSignal);
    const settled = Promise.all([...cleanups].map((cleanup) => cleanup().catch(() => {})));
    const bound = new Promise<void>((resolve) => setTimeout(resolve, SIGNAL_CLEANUP_MAX_MS).unref());
    void Promise.race([settled, bound])
      .then(() => rm(layersLockPath(packageDir), { recursive: true, force: true }))
      .catch(() => {})
      .finally(() => process.kill(process.pid, signal));
  };
  for (const name of SIGNALS) process.on(name, onSignal);
  try {
    return await body((cleanup) => {
      cleanups.add(cleanup);
      return () => void cleanups.delete(cleanup);
    });
  } finally {
    for (const name of SIGNALS) process.off(name, onSignal);
  }
}

/**
 * A clean detached checkout of `rev` for the duration of `use`. The checkout never runs the operator's
 * post-checkout hook; its removal, with its registration and the extra cleanup, is registered with the
 * lock-scope signal handler.
 */
async function withDetachedWorktree<T>(
  deps: LayerDeps,
  input: { projectRoot: string; packageDir: string },
  rev: string,
  cleanupExtra: () => Promise<void>,
  register: (cleanup: Cleanup) => () => void,
  use: (worktree: string, checkedOutAt: string | null) => Promise<T>,
): Promise<T> {
  const worktree = await mkdtemp(path.join(tmpdir(), WORKTREE_PREFIX));
  const cleanup = async (): Promise<void> => {
    await cleanupExtra().catch(() => {});
    await deps.git(input.projectRoot, ["worktree", "remove", "--force", "--end-of-options", worktree]);
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  };
  const unregister = register(cleanup);
  try {
    const add = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "worktree", "add", "--detach", "--force", "--end-of-options", worktree, rev];
    let added = await deps.git(input.projectRoot, add);
    if (added === null) {
      // Only a failed add prunes: a registered checkout whose directory vanished blocks the path.
      await deps.git(input.projectRoot, ["worktree", "prune"]);
      added = await deps.git(input.projectRoot, add);
    }
    if (added === null) throw new Error(`could not check out ${rev} to build its graph`);
    return await use(worktree, await deps.git(worktree, ["rev-parse", "HEAD"]));
  } finally {
    try {
      await cleanup();
    } finally {
      unregister();
    }
  }
}

async function buildPackageGraph(
  deps: LayerDeps,
  input: RefreshLayersInput,
  prHead: string | null,
  register: (cleanup: Cleanup) => () => void,
): Promise<GraphLayerRecord> {
  const failed = (error: string): GraphLayerRecord => ({
    status: "failed",
    commit: null,
    builtAt: null,
    nodes: 0,
    edges: 0,
    error,
    failedAt: deps.now().toISOString(),
  });
  if (prHead === null) return failed("no commit to build the graph at");

  const dataDir = packageGraphDir(input.packageDir);
  const staging = `${dataDir}.${randomUUID()}`;
  const dropStaging = (): Promise<void> => rm(staging, { recursive: true, force: true }).catch(() => {});
  try {
    return await withDetachedWorktree(deps, input, prHead, dropStaging, register, async (worktree, builtFrom) => {
      if (builtFrom !== prHead) {
        return failed(`graph would be built at ${builtFrom ?? "an unknown commit"}, not the PR head ${prHead}`);
      }
      await mkdir(staging, { recursive: true });
      const built = await deps.buildGraph(worktree, { dataDir: staging });
      const builtAt = deps.now().toISOString();
      await writeFile(path.join(staging, GRAPH_BUILD_FILE), `${JSON.stringify({ commit: builtFrom, builtAt }, null, 2)}\n`, "utf8");
      await publishDirectory(staging, dataDir);
      return { status: "ok", commit: builtFrom, builtAt, nodes: built.nodes, edges: built.edges } satisfies GraphLayerRecord;
    });
  } catch (error) {
    return failed(errorMessage(error));
  } finally {
    await dropStaging();
  }
}

async function refreshWikiLayer(
  deps: LayerDeps,
  input: RefreshLayersInput,
  graph: GraphLayerRecord,
  prHead: string | null,
  base: string | null,
): Promise<WikiLayerRecord> {
  const divergence = await divergenceOf(deps, input.projectRoot, prHead, WIKI_PATH_PREFIX);
  const record = (
    status: LayerStatus,
    extra: Partial<WikiLayerRecord> = {},
  ): WikiLayerRecord => ({
    status,
    commit: divergence.workingCopyCommit,
    builtAt: null,
    pagesRefreshed: 0,
    pagesStaleProse: null,
    written: false,
    divergence,
    ...extra,
  });
  if (graph.status !== "ok") return record("skipped", { error: "graph layer failed; wiki refresh needs it" });

  const dataDir = packageGraphDir(input.packageDir);
  const writeWiki = input.writeWiki === true;
  try {
    const refreshed = await deps.refreshWiki({
      cwd: input.projectRoot,
      head: HEAD_NOT_REQUESTED,
      dryRun: !writeWiki,
      dataDir,
      now: () => deps.now(),
      checkStaleness: async () => ({ status: "fresh", reasons: [] }),
    });
    let pagesStaleProse: number | null = null;
    if (prHead !== null && base !== null) {
      try {
        const report = await deps.previewFreshness({
          cwd: input.projectRoot,
          since: base,
          toRev: prHead,
          dataDir,
          now: () => deps.now(),
        });
        pagesStaleProse = report.pages.filter((entry) => entry.category === "stale-prose").length;
      } catch {
        pagesStaleProse = null;
      }
    }
    return record("ok", {
      builtAt: deps.now().toISOString(),
      pagesRefreshed: refreshed.refreshed,
      pagesStaleProse,
      written: writeWiki,
    });
  } catch (error) {
    return record("failed", { error: errorMessage(error) });
  }
}

async function indexMemoryLayer(deps: LayerDeps, input: RefreshLayersInput, prHead: string | null): Promise<MemoryLayerRecord> {
  const divergence = await divergenceOf(deps, input.projectRoot, prHead, MEMORY_PATH_PREFIX);
  try {
    const indexed = await deps.indexMemory(input.projectRoot, packageMemoryDir(input.packageDir));
    return {
      status: "ok",
      commit: divergence.workingCopyCommit,
      builtAt: deps.now().toISOString(),
      entries: indexed.entryCount,
      divergence,
    };
  } catch (error) {
    return {
      status: "failed",
      commit: divergence.workingCopyCommit,
      builtAt: null,
      entries: 0,
      divergence,
      error: errorMessage(error),
    };
  }
}

/**
 * Refresh the graph, the wiki and the memory index for one review and write
 * `layers.json`. Never throws for a layer failure: a failed layer is recorded as
 * such, and the review goes on with the layers that worked. One refresh per
 * package runs at a time; a second waits for the first.
 */
export async function refreshLayers(input: RefreshLayersInput): Promise<LayersFile> {
  const deps: LayerDeps = { ...defaultLayerDeps, ...(input.deps ?? {}) };
  if (input.prHead !== undefined) assertGitRevision(input.prHead);
  if (input.base !== undefined) assertGitRevision(input.base);
  const reviewRoot = input.reviewRoot ?? input.projectRoot;
  const target = await manifestTarget(input.packageDir);
  let headSource: HeadSource = "input";
  let prHead: string | null = input.prHead ?? null;
  if (prHead === null) {
    prHead = target.head;
    headSource = "manifest";
  }
  if (prHead === null) {
    prHead = await deps.git(reviewRoot, ["rev-parse", "HEAD"]);
    headSource = "checkout";
  }
  // One spelling of the head everywhere: the full commit, so a short sha or a branch name compares equal to the graph's commit.
  if (prHead !== null) prHead = (await resolveCommit(input.projectRoot, prHead, deps)) ?? prHead;
  let base: string | null = null;
  if (input.base !== undefined) {
    base = (await resolveCommit(input.projectRoot, input.base, deps)) ?? input.base;
  } else if (prHead !== null) {
    const fromTarget = target.ref === null ? null : await resolveCommit(input.projectRoot, target.ref, deps);
    base = fromTarget ?? `${prHead}~1`;
  }

  await writeSelfIgnoringDir(path.join(input.packageDir, LAYERS_DIR));
  return withFileLock(
    layersLockPath(input.packageDir),
    () =>
      withSignalCleanup(input.packageDir, async (register) => {
        await recoverGraphDirectory(input.packageDir);
        await sweepStaleWorktrees(deps, input.projectRoot);
        // Another refresh may have finished while this one waited for the lock: the same head needs no second build.
        const existing = await readLayers(input.packageDir);
        const sameHead = prHead !== null && existing?.prHead === prHead;
        let graph: GraphLayerRecord;
        if (input.force !== true && sameHead && (await layersCurrent(input.packageDir, existing, prHead))) {
          graph = (existing as LayersFile).graph;
        } else if (input.force !== true && sameHead && failedRecently(existing as LayersFile, deps.now())) {
          // A build that failed at this head a moment ago fails again for the same reason: do not pay a worktree and a build per call.
          graph = (existing as LayersFile).graph;
        } else {
          graph = await buildPackageGraph(deps, input, prHead, register);
          // A failed rebuild leaves the previous graph in place (publish puts it back): keep its record while it is still the right one.
          if (graph.status === "failed" && sameHead && (await layersCurrent(input.packageDir, existing, prHead))) {
            graph = (existing as LayersFile).graph;
          }
        }
        const wiki = await refreshWikiLayer(deps, input, graph, prHead, base);
        const memory = await indexMemoryLayer(deps, input, prHead);

        const layers: LayersFile = {
          version: LAYERS_VERSION,
          refreshedAt: deps.now().toISOString(),
          prHead,
          headSource,
          base,
          graphCommit: graph.commit,
          graph,
          wiki,
          memory,
        };
        await deps.writeLayers(layersFilePath(input.packageDir), `${JSON.stringify(layers, null, 2)}\n`);
        return layers;
      }),
    { timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS },
  );
}

export class PackageGraphError extends Error {}

/**
 * The package's graph, or a refusal. A graph is returned only when it was built
 * from the commit the package reviews; anything else is an error, because a
 * review that reads another commit's graph reports on code it did not look at.
 */
export async function loadPackageGraph(
  packageDir: string,
  prHead?: string,
): Promise<{ graph: GraphData; dataDir: string; layers: LayersFile }> {
  if (await layersRefreshInFlight(packageDir)) {
    throw new PackageGraphError(`the package layers are being refreshed in ${packageDir}; try again when it finishes`);
  }
  const layers = await readLayers(packageDir);
  if (layers === null) throw new PackageGraphError(`no ${LAYERS_FILE} in ${packageDir}; run \`keryx review layers refresh --package ${shellWord(packageDir)}\``);
  if (layers.graph.status !== "ok") {
    const retry =
      layers.graph.status === "failed"
        ? `; a failed build is not retried for ${FAILED_RETRY_WINDOW_MS / 60_000} minutes at the same head, run \`keryx review layers refresh --package ${shellWord(packageDir)} --force\` to retry now`
        : "";
    throw new PackageGraphError(`the package graph is ${layers.graph.status}${layers.graph.error ? `: ${layers.graph.error}` : ""}${retry}`);
  }
  if (!(await graphIntact(packageDir, layers))) {
    throw new PackageGraphError(`the package graph directory is missing or does not match ${LAYERS_FILE}; run \`keryx review layers refresh --package ${shellWord(packageDir)}\``);
  }
  const expected = prHead ?? layers.prHead;
  if (expected === null || layers.graphCommit !== expected) {
    throw new PackageGraphError(`the package graph is at ${layers.graphCommit ?? "no commit"}, not ${expected ?? "the PR head"}; refresh the layers`);
  }
  const dataDir = packageGraphDir(packageDir);
  return { graph: await loadGraph(packageDir, dataDir), dataDir, layers };
}
