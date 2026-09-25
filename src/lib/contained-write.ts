// Flow 313 (W4 portability), re-plan lane C1: the ONE write/remove/rename/
// mkdir primitive every Keryx-owned write into a project tree routes
// through, replacing the raw `node:fs/promises` calls that used to be
// scattered across `src/integrations/**`, `src/rules/**` and
// `src/agents/export.ts` — each of which re-implemented (or, in a few
// sites, skipped) the same containment check `src/lib/symlink-safety.ts`
// centralised for reads.
//
// Three failure modes this closes by construction, all findings from
// review rounds 1-3 that kept recurring at different call sites:
//   - a symlink segment (intermediate or final) whose resolved real path
//     leaves `root` — delegated to `refuseEscapingSymlink`, the same check
//     `markdown-block.ts` already used, so both agree byte-for-byte;
//   - a symlink CYCLE or a DANGLING symlink on the path to the target,
//     which `refuseEscapingSymlink` alone reports as one generic "broken
//     symlink" refusal — distinguished here so a caller (and a test) can
//     tell the two apart;
//   - lexical `..`, an absolute `rel`, or a `rel` that steps through a
//     literal `.git` segment — refused up front, before any filesystem
//     call, so a caller can never accidentally widen `root` to the whole
//     repository's history by constructing a path with `path.join(root,
//     "..", "..git", "hooks", "pre-commit")`.
//
// Writes are ALWAYS atomic (round 3 findings R3-F11/R3-F12 wanted installs
// that do not leave a surface half-written; round 4, R4-F2, found the
// `atomic: false` escape hatch this used to offer wrote straight through a
// hardlink into whatever else that inode was linked to — no caller ever used
// it, so it is simply gone rather than hardened): the payload goes to a temp
// file in the SAME directory as the target (so the final `rename` is
// same-filesystem and atomic on every platform Keryx supports), then renamed
// over the target. R4-F3: when the target already exists, the temp file is
// `chmod`'d to the EXISTING file's mode before the rename, so an atomic
// overwrite preserves it (a plain `rename` over an 0600 file used to leave
// the replacement at the process's default 0644). Only the mode is carried
// forward this way — the owner, group, ACLs and any extra hardlinks on the
// previous inode are NOT preserved, because the replacement is a new inode
// by construction (that is what makes the write atomic).
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { refuseEscapingSymlink } from "./symlink-safety";

export type ContainedWriteReason =
  | "escaping-symlink"
  | "not-contained"
  | "not-a-regular-file"
  | "not-a-directory"
  | "symlink-cycle"
  | "dangling-symlink"
  | "absolute-path"
  | "lexical-traversal"
  | "git-directory"
  | "already-exists";

/** Thrown by every function in this module. `reason` is a stable, named string — never a bare message a caller has to pattern-match. */
export class ContainedWriteError extends Error {
  readonly reason: ContainedWriteReason;
  constructor(reason: ContainedWriteReason, message: string) {
    super(message);
    this.name = "ContainedWriteError";
    this.reason = reason;
  }
}

export interface WriteContainedOptions {
  /** File mode for a newly created file. Ignored when the target already exists — see R4-F3. */
  readonly mode?: number;
  /** Refuse (reason `"already-exists"`) instead of overwriting when the target already exists. */
  readonly exclusive?: boolean;
}

function splitRel(rel: string): string[] {
  return rel.split("/").filter((s) => s.length > 0);
}

/**
 * Lexical checks that need no filesystem access: absolute paths, `..` or `.`
 * segments, a `.git` segment at ANY depth (R4-F2: matched case-insensitively
 * — `.GIT`, `.Git` are the same directory on a case-insensitive filesystem),
 * and a `rel` that is empty, `.`-only, or otherwise resolves to `root` itself
 * (R4-F2: `removeContained(root, "")` used to delete the whole root).
 */
