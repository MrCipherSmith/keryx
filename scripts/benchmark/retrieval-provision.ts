// Making the `context-on` arm actually contain what it claims to.
//
// A worktree comes out of git, and git does not carry the whole of the context:
//
//  - The graph DATABASE is generated, not committed. This repository tracks
//    three gdgraph files — a provenance stamp, a module map and a summary — and
//    none of them answers `gdgraph affected`. So `context-on` was handed a
//    routing index that points at a graph which does not exist. The smoke run's
//    context-on arm was in exactly that state, which is one more reason its
//    numbers mean nothing.
//  - On repositories that gitignore `.metaproject/` entirely, the checkout has
//    no context at all. `assertArmContext` refuses that case; this is what makes
//    it runnable.
//
// Everything here is derived FROM THE WORKTREE, at the task's parent commit.
// Copying the maintainer's current `.metaproject/` in would import artifacts
// built from code the target pull request added — the answer, handed over in the
// context arm's own workspace. `keryx init` and `keryx gdgraph build` read only
// the tree they are run in, so there is nothing to leak.

import { existsSync } from "node:fs";
import path from "node:path";

export interface CommandRunner {
  run(input: { cwd: string; command: readonly string[] }): Promise<{ exitCode: number; stderr: string }>;
}

export interface ProvisionResult {
  /** Commands actually run, in order. */
  readonly ran: readonly string[];
  /** Set when `keryx init` created a registry entry that must be released. */
  readonly initialized: boolean;
}

export const KERYX_INIT: readonly string[] = ["keryx", "init", "--yes"];
export const KERYX_GRAPH_BUILD: readonly string[] = ["keryx", "gdgraph", "build"];

/**
 * Bring a `context-on` worktree up to what a developer working at that commit
 * would have had.
 *
 * `keryx init` only when the checkout has no `.metaproject/` — regenerating one
 * over a committed workspace would overwrite the wiki that the checkout
 * legitimately carries at that revision.
 *
 * `keryx gdgraph build` always, because the graph is never committed anywhere.
 *
 * A failure throws. A half-provisioned arm scores like a real one, and the whole
 * point of the guards around this is that no arm gets to be silently wrong.
 */
export async function provisionContextOn(
  worktreePath: string,
  runner: CommandRunner,
): Promise<ProvisionResult> {
  const ran: string[] = [];
  const needsInit = !existsSync(path.join(worktreePath, ".metaproject"));

  if (needsInit) {
    const init = await runner.run({ cwd: worktreePath, command: KERYX_INIT });
    ran.push(KERYX_INIT.join(" "));
    if (init.exitCode !== 0) {
      throw new Error(`keryx init failed in ${worktreePath}: ${init.stderr.trim()}`);
    }
  }

  const build = await runner.run({ cwd: worktreePath, command: KERYX_GRAPH_BUILD });
  ran.push(KERYX_GRAPH_BUILD.join(" "));
  if (build.exitCode !== 0) {
    throw new Error(`keryx gdgraph build failed in ${worktreePath}: ${build.stderr.trim()}`);
  }

  return { ran, initialized: needsInit };
}

/**
 * Release the user-global registry entry `keryx init` creates.
 *
 * Without this a fifty-task sweep leaves fifty dead entries in the user's
 * project registry, pointing at temporary directories that no longer exist —
 * `keryx projects list` already shows twenty such leftovers from earlier
 * throwaway trees. `forget` is the only way an entry is ever removed, so a
 * benchmark that creates them has to remove them itself.
 *
 * Best-effort by design: failing to tidy the registry must not fail a task that
 * otherwise ran correctly. It returns whether it managed it, so a caller can
 * report the leftovers rather than pretend there are none.
 */
export async function forgetRegisteredProject(
  worktreePath: string,
  runner: CommandRunner & {
    list(): Promise<{ projectId: string; path: string }[]>;
  },
): Promise<boolean> {
  let entries: { projectId: string; path: string }[];
  try {
    entries = await runner.list();
  } catch {
    return false;
  }
  const match = entries.find((entry) => entry.path === worktreePath);
  if (match === undefined) return false;
  const result = await runner.run({
    cwd: worktreePath,
    command: ["keryx", "projects", "forget", match.projectId],
  });
  return result.exitCode === 0;
}

/** Runs the commands for real, against the keryx binary on PATH. */
export function createShellRunner(): CommandRunner & {
  list(): Promise<{ projectId: string; path: string }[]>;
} {
  return {
    async run({ cwd, command }) {
      const proc = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode, stderr };
    },
    async list() {
      const proc = Bun.spawn(["keryx", "projects", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const parsed = JSON.parse(out) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : ((parsed as { projects?: unknown[] }).projects ?? []);
      return rows as { projectId: string; path: string }[];
    },
  };
}

/**
 * The provisioner the real sweep uses.
 *
 * `release` swallows its own failures on purpose: a registry entry that could
 * not be tidied is untidy, not wrong, and must not fail a task whose measurement
 * was sound. It is reported through `leftovers` so the sweep can say so rather
 * than assume it was clean.
 */
export function createKeryxProvisioner(): {
  provision(worktreePath: string): Promise<void>;
  release(worktreePath: string): Promise<void>;
  readonly leftovers: readonly string[];
} {
  const runner = createShellRunner();
  const initialized = new Set<string>();
  const leftovers: string[] = [];

  return {
    leftovers,
    async provision(worktreePath) {
      const result = await provisionContextOn(worktreePath, runner);
      if (result.initialized) initialized.add(worktreePath);
    },
    async release(worktreePath) {
      if (!initialized.has(worktreePath)) return;
      initialized.delete(worktreePath);
      try {
        if (!(await forgetRegisteredProject(worktreePath, runner))) leftovers.push(worktreePath);
      } catch {
        leftovers.push(worktreePath);
      }
    },
  };
}
