// F3 (review round 1, GDCTX-2 egress source overrides): `ctx read`'s call into
// `redactRaw` used to label EVERY file it read `trusted-project` unconditionally
// (`commands/ctx.ts` — see the single call site this module now feeds). That
// label is what `resolve.ts#egressSourceOverrideAction` gates the shipped
// `SHIPPED_EGRESS_SOURCE_OVERRIDES` allowance on: an `<img src>` egress finding
// under `trusted-project` content is allowed through unmasked when its query
// string is not credential-shaped. So a `ctx read /tmp/x.md`, a downloaded file
// outside the repo, or a `node_modules`/build artifact INSIDE the repo but never
// committed — none of them vetted by the operator committing them, which is the
// whole reason `trusted-project` is trusted (see `types.ts#SecuritySource`) —
// got the same free pass a README the operator wrote and reviewed gets, and any
// exfil-shaped image URL inside it rendered unmasked.
//
// The fix: `trusted-project` only when the resolved REAL path (symlinks
// followed, exactly as `resolveContainedPath` already does for every other
// caller-supplied path in this codebase — see `lib/contained-path.ts`) sits
// INSIDE the project root AND is tracked by git — not ignored, not untracked.
// Every other case falls back to `untrusted-external` (`types.ts`'s existing
// "arrived from outside the operator's machine" bucket is the nearest fit for
// "not vetted by a commit either" — there is no sixth value to invent). A git
// error (not a repository, `git` missing, a transient failure) fails CLOSED to
// `untrusted-external` rather than assuming trust it could not verify.
import { resolveContainedPath, resolveProjectRoot } from "../lib/contained-path";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SecuritySource } from "./types";

/**
 * Whether `absolutePath` (already resolved, e.g. `path.resolve(cwd, file)`) is
 * safe to label `trusted-project` for a `redactRaw`/`guardOutput` call, or
 * whether it must fall back to `untrusted-external`.
 *
 * Cheap by design: one `resolveContainedPath` (already paid for containment
 * elsewhere in this codebase) plus one `git ls-files --error-unmatch`, which
 * exits non-zero for anything git does not track — untracked, ignored, or a
 * path outside any repository entirely. `ac-reseal.ts` already relies on this
 * same exit-code contract for the same question ("does git know this path"),
 * so this reuses it rather than inventing a second oracle for it.
 */
export async function sourceForFileRead(
  cwd: string,
  absolutePath: string,
): Promise<SecuritySource> {
  const projectRoot = resolveProjectRoot(cwd);
  const contained = await resolveContainedPath(projectRoot, absolutePath);
  if (!contained.ok) {
    return "untrusted-external";
  }
  // `contained.path` is already the REAL (symlink-resolved) path
  // (`resolveContainedPath`). The project root must be compared against that
  // same real filesystem, not the lexical `projectRoot` — a `cwd` reached
  // through a symlinked ancestor (e.g. macOS's `/tmp` -> `/private/tmp`) would
  // otherwise produce a `path.relative` full of `..` segments that never
  // matches anything `git ls-files` tracks, misreading every tracked file as
  // untracked.
  const projectRootReal = await realpath(projectRoot).catch(() => projectRoot);
  const relativePath = path.relative(projectRootReal, contained.path);
  // A path that resolved to the project root itself (relative === "") or that
  // could not be made relative (still absolute, a different drive on Windows)
  // is not a trackable FILE — treat it the same as "not tracked".
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return "untrusted-external";
  }
  // A directory is never a single trustable FILE read (`ctx read`/`redactRaw`
  // read file content, not a listing), and `git ls-files` happily reports a
  // tracked directory as a match for a path that names it. Refuse it here
  // before git ever gets a say.
  const fileStat = await stat(contained.path).catch(() => null);
  if (fileStat === null || !fileStat.isFile()) {
    return "untrusted-external";
  }
  try {
    // `--literal-pathspecs` (equivalently `GIT_LITERAL_PATHSPECS=1`) turns off
    // ALL pathspec magic for this invocation: a leading `:(glob)`/`:!`/`:^`
    // prefix, and glob metacharacters (`*`, `?`, `[...]`) inside the path
    // itself, are taken as literal characters instead of being interpreted.
    // Without it, an UNTRACKED `a*.md` is reported as tracked because it
    // happens to glob-match a real tracked `abc.md`, and `:!zz` is parsed as
    // an exclude pathspec (matching nothing, but exiting 0 as "no error") —
    // both silently mislabel an unvetted path `trusted-project`.
    //
    // `-z` NUL-terminates the output so a path containing a newline cannot
    // smuggle a second, forged line into the comparison below.
    //
    // Even with magic disabled, `git ls-files -- <path>` matches any tracked
    // path *under* a tracked directory of that name, not just an exact file —
    // so the exit code alone is not enough. Requiring the (single) NUL-split
    // entry to equal `relativePath` exactly rejects that case, along with any
    // other multi-match surprise, while a literal, single, exact match still
    // passes.
    const proc = Bun.spawn(
      ["git", "--literal-pathspecs", "ls-files", "--error-unmatch", "-z", "--", relativePath],
      {
        cwd: projectRootReal,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
      },
    );
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exitCode !== 0) {
      return "untrusted-external";
    }
    const entries = stdout.split("\0").filter((entry) => entry.length > 0);
    return entries.length === 1 && entries[0] === relativePath ? "trusted-project" : "untrusted-external";
  } catch {
    // git missing, not a repository, or a spawn failure: the workspace's own
    // provenance cannot be established, so this fails closed rather than
    // trusting a path it could not verify.
    return "untrusted-external";
  }
}