function assertSafeRel(rel: string): string[] {
  if (path.isAbsolute(rel)) {
    throw new ContainedWriteError("absolute-path", `${rel}: refuses an absolute path`);
  }
  const segments = splitRel(rel);
  const nonDotSegments = segments.filter((segment) => segment !== ".");
  if (nonDotSegments.length === 0) {
    throw new ContainedWriteError(
      "lexical-traversal",
      `${JSON.stringify(rel)}: refuses an empty or "." path that resolves to the root itself`,
    );
  }
  for (const segment of segments) {
    if (segment === "..") {
      throw new ContainedWriteError("lexical-traversal", `${rel}: refuses a ".." path segment`);
    }
    if (segment.toLowerCase() === ".git") {
      throw new ContainedWriteError("git-directory", `${rel}: refuses to write through a .git directory`);
    }
  }
  return nonDotSegments;
}

/**
 * Walks `root` -> `rel` segment by segment (mirroring `refuseEscapingSymlink`'s
 * own walk) looking ONLY for a symlink this module cannot even attempt to
 * resolve — a cycle (`ELOOP`) or a dangling target (`ENOENT` on `realpath`
 * of a segment that itself `lstat`s as a symlink). An escaping-but-resolvable
 * symlink is deliberately left for `refuseEscapingSymlink` to report, so the
 * two checks never disagree about what counts as an escape.
 */
async function assertNoCycleOrDangling(root: string, rel: string, segments: string[]): Promise<void> {
  const rootResolved = path.resolve(root);
  let current = rootResolved;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      continue; // does not exist yet.
    }
    if (!stats.isSymbolicLink()) continue;
    try {
      await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const at = path.relative(rootResolved, current) || ".";
      if (code === "ELOOP") {
        throw new ContainedWriteError("symlink-cycle", `${rel}: refuses a symlink cycle at ${at}`);
      }
      throw new ContainedWriteError("dangling-symlink", `${rel}: refuses to write through a broken symlink at ${at}`);
    }
  }
}

interface ContainedTarget {
  /** The lexical `root`/`rel` join — a symlink at this path is NOT followed. */
  readonly targetPath: string;
  readonly dir: string;
  /**
   * `targetPath`, followed through any symlink chain that resolves safely
   * inside root — the same path `writeFile`'s own default (non-`O_NOFOLLOW`)
   * behaviour would write through. Equals `targetPath` when nothing at that
   * path exists yet, or it exists and is not a symlink.
   */
  readonly resolvedPath: string;
  readonly resolvedDir: string;
}

interface AssertOptions {
  /** When the target exists and is not a regular file, refuse (reason `not-a-regular-file`). */
  readonly requireRegularIfExists?: boolean;
  /** When the target exists and is not a directory, refuse (reason `not-a-directory`). */
  readonly requireDirectoryIfExists?: boolean;
}

async function assertContained(root: string, rel: string, opts: AssertOptions = {}): Promise<ContainedTarget> {
  const segments = assertSafeRel(rel);
  await assertNoCycleOrDangling(root, rel, segments);

  const refusal = await refuseEscapingSymlink(root, rel);
  if (refusal) {
    throw new ContainedWriteError("escaping-symlink", refusal);
  }

  const rootResolved = path.resolve(root);
  const targetPath = path.join(rootResolved, ...segments);

  // Belt-and-braces: the two checks above only inspect symlink SEGMENTS.
  // Confirm the fully resolved target (when it exists) still lands inside
  // root's own real path — covers the pathological case of a root itself
  // reached through a symlink that moved between the two checks.
  const rootReal = await realpath(rootResolved).catch(() => rootResolved);
  const targetReal = await realpath(targetPath).catch(() => null);
  if (targetReal !== null) {
    const relToRoot = path.relative(rootReal, targetReal);
    const escapes = relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot);
    if (escapes) {
      throw new ContainedWriteError("not-contained", `${rel}: resolves outside ${rootReal}`);
    }
  }

  if (opts.requireRegularIfExists || opts.requireDirectoryIfExists) {
    // `stat`, not `lstat`: the symlink-containment checks above already
    // establish that any symlink on this path resolves safely inside root,
    // so what matters here is the KIND of thing at the resolved target — a
    // symlink pointing at an ordinary file (e.g. `CLAUDE.md -> AGENTS.md`,
    // an in-repo layout `markdown-block.ts` must keep writing through) is a
    // regular file for this purpose, not "not a regular file".
    let stats;
    try {
      stats = await stat(targetPath);
    } catch {
      stats = undefined;
    }
    if (stats) {
      if (opts.requireRegularIfExists && !stats.isFile()) {
        throw new ContainedWriteError("not-a-regular-file", `${rel}: refuses to overwrite a non-regular-file entry`);
      }
      if (opts.requireDirectoryIfExists && !stats.isDirectory()) {
        throw new ContainedWriteError("not-a-directory", `${rel}: refuses — a non-directory entry is already there`);
      }
    }
  }

  const resolvedPath = targetReal ?? targetPath;
  return { targetPath, dir: path.dirname(targetPath), resolvedPath, resolvedDir: path.dirname(resolvedPath) };
}

