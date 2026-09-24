// Flow 313 (W4 portability), review round 2 fix (R2-F8, R1-F20 remainder):
// the ONE symlink-containment check every Keryx-owned write into a project
// tree shares — `markdown-block.ts`'s two managed-block surfaces, the JSON
// settings-file owner write path (`settings-file.ts`), `ensureMetaprojectReference`
// and `rules distill` (`src/rules/agent-entrypoints.ts`, `src/rules/distill.ts`).
//
// Round 1 (F20) made every one of these refuse ANY symlink segment from
// `root` down to the target, unconditionally. Round 2 (F8) found that this is
// over-broad: `CLAUDE.md -> AGENTS.md`, `GEMINI.md -> AGENTS.md`,
// `.github/copilot-instructions.md -> ../AGENTS.md` are ordinary, common
// in-repo layouts a plain `keryx init` already writes through — refusing them
// regressed every markdown-block install against `main`, and inconsistently
// (settings.json was written before the refusal fired, leaving the surface
// half-applied).
//
// The fix: a symlink is refused only when its fully RESOLVED real path
// leaves `root` — never merely for being a symlink. `lstat` every path
// segment (never `stat`, which follows a symlink instead of reporting it) so
// an intermediate directory symlink is caught exactly like a final-component
// one, then `realpath` only the segment that IS a symlink and compare it
// against `root`'s own realpath. A segment that does not exist yet (ENOENT —
// the ordinary "this file/directory will be created" case) is never a
// refusal.
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Thrown by a caller that has no string-array error channel (mirrors `UnterminatedInstructionsBlockError`'s "refuse hard" idiom). */
export class SymlinkRefusedError extends Error {}

/**
 * Walks `relativePath` (posix-separated) segment by segment from `root`.
 * Returns a human-readable refusal string the FIRST time a symlink segment's
 * resolved real path leaves `root`; `undefined` when every segment is either
 * absent, a regular file/directory, or a symlink that resolves back inside
 * `root`. Never follows a symlink to decide whether a LATER segment exists —
 * `lstat` on the joined path already does that at the OS level, so a
 * containment refusal on an early segment is caught before any later segment
 * is even inspected.
 */
export async function refuseEscapingSymlink(root: string, relativePath: string): Promise<string | undefined> {
  const rootResolved = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = await realpath(rootResolved);
  } catch {
    rootReal = rootResolved;
  }

  const segments = relativePath.split("/").filter((s) => s.length > 0);
  let current = rootResolved;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      continue; // does not exist yet — nothing to refuse.
    }
    if (!stats.isSymbolicLink()) continue;

    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return `${relativePath}: refuses to write through a broken symlink at ${path.relative(rootResolved, current) || "."}`;
    }
    const rel = path.relative(rootReal, real);
    const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (escapes) {
      return `${relativePath}: refuses to write through a symlink at ${path.relative(rootResolved, current) || "."} that resolves outside the project root`;
    }
    // R3-F13/R4-F2: a symlink can stay technically "inside root" while still
    // resolving through a `.git` directory — `GEMINI.md -> .git/config`
    // corrupts the repo's own git config, `CLAUDE.md -> .git/hooks/pre-commit`
    // appends into a hook that then runs on every commit, and
    // `SUB.md -> sub/.git/config` reaches a NESTED repository's `.git` just as
    // dangerously. Neither is an "escape" by the check above, so it needs its
    // own refusal — every segment of the RESOLVED real path (never merely the
    // lexical `relativePath`, which a symlink can route around), matched
    // case-insensitively (`.GIT`, `.Git` are the same directory on a
    // case-insensitive filesystem), at ANY depth, not only directly under
    // `root`.
    if (hasGitSegment(rel)) {
      return `${relativePath}: refuses to write through a symlink at ${path.relative(rootResolved, current) || "."} that resolves through a .git directory`;
    }
  }
  return undefined;
}

/** True when any `path.sep`-delimited segment of `rel` is `.git`, case-insensitively. */
function hasGitSegment(rel: string): boolean {
  return rel.split(path.sep).some((segment) => segment.toLowerCase() === ".git");
}
