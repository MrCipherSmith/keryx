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
// before the one `mkdir`/`writeFile` below (`writeExcludeFile`, shared by the
// additive and the replace writer), `info/` and `info/exclude` are
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

  await writeExcludeFile(infoDir, excludePath, next);
  return { status: "written", excludePath, added };
}

/** The one raw write of this module; both callers have run `refuseUnsafeExcludePath` first. */
async function writeExcludeFile(infoDir: string, excludePath: string, content: string): Promise<void> {
  await mkdir(infoDir, { recursive: true });
  await writeFile(excludePath, content, "utf8");
}

export type ReplaceLocalIgnoreResult =
  | { status: "not-a-git-repository" }
  /** The managed block already holds exactly these lines (or there is none and none is wanted). */
  | { status: "unchanged"; excludePath: string }
  | { status: "written"; excludePath: string; added: string[]; removed: string[] }
  /** The exclude file could not be reached safely; nothing was written. */
  | { status: "refused"; excludePath: string; detail: string };

/**
 * Makes the managed block of the local exclude file hold exactly `lines` —
 * the replace-mode twin of `ensureLocalIgnorePatterns`. A line keryx stopped
 * emitting, or one the repository has started ignoring itself, leaves the
 * block; everything outside the markers is left as it was, and a second call
 * with the same lines writes nothing. No lines means no block: an existing
 * one is removed and none is created.
 *
 * `lines` are written the way they would stand in a `.gitignore` at
 * `projectRoot` (comments included). `info/exclude` patterns are relative to
 * the repository top level and the file is shared by every project in the
 * repository, so a project in a subdirectory gets its patterns prefixed and a
 * block of its own (`# keryx:begin <prefix>`), which a replace from another
 * project cannot touch.
 */
export async function replaceLocalIgnoreBlock(projectRoot: string, lines: readonly string[]): Promise<ReplaceLocalIgnoreResult> {
  const commonDir = await resolveGitCommonDir(projectRoot);
  const location = commonDir === undefined ? undefined : await resolveWorktreeLocation(projectRoot);
  if (commonDir === undefined || location === undefined) return { status: "not-a-git-repository" };
  const infoDir = path.join(commonDir, "info");
  const excludePath = path.join(infoDir, "exclude");

  const refusal = await refuseUnsafeExcludePath(commonDir, infoDir, excludePath);
  if (refusal !== undefined) return { status: "refused", excludePath, detail: refusal };

  const existing = await readExcludeFile(excludePath);
  const current = findManagedBlock(existing, location.prefix);
  const held = current?.lines ?? [];
  const wanted = [...new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0))].map((line) =>
    scopedPattern(line, location.prefix),
  );
  const same = held.length === wanted.length && held.every((line, index) => line === wanted[index]);
  if (wanted.length === 0 ? current === undefined : current !== undefined && same) return { status: "unchanged", excludePath };

  let next: string;
  if (wanted.length === 0 && current !== undefined) {
    // Take the block's own line terminator with it, and the blank line that
    // separated it from what came before when nothing follows.
    const before = existing.slice(0, current.start);
    const after = existing.slice(current.end).replace(/^\r?\n/, "");
    const head = before.trimEnd();
    next = after.trim().length > 0 ? `${before}${after}` : head.length > 0 ? `${head}\n` : "";
  } else {
    const markers = blockMarkers(location.prefix);
    const managedBlock = `${markers.start}\n${wanted.join("\n")}\n${markers.end}`;
    const head = existing.trimEnd();
    next =
      current !== undefined
        ? `${existing.slice(0, current.start)}${managedBlock}${existing.slice(current.end)}`
        : `${head.length > 0 ? `${head}\n\n` : ""}${managedBlock}\n`;
  }

  await writeExcludeFile(infoDir, excludePath, next);
  return {
    status: "written",
    excludePath,
    added: wanted.filter((line) => !held.includes(line)),
    removed: held.filter((line) => !wanted.includes(line)),
  };
}

export type IgnoreExplanation = {
  /** The path as it was asked about. */
  path: string;
  /** False when no rule matched, and when the winning rule is a `!` re-include. */
  ignored: boolean;
  /** The winning rule is a line of this project's managed block in the local exclude file. */
  managed: boolean;
  /** `<source>:<line>` of the winning rule — a `!` rule included; absent when no rule matched. */
  rule?: string;
};

/**
 * For each of `relativePaths`, which ignore rule decides it (`git
 * check-ignore --verbose --no-index`). Git reports the one rule that wins —
 * `.gitignore` files outrank `info/exclude`, which outranks the global
 * excludes file — so `ignored && !managed` means the repository ignores the
 * path without keryx's block, and the block does not need to say it again.
 * `undefined` outside a git working tree.
 */