async function pathExistsLstat(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to `root`/`rel`, containment-checked. Creates parent
 * directories as needed. Atomic by default: writes to a temp file beside
 * the target, then renames — a reader never observes a partial write, and a
 * crash mid-write leaves the original file (or no file) rather than a
 * truncated one.
 */
export async function writeContained(
  root: string,
  rel: string,
  data: string | Uint8Array,
  opts: WriteContainedOptions = {},
): Promise<void> {
  const { resolvedPath, resolvedDir } = await assertContained(root, rel, { requireRegularIfExists: true });

  if (opts.exclusive) {
    // R1-F9: a true `O_EXCL` create — `open(resolvedPath, "wx")` atomically
    // fails with `EEXIST` if anything is there — rather than the old
    // lstat-then-temp-file-then-rename sequence, whose final `rename`
    // unconditionally overwrote whatever a racing writer created in the gap
    // between the lstat check and the rename, however small. This does NOT
    // go through the temp-file-then-rename dance the non-exclusive branch
    // below uses (that dance is for atomically REPLACING a file that already
    // exists — there is nothing to replace here): `wx` both creates and
    // writes in one open, so a reader can only ever observe "not there yet"
    // or "present with this exact content", never a half-written temp file
    // racing into place. `resolvedPath` is safe to open directly for the
    // same reason it always was: `assertContained` above already walked
    // every symlink segment on the way there and refused a dangling or
    // escaping one, so by this point `resolvedPath` is either the plain
    // (non-symlink) target itself, or a symlink's real target confirmed to
    // resolve safely inside `root` — an `EEXIST` here means precisely "a
    // file, or a symlink pointing at one, already sits at `rel`", matching
    // what the old lstat-on-`targetPath` check refused.
    await mkdir(resolvedDir, { recursive: true });
    let handle;
    try {
      handle = await open(resolvedPath, "wx", opts.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ContainedWriteError("already-exists", `${rel}: refuses to overwrite an existing file (exclusive write)`);
      }
      throw error;
    }
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return;
  }

  // Writes go to `resolvedPath` — `targetPath` followed through any safe
  // in-root symlink chain — never `targetPath` itself, so an atomic
  // temp-file-then-rename write lands its new content in the symlink's
  // TARGET, preserving the symlink, exactly like `writeFile`'s own default
  // (non-`O_NOFOLLOW`) behaviour every retrofitted call site relied on
  // (`CLAUDE.md -> AGENTS.md` and similar in-repo layouts).
  await mkdir(resolvedDir, { recursive: true });

  // R4-F3: preserve the existing target's mode across an atomic overwrite.
  // `undefined` (no existing file) leaves `opts.mode` — the caller's
  // requested mode for a NEW file, `open`'s own default when omitted — alone.
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(resolvedPath)).mode & 0o777;
  } catch {
    existingMode = undefined;
  }

  const tmp = path.join(resolvedDir, `.${path.basename(resolvedPath)}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    const handle = await open(tmp, "wx", opts.mode);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    if (existingMode !== undefined) {
      await chmod(tmp, existingMode);
    }
    await rename(tmp, resolvedPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Append `data` to `root`/`rel`, containment-checked (R700-03 fix). Creates
 * the file and its parent directories when absent. Unlike `writeContained`,
 * this is not an atomic-replace: an append is inherently a modification of
 * whatever is already there, so there is no temp-file-then-rename dance —
 * the write goes straight to the target through a file descriptor opened
 * with `O_APPEND`.
 *
 * The same containment walk `writeContained` runs (`assertContained`:
 * lexical checks, cycle/dangling detection, `refuseEscapingSymlink` over
 * every segment, and a final resolved-realpath confirmation) refuses a
 * symlinked directory or file anywhere on the path BEFORE this function ever
 * opens anything. The `open()` call itself then adds `O_NOFOLLOW` (where the
 * platform defines it — POSIX only; a no-op bitmask on platforms that
 * don't) on the FINAL component as a second, independent guard: it closes
 * the narrow TOCTOU window between that check and this open (a symlink
 * swapped into place at `resolvedPath` after `assertContained` resolved it
 * but before `open` runs) by refusing to follow a symlink at open time,
 * rather than trusting the earlier resolution to still hold.
 */
export async function appendContained(
  root: string,
  rel: string,
  data: string | Uint8Array,
  opts: { readonly mode?: number } = {},
): Promise<void> {
  const { resolvedPath, resolvedDir } = await assertContained(root, rel, { requireRegularIfExists: true });
  await mkdir(resolvedDir, { recursive: true });

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow;
  let handle;
  try {
    handle = await open(resolvedPath, flags, opts.mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ContainedWriteError(
        "escaping-symlink",
        `${rel}: refuses to append through a symlink at the final path component (raced into place after the containment check)`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Remove `root`/`rel`, containment-checked. Returns `false` when there was
 * nothing there (never an error — mirrors the `{ force: true }` idiom every
 * retrofitted call site already relied on), `true` when something was
 * removed. Refuses (rather than silently no-op'ing) on every containment
 * violation, exactly like `writeContained`.
 */
export async function removeContained(root: string, rel: string): Promise<boolean> {
  const { targetPath } = await assertContained(root, rel);
  if (!(await pathExistsLstat(targetPath))) return false;
  await rm(targetPath, { force: true, recursive: true });
  return true;
}

/** Create `root`/`rel` (and its parents), containment-checked. Idempotent. */
export async function mkdirContained(root: string, rel: string): Promise<void> {
  const { targetPath } = await assertContained(root, rel, { requireDirectoryIfExists: true });
  await mkdir(targetPath, { recursive: true });
}

/**
 * Rename `root`/`fromRel` to `root`/`toRel`, both containment-checked. The
 * destination's parent directories are created as needed. `fromRel` must
 * already exist as a regular file (or directory) — this is not a general
 * "maybe create" helper.
 */
export async function renameContained(root: string, fromRel: string, toRel: string): Promise<void> {
  const from = await assertContained(root, fromRel);
  if (!(await pathExistsLstat(from.targetPath))) {
    throw new ContainedWriteError("not-contained", `${fromRel}: no such file to rename`);
  }
  const to = await assertContained(root, toRel);
  await mkdir(to.dir, { recursive: true });
  await rename(from.targetPath, to.targetPath);
}

/**
 * Remove `root`/`rel` (a directory) iff it is empty, containment-checked.
 * Returns `false` when the directory does not exist or is not empty — never
 * an error for either, since callers use this to clean up now-empty
 * directories left behind by an uninstall (R3-F24) and "not empty" is an
 * ordinary outcome, not a fault.
 */
export async function rmdirIfEmptyContained(root: string, rel: string): Promise<boolean> {
  const { targetPath } = await assertContained(root, rel, { requireDirectoryIfExists: true });
  let entries: string[];
  try {
    entries = await readdir(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (entries.length > 0) return false;
  await rmdir(targetPath);
  return true;
}
