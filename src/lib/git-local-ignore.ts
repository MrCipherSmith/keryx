// Flow 361: ignore rules that never touch a tracked file. "Is this path
// ignored" is asked of git itself, and the managed `# keryx:begin … # keryx:end`
// block goes to `<git-common-dir>/info/exclude` — per clone, shared by every
// linked worktree, invisible to `git status` — instead of the tracked
// `.gitignore`.
//
// WHY RAW WRITES (contained-write ratchet allowlist): `info/exclude` lives
// inside `.git`, and from a linked worktree the common dir is not even under
// the project root, so `writeContained` refuses it on both counts. As in
// `managed-git-hook.ts`, this module carries its own containment instead:
// before the one `mkdir`/`writeFile` below, `info/` and `info/exclude` are
// `lstat`ed and, where either is a symlink, must resolve inside the
// `realpath`'d git common dir — otherwise the write is refused, not followed.

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveGitCommonDir } from "./git-worktrees";

const BLOCK_START = "# keryx:begin";
const BLOCK_END = "# keryx:end";

/** `git: false` outside a git repository (or without a `git` binary): there is nothing to ask. */
export type IgnoreCheck = { git: true; ignored: boolean } | { git: false };

export type EnsureLocalIgnoreResult =
  | { status: "not-a-git-repository" }
  /** Every pattern was already in the managed block; nothing was written. */
  | { status: "unchanged"; excludePath: string }
  | { status: "written"; excludePath: string; added: string[] }
  /** The exclude file could not be reached safely; nothing was written. */
  | { status: "refused"; excludePath: string; detail: string };

/**
 * Whether git's ignore rules (`.gitignore` files, `info/exclude`, the user's
 * global excludes) match `relativePath`. Uses `--no-index`, so a path that is
 * already tracked gets the rules' own answer — plain `git check-ignore`
 * reports every tracked path as not ignored. A trailing `/` asks about a
 * directory; the path need not exist.
 */
export async function isPathIgnored(projectRoot: string, relativePath: string): Promise<IgnoreCheck> {
  if ((await resolveGitCommonDir(projectRoot)) === undefined) return { git: false };
  try {
    const proc = Bun.spawn(["git", "check-ignore", "--quiet", "--no-index", "--", relativePath], {
      cwd: projectRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    // 0 = ignored, 1 = not ignored; anything else (a path outside the
    // repository, for one) matched no rule either.
    return { git: true, ignored: (await proc.exited) === 0 };
  } catch {
    return { git: false };
  }
}

/** Whether `.metaproject/` is ignored as a whole directory — the team keeps the workspace out of git. */
export async function isMetaprojectIgnoredAsWhole(projectRoot: string): Promise<IgnoreCheck> {
  return isPathIgnored(projectRoot, ".metaproject/");
}

/**
 * `<git-common-dir>/info/exclude` for `projectRoot` — the main checkout's
 * file from any linked worktree. `undefined` outside a git repository.
 */
export async function resolveLocalExcludePath(projectRoot: string): Promise<string | undefined> {
  const commonDir = await resolveGitCommonDir(projectRoot);
  return commonDir === undefined ? undefined : path.join(commonDir, "info", "exclude");
}

/**
 * Makes sure every line of `patterns` is present in the managed block of the
 * local exclude file. Additive: lines already in the block stay, missing ones
 * are appended in the order given, and everything outside the block is left
 * as it was. A second call with the same patterns writes nothing. Creates
 * `info/` and the file when missing. Never throws for "not a git repository"
 * or an unsafe destination — both come back as a status.
 */
export async function ensureLocalIgnorePatterns(
  projectRoot: string,
  patterns: readonly string[],
): Promise<EnsureLocalIgnoreResult> {
  const commonDir = await resolveGitCommonDir(projectRoot);
  if (commonDir === undefined) return { status: "not-a-git-repository" };
  const infoDir = path.join(commonDir, "info");
  const excludePath = path.join(infoDir, "exclude");

  const refusal = await refuseUnsafeExcludePath(commonDir, infoDir, excludePath);
  if (refusal !== undefined) return { status: "refused", excludePath, detail: refusal };

  const existing = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const blockPattern = new RegExp(`${escapeRegExp(BLOCK_START)}\\n([\\s\\S]*?)${escapeRegExp(BLOCK_END)}`);
  const current = blockPattern.exec(existing);
  const lines = current === null ? [] : (current[1] ?? "").split("\n").filter((line) => line.trim().length > 0);

  const present = new Set(lines.map((line) => line.trim()));
  const added: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed.length === 0 || present.has(trimmed)) continue;
    present.add(trimmed);
    added.push(trimmed);
  }
  if (added.length === 0) return { status: "unchanged", excludePath };

  const managedBlock = `${BLOCK_START}\n${[...lines, ...added].join("\n")}\n${BLOCK_END}`;
  const head = existing.trimEnd();
  // `() => managedBlock`: the string form of `replace` would read `$&`-style
  // sequences in a pattern line as substitutions.
  const next =
    current !== null
      ? existing.replace(blockPattern, () => managedBlock)
      : `${head.length > 0 ? `${head}\n\n` : ""}${managedBlock}\n`;

  await mkdir(infoDir, { recursive: true });
  await writeFile(excludePath, next, "utf8");
  return { status: "written", excludePath, added };
}

/** A reason to refuse writing `excludePath`, or `undefined` when it is safe to. */
async function refuseUnsafeExcludePath(commonDir: string, infoDir: string, excludePath: string): Promise<string | undefined> {
  const commonDirReal = await realpath(commonDir).catch(() => commonDir);
  for (const [target, label] of [
    [infoDir, "the git info directory"],
    [excludePath, "the git exclude file"],
  ] as const) {
    const stats = await lstat(target).catch(() => null);
    if (stats === null) continue;
    if (stats.isSymbolicLink()) {
      const real = await realpath(target).catch(() => undefined);
      if (real === undefined) return `${label} (${target}) is a dangling symlink — refusing to write through it`;
      const rel = path.relative(commonDirReal, real);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return `${label} (${target}) resolves outside the git common dir (${commonDirReal}) — refusing to write through it`;
      }
      continue;
    }
    const expectsDirectory = target === infoDir;
    if (expectsDirectory ? !stats.isDirectory() : !stats.isFile()) {
      return `${label} (${target}) is not a ${expectsDirectory ? "directory" : "regular file"}`;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
