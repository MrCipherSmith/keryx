// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", fail-closed
// rule 2 ("Private-dir `.gitignore` conflict fails closed"), W4-AC8.
//
// A private-scope directory (e.g. `~/.keryx/memory/`, or a project-local
// private memory subtree) is expected to own a `.gitignore` it manages. If
// that file already exists with different content, Keryx never overwrites or
// appends to it silently — it refuses and surfaces the conflict.

import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "./fs";

export const PRIVATE_DIR_GITIGNORE =
  "# keryx:private-dir — managed by keryx; this directory stays out of version control\n*\n!.gitignore\n";

export type PrivateDirCheck =
  | { ok: true; action: "create" | "present" }
  | { ok: false; reason: "private-gitignore-conflict"; message: string };

/**
 * Read-only check of `dir` and `<dir>/.gitignore` against the keryx-managed
 * contents.
 *
 * - `dir` absent -> `{ ok: true, action: "create" }`.
 * - `dir` itself a symlink -> a named refusal (R1-F15/R1-F27 G5): keryx never
 *   manages a private directory reached through a link, even when the real
 *   directory it points at already holds a byte-identical `.gitignore`.
 * - `<dir>/.gitignore` absent -> `{ ok: true, action: "create" }`.
 * - `<dir>/.gitignore` a symlink (live OR dangling) -> a named refusal
 *   (R1-F15 G1/G2), never followed to read what it points at — a dangling
 *   symlink is not "absent": `lstat` (never `stat`) sees the link itself
 *   without resolving its target, so this is caught before any "the target
 *   doesn't exist, so create" reasoning is even possible.
 * - `<dir>/.gitignore` present, a regular file, byte-identical contents ->
 *   `{ ok: true, action: "present" }`.
 * - `<dir>/.gitignore` present, a regular file, anything else (different
 *   bytes, or unreadable) -> a named refusal (R1-F27: an unreadable file is
 *   a refusal, never a thrown exception).
 * - `<dir>/.gitignore` present and not a regular file (a directory, etc.) ->
 *   a named refusal.
 *
 * Never mutates anything.
 */
export async function checkPrivateDirGitignore(dir: string): Promise<PrivateDirCheck> {
  let dirStats;
  try {
    dirStats = await lstat(dir);
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, action: "create" };
    }
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${dir} could not be read: ${message(error)}`,
    };
  }
  if (dirStats.isSymbolicLink()) {
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${dir} is a symlink; keryx will not manage a private directory reached through a symlink.`,
    };
  }

  const gitignorePath = path.join(dir, ".gitignore");
  let stats;
  try {
    // `lstat`, never `stat`: a `stat` on a dangling symlink throws ENOENT —
    // indistinguishable from the file simply being absent — which is
    // exactly the R1-F15 G2 bug (a dangling `.gitignore` symlink read as
    // "create", then silently writing nothing because the exclusive create
    // below also sees something already at that path).
    stats = await lstat(gitignorePath);
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, action: "create" };
    }
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} could not be read: ${message(error)}`,
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} is a symlink; keryx will not manage or follow it, even to identical content.`,
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} exists and is not a regular file (e.g. a directory); keryx will not manage it.`,
    };
  }

  let bytes;
  try {
    bytes = await readFile(gitignorePath);
  } catch (error) {
    // R1-F27 G4: an existing regular file that cannot be READ (e.g. mode
    // 000) is a named refusal, not a thrown EACCES — the caller gets a
    // reason string every time, never a crash it has to catch itself.
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} could not be read: ${message(error)}`,
    };
  }
  if (bytes.equals(Buffer.from(PRIVATE_DIR_GITIGNORE, "utf8"))) {
    return { ok: true, action: "present" };
  }

  return {
    ok: false,
    reason: "private-gitignore-conflict",
    message: `${gitignorePath} already exists with different content that keryx did not write; refusing to overwrite or append to it.`,
  };
}

/**
 * Same check as `checkPrivateDirGitignore`, and on `"create"` additionally
 * creates `dir` (recursively) and writes the managed `.gitignore` file with an
 * exclusive create (`wx`), so a concurrent writer racing this call is never
 * clobbered — whichever process wins the exclusive create keeps its file, and
 * the loser's write fails closed rather than silently overwriting it. Never
 * modifies an existing `.gitignore`.
 */
export async function ensurePrivateDirGitignore(dir: string): Promise<PrivateDirCheck> {
  const check = await checkPrivateDirGitignore(dir);
  if (!check.ok || check.action === "present") {
    return check;
  }

  const gitignorePath = path.join(dir, ".gitignore");
  await mkdir(dir, { recursive: true });
  try {
    const handle = await open(gitignorePath, "wx");
    try {
      await handle.writeFile(PRIVATE_DIR_GITIGNORE, "utf8");
    } finally {
      await handle.close();
    }
    return { ok: true, action: "create" };
  } catch (error) {
    // A concurrent writer won the exclusive create between our read-only
    // check and this write: re-check rather than assume our own state. The
    // re-check is the SAME symlink-aware `checkPrivateDirGitignore` above,
    // so a concurrent writer that raced us with a symlink (not a real file)
    // is refused here too, never silently reported back as "created".
    if (isExists(error)) {
      const recheck = await checkPrivateDirGitignore(dir);
      if (recheck.ok && recheck.action === "create") {
        // R1-F15/R1-F27: `open(..., "wx")` said something is already at
        // this path (EEXIST), but the re-check reports "absent" again — a
        // transient state `lstat` cannot resolve to a real file. Refused
        // rather than reported as a bare, unverified success: EEXIST on
        // exclusive create is re-checked and refused unless the re-check
        // finds EXACTLY the managed content already present.
        return {
          ok: false,
          reason: "private-gitignore-conflict",
          message: `${gitignorePath} could not be verified after a concurrent write; refusing.`,
        };
      }
      return recheck;
    }
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} could not be created: ${message(error)}`,
    };
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
