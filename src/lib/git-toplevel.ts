// Shared "project boundary" resolution for the harness hooks trust guards
// (R2-04/R2-05/R3-05, flow 319).
//
// `src/harness/hooks/trust.ts`'s `trustStoreInsideProject` and
// `src/harness/hooks/config.ts`'s `guardUserHomeDir` each need the same
// answer to "what directory counts as 'the project' for the purpose of
// refusing a trust store / KERYX_HOME that resolves inside it" — both used
// to carry byte-identical copies of `gitToplevelRoot` and
// `realpathOrResolve` (their own doc comments explained why they were
// duplicated rather than cross-imported: `config.ts` imports FROM
// `trust.ts`, so a shared helper living in either file would still leave
// one direction awkward). Extracted to `src/lib` — a layer both already
// import other small helpers from (`config-dir`, `terminal-safe`) — so
// there is exactly one implementation instead of two that must be kept in
// sync by hand.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { keryxConfigDir } from "./config-dir";

/**
 * Realpath when possible, falling back to a plain resolve — tries the
 * nearest EXISTING ancestor before giving up, so a not-yet-created
 * directory under a symlinked tmp/home root (macOS: `/var` ->
 * `/private/var`) still compares correctly against an already-realpath'd
 * sibling. Both sides of every containment check in this module go through
 * this SAME function, so a case-insensitive volume or a symlinked tmp/home
 * root never compares a canonical path against a non-canonical one.
 */
export function realpathOrResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs; // filesystem root, still unresolved
    return path.join(realpathOrResolve(parent), path.basename(abs));
  }
}

function isAncestorOrEqual(ancestor: string, target: string): boolean {
  return target === ancestor || target.startsWith(ancestor + path.sep);
}

/**
 * Nearest ancestor of `startDir` containing `.git` (a directory or a
 * gitfile — worktrees use a gitfile), or `startDir` itself when none is
 * found.
 *
 * This is the boundary a KERYX_HOME / trust-store directory is refused
 * INSIDE of — not `startDir` itself, which can be a SUBDIRECTORY that
 * happens to have its own nested `.metaproject` (a workspace inside a
 * monorepo, say). Comparing against that subdirectory only would let
 * `KERYX_HOME=<repo>/.kx` pass as "outside the project" merely because the
 * session started one level down — the whole clone is still the same
 * attacker-controlled checkout either way (R2-05).
 */
export function gitToplevelRoot(startDir: string): string {
  const abs = path.resolve(startDir);
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return abs;
}

/** Nearest ancestor of `startDir` containing `.metaproject`, or `undefined` when none is found. */
function nearestMetaprojectRoot(startDir: string): string | undefined {
  const abs = path.resolve(startDir);
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, ".metaproject"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The boundary `guardUserHomeDir` (config.ts) and `trustStoreInsideProject`
 * (trust.ts) refuse a KERYX_HOME / trust-store directory from resolving
 * inside of.
 *
 * Normally this is just `gitToplevelRoot(startDir)` (see its own doc
 * comment for why the toplevel, not `startDir` itself — R2-05).
 *
 * R3-05 (flow 319 review round 3): but when $HOME is ITSELF a git work tree
 * (a common dotfiles setup — `~/.git` tracking dotfiles, or a repo higher
 * up that contains $HOME), that walk returns $HOME or an ancestor of it —
 * widening the boundary to cover the operator's REAL home directory and
 * the real trust store/config dir under it. Those then read as "inside the
 * project", and every trust check fails closed: `hooks trust` refuses
 * unconditionally, and a previously trusted project hook stops running.
 * That is a regression from R2-04/R2-05's own fix, not a bypass — the
 * boundary only ever widens, never narrows — but it makes keryx unusable
 * in a dotfiles-tracked home.
 *
 * So: when the git toplevel equals $HOME, is an ancestor of $HOME, or is
 * an ancestor of the DEFAULT keryx config dir, use the nearest ancestor of
 * `startDir` containing `.metaproject` instead — the project root the
 * session actually opened. That is narrower than the (over-broad) git
 * toplevel, but still wider than `startDir` alone, so R2-05's
 * nested-`.metaproject` protection (a workspace inside a monorepo cannot
 * narrow the check to itself) still holds whenever this fallback is used.
 * Falls back to `startDir` itself (resolved) when no `.metaproject` is
 * found either — the narrowest boundary is still safer than the
 * over-broad one it replaces.
 *
 * Deliberately always the DEFAULT config dir (`keryxConfigDir()`, no
 * override) here, never whatever `configDir` a specific caller happens to
 * be checking against: that is often a test fixture placed INSIDE a
 * project's tmp dir on purpose, to exercise R2-04's own "trust store
 * resolves inside the project" refusal. Anchoring "is the boundary
 * over-broad?" on the caller's own value under test would let that value
 * silently narrow the very boundary it is being checked against — this
 * asks only "does the git toplevel swallow the operator's REAL home /
 * default config location", which is what actually indicates a
 * dotfiles-tracked home rather than an ordinary override.
 */
export function trustBoundaryRoot(startDir: string): string {
  const gitTop = gitToplevelRoot(startDir);
  const gitTopReal = realpathOrResolve(gitTop);
  const homeReal = realpathOrResolve(os.homedir());
  const configReal = realpathOrResolve(keryxConfigDir());
  const overBroad = isAncestorOrEqual(gitTopReal, homeReal) || isAncestorOrEqual(gitTopReal, configReal);
  if (!overBroad) return gitTop;
  return nearestMetaprojectRoot(startDir) ?? path.resolve(startDir);
}
