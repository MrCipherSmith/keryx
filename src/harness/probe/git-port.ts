import { execFile } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertWritableContained, removeContained, writeContained } from "../../lib/contained-write";
import { isNotFound } from "../../lib/fs";
import type { ProbeTask } from "../../learning/probe-schema";
import type { ProbeRunnerPort, ProbeTurnInput, ProbeTurnResult } from "./runner";
const exec = promisify(execFile);
export class ProbeIsolationError extends Error {
  readonly code = "PROBE_ISOLATION";
}
export interface ProbeGitOptions {
  repoRoot: string;
  worktreesDir: string;
  commit: string;
  probeId: string;
  turn(input: ProbeTurnInput): Promise<ProbeTurnResult>;
}
/** Only detached, durably owned worktrees are reconciled; never prune global metadata. */
export function createProbeGitPort(options: ProbeGitOptions): ProbeRunnerPort {
  if (!/^[a-f0-9]{12}$/.test(options.probeId) || !/^[a-f0-9]{40,64}$/.test(options.commit))
    throw new ProbeIsolationError("Invalid pinned probe identity");
  const repo = path.resolve(options.repoRoot);
  const parent = path.resolve(options.worktreesDir, options.probeId);
  const rel = path.relative(repo, parent);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new ProbeIsolationError("Probe worktrees must be contained in repository");
  const roots = { base: path.join(parent, "base"), probe: path.join(parent, "probe") };
  const marker = `${rel}/owner.json`;
  const owner = JSON.stringify({ schemaVersion: 1, repo, probeId: options.probeId, commit: options.commit });
  const git = (...args: string[]) => exec("git", args, { cwd: repo });
  async function exists(file: string): Promise<boolean> {
    try { await lstat(file); return true; } catch (error) { if (isNotFound(error)) return false; throw error; }
  }
  async function checkOwner(): Promise<boolean> {
    await assertWritableContained(repo, marker);
    if (!(await exists(path.join(repo, marker)))) return false;
    if (await readFile(path.join(repo, marker), "utf8") !== owner)
      throw new ProbeIsolationError("Probe worktree ownership mismatch");
    return true;
  }
  async function cleanup(): Promise<void> {
    if (!(await checkOwner())) {
      if (await exists(parent)) throw new ProbeIsolationError("Refusing unowned probe directory");
      return;
    }
    const listed = (await git("worktree", "list", "--porcelain", "-z")).stdout.split("\0")
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    for (const arm of ["base", "probe"] as const) {
      await assertWritableContained(repo, `${rel}/${arm}`, "directory");
      if (listed.includes(roots[arm])) await git("worktree", "remove", "--force", roots[arm]);
      else if (await exists(roots[arm])) throw new ProbeIsolationError("Unregistered owned worktree requires inspection");
    }
    await removeContained(repo, rel);
  }
  async function prepare(task: ProbeTask) {
    for (const artifact of task.goldArtifacts) {
      if (!artifact || path.isAbsolute(artifact) || artifact.includes("\\") || artifact.split("/").some((v) => v === ".." || v === "." || !v))
        throw new ProbeIsolationError("Unsafe gold artifact path");
    }
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    if (head !== options.commit) return { roots, goldClean: true, environmentMatches: false };
    for (const artifact of task.goldArtifacts) {
      try { await git("cat-file", "-e", `${options.commit}:${artifact}`); }
      catch { return { roots, goldClean: false, environmentMatches: true }; }
    }
    await assertWritableContained(repo, rel, "directory");
    if (await exists(parent)) throw new ProbeIsolationError("Reconcile stale probe worktrees before preparation");
    await mkdir(parent, { recursive: true });
    await writeContained(repo, marker, owner);
    for (const arm of ["base", "probe"] as const) {
      await git("worktree", "add", "--detach", roots[arm], options.commit);
      for (const artifact of task.goldArtifacts) {
        await removeContained(roots[arm], artifact);
        if (await exists(path.join(roots[arm], artifact))) throw new ProbeIsolationError("Gold artifact remains reachable");
      }
    }
    return { roots, goldClean: true, environmentMatches: true };
  }
  return { reconcile: cleanup, prepare, cleanup, turn: options.turn };
}
