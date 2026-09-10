// Building an arm's tree, cheaply and without handing it the answer.
//
// `createIsolatedCheckout` does the hard part already and is reused verbatim:
// `git init`, add the local clone as a remote, shallow-fetch the ONE ref, check
// out FETCH_HEAD, remove the remote. Not a worktree, on purpose — a worktree
// shares the object database and every ref, so `git show <sha>` and
// `git log --all --grep "<the prompt's words>"` both reach the commit that holds
// the answer. A depth-limited fetch of the parent brings ancestors only.
//
// What the arena adds is a cache, for a reason that is arithmetic rather than
// taste: 13 tasks × 3 harnesses × 2 arms is 78 arms, each re-fetching 50 commits
// of an 8,632-file repository. The pilot re-fetched per arm because at 50 tasks ×
// 1 harness the cost was tolerable. Here it is the difference between a run that
// finishes in an evening and one that does not.
//
// The cache is per base commit and is never handed to an arm directly: each arm
// gets its own copy-on-write clone, because `tsconfig.tsbuildinfo` and vite's
// caches are written during the gates, and a shared directory would leak one
// arm's timings and outcomes into the next.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createIsolatedCheckout } from "../benchmark/retrieval-checkout";

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() || proc.stderr.toString().trim() };
}

/**
 * Refuse a workspace built from code the task has not reached yet.
 *
 * The pre-registration states this as an admissibility criterion: a context
 * workspace is generated at some commit X, and a task is admissible only if its
 * base descends from X. Violate it and the arm may hold a graph, or wiki prose,
 * describing the very change the task asks about — the answer, delivered inside
 * the context arm's own workspace.
 *
 * For the arena's T1 this is a tautology, because provisioning runs in the arm's
 * own tree. It is asserted anyway: the check is cheap, and it is what stops a
 * future optimisation from handing one pre-built workspace to every base.
 */
export function assertProvisionAncestry(repoRoot: string, provisionCommit: string, base: string): void {
  const probe = git(repoRoot, ["merge-base", "--is-ancestor", provisionCommit, base]);
  if (!probe.ok) {
    throw new Error(
      `the workspace was built at ${provisionCommit}, which is not an ancestor of the task's base ${base} — ` +
        "a workspace derived from later code can describe the change the task asks about, " +
        "which hands the answer to the context arm inside its own workspace",
    );
  }
}

export interface BaseTreeCache {
  /** A tree at `commit`, fetched once. Never given to an arm directly. */
  ensure(commit: string): Promise<string>;
  /** Copy-on-write clone for one arm. */
  materialize(commit: string, armPath: string): Promise<void>;
  dispose(): void;
}

/**
 * Copy a directory, preferring APFS clones over byte copies.
 *
 * `cp -c` asks for clonefile: the copy shares storage until written, so a 1.5 GB
 * `node_modules` costs near nothing per arm and each arm still gets a private
 * tree. Falls back to a real recursive copy where clonefile is unavailable, which
 * is correct but slow — and the fallback is reported rather than silent, because
 * "the run got mysteriously slower" is a bad way to learn the filesystem changed.
 */
export function cloneDirectory(from: string, to: string): { cloned: boolean } {
  mkdirSync(path.dirname(to), { recursive: true });
  const proc = Bun.spawnSync(["cp", "-Rc", from, to]);
  if (proc.exitCode === 0) return { cloned: true };
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  return { cloned: false };
}

export interface BaseTreeCacheOptions {
  readonly repoRoot: string;
  readonly cacheDir: string;
  /** A tree holding installed dependencies, cloned into each arm that needs them. */
  readonly nodeModulesTemplate?: string;
  readonly depth?: number;
  readonly onFallbackCopy?: (from: string, to: string) => void;
}

export function createBaseTreeCache(options: BaseTreeCacheOptions): BaseTreeCache {
  const built = new Set<string>();

  const pathFor = (commit: string): string => path.join(options.cacheDir, commit);

  return {
    async ensure(commit: string): Promise<string> {
      const target = pathFor(commit);
      if (built.has(commit) && existsSync(target)) return target;
      // Awaited. `createIsolatedCheckout` is async — it runs five git steps — and a
      // missing await here produced an arm materialized from a directory that did
      // not exist yet, which failed as an ENOENT on lstat rather than as anything
      // resembling its cause.
      await createIsolatedCheckout({
        repoRoot: options.repoRoot,
        path: target,
        ref: commit,
        ...(options.depth === undefined ? {} : { depth: options.depth }),
      });
      built.add(commit);
      return target;
    },

    async materialize(commit: string, armPath: string): Promise<void> {
      const source = await this.ensure(commit);
      rmSync(armPath, { recursive: true, force: true });
      const copy = cloneDirectory(source, armPath);
      if (!copy.cloned) options.onFallbackCopy?.(source, armPath);

      if (options.nodeModulesTemplate !== undefined) {
        const modules = path.join(options.nodeModulesTemplate, "node_modules");
        if (existsSync(modules)) {
          const armModules = path.join(armPath, "node_modules");
          const modulesCopy = cloneDirectory(modules, armModules);
          if (!modulesCopy.cloned) options.onFallbackCopy?.(modules, armModules);
        }
      }
    },

    dispose(): void {
      rmSync(options.cacheDir, { recursive: true, force: true });
      built.clear();
    },
  };
}
