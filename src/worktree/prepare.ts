// `keryx worktree prepare` (spec §6): make a linked worktree ready to work in.
// Idempotent. Writes only inside the worktree's working copy (copied env files,
// dependency directories, the derived memory index) and its own git directory
// (label, ports, lock hashes, prepare state), plus the clone's port journal.
// The report names things; it never carries file contents.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMemoryService } from "../memory/service";
import { ensureCheckout, keryxDirIn } from "./checkout";
import { loadWorktreeConfig, type RebuildIndex } from "./config";
import { resolveWorktreeContext } from "./context";
import { prepareDependency, type DepsRecord, type RunInstall } from "./deps";
import { copyEnvFiles, type SkippedEnvFile } from "./env-files";
import { allocatePorts } from "./ports";

export type PrepareStep = "env" | "deps" | "ports" | "indexes";
export const PREPARE_STEPS: readonly PrepareStep[] = ["env", "deps", "ports", "indexes"];

export type StepOutcome = "ok" | "failed";

/** What `<worktree-git-dir>/keryx/prepare.json` holds: when prepare last ran and how each step ended. */
export interface PrepareState {
  version: 1;
  at: string;
  steps: Partial<Record<PrepareStep, StepOutcome>>;
}

export interface IndexReport {
  name: RebuildIndex;
  status: "built" | "skipped" | "failed";
  entries?: number;
  reason?: string;
}

export interface PrepareReport {
  worktree: string;
  checkoutId: string;
  at: string;
  /** The steps this run executed. */
  steps: PrepareStep[];
  env?: { copied: string[]; skipped: SkippedEnvFile[] };
  deps?: Array<{ dir: string; method: DepsRecord["method"] }>;
  ports?: Record<string, number>;
  indexes?: IndexReport[];
  /** One line per failed step; empty when everything ran. */
  errors: string[];
  ok: boolean;
}

export interface PrepareOptions {
  cwd: string;
  only?: readonly PrepareStep[];
  /** Overwrite env files that already exist in the worktree. */
  force?: boolean;
  /** Injected so tests never reach the network. */
  runInstall?: RunInstall;
  isPortFree?: (port: number) => boolean;
  now?: () => Date;
}

export function prepareStatePath(gitDir: string): string {
  return path.join(keryxDirIn(gitDir), "prepare.json");
}

/** The prepare state of the worktree whose git directory is `gitDir`; `undefined` when never prepared or unreadable. */
export async function readPrepareState(gitDir: string): Promise<PrepareState | undefined> {
  try {
    const raw = JSON.parse(await readFile(prepareStatePath(gitDir), "utf8")) as Partial<PrepareState>;
    if (raw.version !== 1 || typeof raw.at !== "string" || typeof raw.steps !== "object" || raw.steps === null) return undefined;
    return { version: 1, at: raw.at, steps: raw.steps };
  } catch {
    return undefined;
  }
}

async function writePrepareState(gitDir: string, state: PrepareState): Promise<void> {
  await mkdir(keryxDirIn(gitDir), { recursive: true });
  const temp = `${prepareStatePath(gitDir)}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, prepareStatePath(gitDir));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function rebuildIndex(name: RebuildIndex, worktreeRoot: string): Promise<IndexReport> {
  if (name !== "memory") {
    return { name, status: "skipped", reason: "not rebuilt by prepare in this version" };
  }
  try {
    // Built from the worktree's own `.metaproject/memory`, never another checkout's.
    const result = await createMemoryService().index({ cwd: worktreeRoot, embeddings: false });
    return { name, status: "built", entries: result.entryCount };
  } catch (cause) {
    return { name, status: "failed", reason: messageOf(cause) };
  }
}

/**
 * Prepare the linked worktree that contains `opts.cwd`. Refuses the main checkout
 * and anything outside a git repository. A failing step is reported and the
 * remaining steps still run, so one bad install does not leave the ports and the
 * memory index undone.
 */
export async function prepareWorktree(opts: PrepareOptions): Promise<PrepareReport> {
  const context = await resolveWorktreeContext(opts.cwd);
  if (context.isMain) {
    throw new Error("refusing to prepare the main checkout: run this inside a linked worktree (keryx worktree create <name>)");
  }
  const config = await loadWorktreeConfig(context.mainRoot);
  const requested = opts.only === undefined || opts.only.length === 0 ? PREPARE_STEPS : opts.only;
  const steps = PREPARE_STEPS.filter((step) => requested.includes(step));
  const at = (opts.now?.() ?? new Date()).toISOString();

  const checkout = await ensureCheckout(context.root, opts.now === undefined ? {} : { now: opts.now });
  if (checkout === undefined) {
    throw new Error("refusing to prepare the main checkout: run this inside a linked worktree");
  }

  const report: PrepareReport = { worktree: context.root, checkoutId: checkout.checkoutId, at, steps, errors: [], ok: true };
  const outcomes: Partial<Record<PrepareStep, StepOutcome>> = {};
  const fail = (step: PrepareStep, message: string): void => {
    outcomes[step] = "failed";
    report.errors.push(`${step}: ${message}`);
  };

  if (steps.includes("env")) {
    try {
      const result = await copyEnvFiles({
        mainRoot: context.mainRoot,
        worktreeRoot: context.root,
        files: config.envFiles,
        ...(opts.force === true && { force: true }),
      });
      report.env = result;
      outcomes.env = "ok";
    } catch (cause) {
      fail("env", messageOf(cause));
    }
  }

  if (steps.includes("deps")) {
    report.deps = [];
    outcomes.deps = "ok";
    for (const dependency of config.dependencies) {
      try {
        const record = await prepareDependency({
          mainRoot: context.mainRoot,
          worktreeRoot: context.root,
          dependency,
          ...(opts.runInstall !== undefined && { runInstall: opts.runInstall }),
          ...(opts.now !== undefined && { now: opts.now }),
        });
        report.deps.push({ dir: record.dir, method: record.method });
      } catch (cause) {
        fail("deps", messageOf(cause));
      }
    }
  }

  if (steps.includes("ports")) {
    try {
      const allocated = await allocatePorts({
        cwd: context.root,
        config,
        ...(opts.now !== undefined && { now: opts.now }),
        ...(opts.isPortFree !== undefined && { isPortFree: opts.isPortFree }),
      });
      report.ports = allocated.ports;
      outcomes.ports = "ok";
    } catch (cause) {
      fail("ports", messageOf(cause));
    }
  }

  if (steps.includes("indexes")) {
    report.indexes = [];
    outcomes.indexes = "ok";
    for (const name of config.prepare.rebuildIndexes) {
      const index = await rebuildIndex(name, context.root);
      report.indexes.push(index);
      if (index.status === "failed") fail("indexes", `${name}: ${index.reason ?? "failed"}`);
    }
  }

  const previous = await readPrepareState(context.gitDir);
  await writePrepareState(context.gitDir, { version: 1, at, steps: { ...previous?.steps, ...outcomes } });
  report.ok = report.errors.length === 0;
  return report;
}