export async function explainIgnoredPaths(
  projectRoot: string,
  relativePaths: readonly string[],
): Promise<IgnoreExplanation[] | undefined> {
  const commonDir = await resolveGitCommonDir(projectRoot);
  const location = commonDir === undefined ? undefined : await resolveWorktreeLocation(projectRoot);
  if (commonDir === undefined || location === undefined) return undefined;
  if (relativePaths.length === 0) return [];

  const excludePath = path.join(commonDir, "info", "exclude");
  // Read-only here: an exclude file that cannot be read has no managed block to find.
  const block = findManagedBlock(await readExcludeFile(excludePath).catch(() => ""), location.prefix);
  const excludeReal = await realpath(excludePath).catch(() => excludePath);

  let fields: string[];
  try {
    const proc = Bun.spawn(["git", "check-ignore", "--verbose", "--non-matching", "--no-index", "-z", "--stdin"], {
      cwd: projectRoot,
      stdin: new TextEncoder().encode(`${relativePaths.join("\0")}\0`),
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    // 0 = at least one path ignored, 1 = none; anything else is git failing.
    if ((await proc.exited) > 1) return undefined;
    fields = stdout.split("\0");
  } catch {
    return undefined;
  }
  // `<source> NUL <line> NUL <pattern> NUL <path> NUL` per path.
  if (fields.length < relativePaths.length * 4) return undefined;

  const inExcludeFile = new Map<string, boolean>();
  const explanations: IgnoreExplanation[] = [];
  for (const [index, asked] of relativePaths.entries()) {
    const source = fields[index * 4] ?? "";
    const line = Number(fields[index * 4 + 1] ?? "");
    const pattern = fields[index * 4 + 2] ?? "";
    if (source.length === 0) {
      explanations.push({ path: asked, ignored: false, managed: false });
      continue;
    }
    let fromExclude = inExcludeFile.get(source);
    if (fromExclude === undefined) {
      // Git names a source relative to the top level, or absolutely.
      const resolved = path.resolve(location.toplevel, source);
      fromExclude = (await realpath(resolved).catch(() => resolved)) === excludeReal;
      inExcludeFile.set(source, fromExclude);
    }
    const ignored = !pattern.startsWith("!");
    const managed = ignored && fromExclude && block !== undefined && line > block.firstLine && line < block.lastLine;
    explanations.push({ path: asked, ignored, managed, rule: `${source}:${line}` });
  }
  return explanations;
}

type ManagedBlock = {
  /** Offsets of the block in the file: the begin marker's first character, and one past the end marker's last. */
  start: number;
  end: number;
  /** The non-blank lines between the markers, trimmed. */
  lines: string[];
  /** 1-based line numbers of the two marker lines. */
  firstLine: number;
  lastLine: number;
};

function blockMarkers(prefix: string): { start: string; end: string } {
  return prefix.length === 0 ? { start: BLOCK_START, end: BLOCK_END } : { start: `${BLOCK_START} ${prefix}`, end: `${BLOCK_END} ${prefix}` };
}

/** The managed block of the project at `prefix`, matched on whole marker lines so one project's block is never taken for another's. */
function findManagedBlock(content: string, prefix: string): ManagedBlock | undefined {
  const markers = blockMarkers(prefix);
  const pattern = new RegExp(`^${escapeRegExp(markers.start)}[ \\t]*\\r?\\n([\\s\\S]*?)^${escapeRegExp(markers.end)}[ \\t]*$`, "m");
  const match = pattern.exec(content);
  if (match === null) return undefined;
  const firstLine = content.slice(0, match.index).split("\n").length;
  return {
    start: match.index,
    end: match.index + match[0].length,
    lines: (match[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    firstLine,
    lastLine: firstLine + match[0].split("\n").length - 1,
  };
}

/**
 * A `.gitignore`-style line of the project at `prefix`, as an `info/exclude`
 * pattern. A pattern with no slash matches at any depth in a `.gitignore`,
 * so it keeps doing that below the project root: a `**` segment goes between
 * the prefix and the name.
 */
function scopedPattern(line: string, prefix: string): string {
  if (prefix.length === 0 || line.startsWith("#")) return line;
  const escaped = prefix.replace(/[\\*?[\]]/g, "\\$&").replace(/^[#!]/, "\\$&");
  const anchored = line.replace(/\/$/, "").includes("/");
  return anchored ? `${escaped}${line.replace(/^\//, "")}` : `${escaped}**/${line}`;
}

/**
 * Where `projectRoot` sits in its working tree: the top level, and the path
 * from there down to `projectRoot` (`""` at the top, else ending in `/`).
 * `undefined` without a working tree — a bare repository, or inside `.git`.
 */
async function resolveWorktreeLocation(projectRoot: string): Promise<{ toplevel: string; prefix: string } | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel", "--show-prefix"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    const [toplevel = "", prefix = ""] = out.split(/\r?\n/);
    return toplevel.length === 0 ? undefined : { toplevel, prefix };
  } catch {
    return undefined;
  }
}

async function readExcludeFile(excludePath: string): Promise<string> {
  return readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
    throw error;
  });
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
