// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", fail-closed
// rule 2 ("Private-dir `.gitignore` conflict fails closed"), W4-AC8.
//
// A private-scope directory (e.g. `~/.keryx/memory/`, or a project-local
// private memory subtree) is expected to own a `.gitignore` it manages. If
// that file already exists with different content, Keryx never overwrites or
// appends to it silently — it refuses and surfaces the conflict.

import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "./fs";

export const PRIVATE_DIR_GITIGNORE =
  "# keryx:private-dir — managed by keryx; this directory stays out of version control\n*\n!.gitignore\n";

export type PrivateDirCheck =
  | { ok: true; action: "create" | "present" }
  | { ok: false; reason: "private-gitignore-conflict"; message: string };

/**
 * Read-only check of `<dir>/.gitignore` against the keryx-managed contents.
 *
 * - Absent -> `{ ok: true, action: "create" }`.
 * - Present with byte-identical contents -> `{ ok: true, action: "present" }`.
 * - Present with anything else (different bytes, a symlink, a directory, or
 *   any other non-regular-file) -> a named refusal. Never mutates anything.
 */
export async function checkPrivateDirGitignore(dir: string): Promise<PrivateDirCheck> {
  const gitignorePath = path.join(dir, ".gitignore");
  let stats;
  try {
    stats = await stat(gitignorePath);
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

  if (!stats.isFile()) {
    return {
      ok: false,
      reason: "private-gitignore-conflict",
      message: `${gitignorePath} exists and is not a regular file (e.g. a symlink or a directory); keryx will not manage it.`,
    };
  }

  const bytes = await readFile(gitignorePath);
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
    // check and this write: re-check rather than assume our own state.
    if (isExists(error)) {
      return checkPrivateDirGitignore(dir);
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
