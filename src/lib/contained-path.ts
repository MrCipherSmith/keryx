// Containment for caller-supplied paths (flow 126 / S-003).
//
// Several commands take a path from the caller and read it: `test suggest`
// sends the contents to a model provider, `security scan` walks it, `agents
// monitor` parses it. None of them checked that the path stays inside the
// project, so a traversal or an absolute path reached any file the process
// could read — including the user-global credential store — and in the model
// case left the machine.
//
// Two things matter here and neither is optional:
//
//   * The check runs on the REAL path, after symlink resolution. A symlink
//     inside the project pointing outside satisfies a string-prefix check and
//     still reads the target.
//   * The comparison is segment-aware. `/home/u/proj-secrets` is not inside
//     `/home/u/proj`, even though its path string starts with it.

import { realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type ContainedPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "outside-project" | "not-found"; message: string };

/**
 * Walk up from `startDir` to the project root — the nearest ancestor holding a
 * `.metaproject/` or a `.git/`.
 *
 * The boundary has to be the project, not the working directory. Rooted at
 * `cwd`, `keryx security scan ../lib/x.ts` run from a subdirectory refuses a
 * path that is plainly inside the project, and the boundary would shift with
 * wherever the shell happens to be. That over-restriction is the same failure
 * that forced containment off `agents monitor`.
 *
 * Falls back to `startDir` when neither marker is found, which keeps a bare
 * directory contained to itself rather than silently widening.
 */
export function resolveProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, ".metaproject")) || existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

/** True when `candidate` is `root` itself or sits beneath it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  // `path.relative` gives a leading `..` SEGMENT for anything above the root,
  // and an absolute result when the two are on different roots (Windows
  // drives). The comparison is segment-wise on purpose: a plain
  // `startsWith("..")` also matches an in-project file literally named
  // `..hidden.ts`, refusing something that is inside the root.
  if (relative.length === 0 || path.isAbsolute(relative)) {
    return false;
  }
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * Resolve a caller-supplied path and refuse it unless it stays inside the
 * project.
 *
 * The refusal is typed and distinguishable from a missing file: an operator
 * needs to know whether they made a typo or asked for something they may not
 * have, and a generic ENOENT hides the difference.
 */
export async function resolveContainedPath(
  projectRoot: string,
  candidate: string,
): Promise<ContainedPathResult> {
  const rootReal = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const absolute = path.resolve(rootReal, candidate);

  // Resolve symlinks. A path that does not exist yet cannot be a symlink
  // escape, so its lexical resolution is the honest answer — but it is still
  // checked for containment before being reported as missing, so a traversal
  // is never disclosed as "not found" (which would confirm what is not there).
  const real = await realpath(absolute).catch(() => null);
  const effective = real ?? absolute;

  if (!isInside(rootReal, effective)) {
    return {
      ok: false,
      reason: "outside-project",
      message: `refused: ${candidate} resolves outside the project root. Paths must stay inside ${rootReal}.`,
    };
  }

  if (real === null) {
    return { ok: false, reason: "not-found", message: `no such file or directory: ${candidate}` };
  }

  return { ok: true, path: real };
}

/**
 * Synchronous twin of {@link resolveContainedPath}, for the command paths that
 * are synchronous end to end (`agents monitor`). Same rules, same order: real
 * path first, containment before existence.
 */
export function resolveContainedPathSync(projectRoot: string, candidate: string): ContainedPathResult {
  let rootReal: string;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    rootReal = path.resolve(projectRoot);
  }
  const absolute = path.resolve(rootReal, candidate);

  let real: string | null;
  try {
    real = realpathSync(absolute);
  } catch {
    real = null;
  }
  const effective = real ?? absolute;

  if (!isInside(rootReal, effective)) {
    return {
      ok: false,
      reason: "outside-project",
      message: `refused: ${candidate} resolves outside the project root. Paths must stay inside ${rootReal}.`,
    };
  }

  if (real === null) {
    return { ok: false, reason: "not-found", message: `no such file or directory: ${candidate}` };
  }

  return { ok: true, path: real };
}
