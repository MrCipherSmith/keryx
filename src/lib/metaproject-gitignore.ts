import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { removeContained, writeContained } from "./contained-write";
import { readHeadBlob, restoreWorktreeFileFromHead, worktreeFileIsClean } from "./git-head";
import {
  explainIgnoredPaths,
  isMetaprojectIgnoredAsWhole,
  planLocalIgnoreBlock,
  replaceLocalIgnoreBlock,
  resolveLocalExcludePath,
  type PlanLocalIgnoreResult,
} from "./git-local-ignore";

export const LEGACY_MEMORY_ARTIFACT_PATHS = [
  ".metaproject/data/memory/artifacts/latest.md",
  ".metaproject/data/memory/artifacts/latest.json",
] as const;

export type LegacyMemoryArtifact = {
  path: (typeof LEGACY_MEMORY_ARTIFACT_PATHS)[number];
  tracked: boolean;
};

const GITIGNORE = ".gitignore";
const BLOCK_START = "# keryx:begin";
const BLOCK_END = "# keryx:end";
const LOCAL_TARGETS_COMMENT = "# Per-developer agent files keryx writes; they are never committed.";
/** Stands in for `*` and `**` when a pattern is turned into a path git can be asked about. */
const PROBE_SEGMENT = "keryx-probe";

export type SyncIgnoreRulesOptions = {
  /** The project-relative paths keryx writes under `scope: "local"` (`localTargetPaths`). */
  localTargets?: readonly string[];
  /** Receives one line per thing the developer should know: a migrated `.gitignore`, a skipped step. */
  onNotice?: (line: string) => void;
};

export type SyncIgnoreRulesResult = {
  status: "not-a-git-repository" | "unchanged" | "written" | "refused";
  /** The patterns the managed block holds after this run, as written in `.gitignore` terms. */
  entries: string[];
};

/**
 * Flow 361: keryx's ignore rules, without touching a tracked file. The
 * managed block goes to `<git-common-dir>/info/exclude` and holds only what
 * the repository does not already ignore — git is asked per entry, so a rule
 * in the team's `.gitignore`, in the global excludes file, or a blanket
 * `.metaproject/` line each make the matching entries unnecessary. When
 * nothing is left, nothing is written.
 *
 * A blanket `.metaproject/` line used to be edited here (dropped where
 * `.metaproject` was tracked, kept otherwise). It is the team's rule in the
 * team's file either way, so it is now only read: it means "no `.metaproject`
 * entry is needed".
 *
 * A managed block an older keryx left in `.gitignore` is moved out first —
 * see `moveBlockOutOfGitignore`. Outside a git repository there is no exclude
 * file and no `HEAD`; the step is skipped with one note and `.gitignore` is
 * neither created nor changed.
 */
export async function syncMetaprojectIgnoreRules(
  projectRoot: string,
  options: SyncIgnoreRulesOptions = {},
): Promise<SyncIgnoreRulesResult> {
  const notice = options.onNotice ?? (() => {});
  const localTargets = [...new Set(options.localTargets ?? [])];
  const excludePath = await resolveLocalExcludePath(projectRoot);
  if (excludePath === undefined) {
    notice(
      "Ignore rules: skipped — not a git repository, so there is no info/exclude to write and .gitignore is left as it is. " +
        "Run `keryx update` after `git init` to have keryx's generated and per-developer files ignored.",
    );
    return { status: "not-a-git-repository", entries: [] };
  }

  await moveBlockOutOfGitignore(projectRoot, notice);

  const wanted = await wantedIgnoreLines(projectRoot, localTargets, undefined);
  if (wanted === undefined) {
    notice("Ignore rules: skipped — git could not evaluate ignore rules here (no working tree); nothing was written.");
    return { status: "not-a-git-repository", entries: [] };
  }
  const { lines, entries, reincluded } = wanted;
  const result = await replaceLocalIgnoreBlock(projectRoot, lines);

  const shown = displayPath(projectRoot, excludePath);
  if (result.status === "refused") {
    notice(`Ignore rules: not written — ${result.detail}`);
  } else if (result.status === "written") {
    notice(
      entries.length > 0
        ? `Ignore rules: ${shown} now holds keryx's managed block (${entries.length} entries); .gitignore is not modified.`
        : `Ignore rules: removed keryx's managed block from ${shown} — the repository's own rules already ignore every entry.`,
    );
  }
  if (reincluded.length > 0) {
    notice(
      `Ignore rules: ${reincluded.join(", ")} — a \`!\` rule re-includes ${reincluded.length === 1 ? "this per-developer file" : "these per-developer files"}, ` +
        "and it outranks info/exclude. Remove that rule, or the file will show up in `git status`.",
    );
  }
  return { status: result.status, entries };
}

export type IgnoreRulesPlan =
  | { status: "not-a-git-repository" }
  | {
      status: "planned";
      /** What becomes of a managed block in `.gitignore`: none there, committed in `HEAD` (stays), or moved out. */
      gitignoreBlock: "none" | "committed" | "moves";
      /** `info/exclude`: already holding exactly these entries, or about to be written. */
      exclude: PlanLocalIgnoreResult;
      /** The patterns the managed block would hold, as written in `.gitignore` terms. */
      entries: string[];
    };

/**
 * What `syncMetaprojectIgnoreRules` would do, without writing anything — the
 * read-only twin `init --preview` and `update --preview` print. A managed
 * block `.gitignore` still carries as an uncommitted edit is about to move, so
 * the entries it covers today count as not yet ignored.
 */
export async function planMetaprojectIgnoreRules(
  projectRoot: string,
  options: Pick<SyncIgnoreRulesOptions, "localTargets"> = {},
): Promise<IgnoreRulesPlan> {
  if ((await resolveLocalExcludePath(projectRoot)) === undefined) return { status: "not-a-git-repository" };
  const gitignorePath = path.join(projectRoot, GITIGNORE);
  const content = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  let gitignoreBlock: "none" | "committed" | "moves" = "none";
  let pending: PendingGitignoreBlock | undefined;
  const match = managedBlockPattern().exec(content);
  if (match !== null) {
    const head = await readHeadBlob(projectRoot, GITIGNORE);
    gitignoreBlock = head !== undefined && managedBlockPattern().test(head) ? "committed" : "moves";
    if (gitignoreBlock === "moves") {
      const firstLine = content.slice(0, match.index).split("\n").length;
      pending = {
        sourcePath: await realpath(gitignorePath).catch(() => gitignorePath),
        firstLine,
        lastLine: firstLine + match[0].split("\n").length - 1,
      };
    }
  }
  const wanted = await wantedIgnoreLines(projectRoot, [...new Set(options.localTargets ?? [])], pending);
  if (wanted === undefined) return { status: "not-a-git-repository" };
  return { status: "planned", gitignoreBlock, exclude: await planLocalIgnoreBlock(projectRoot, wanted.lines), entries: wanted.entries };
}

/** A managed block still in `.gitignore` that is about to move: its lines do not count as already ignoring anything. */
type PendingGitignoreBlock = { sourcePath: string; firstLine: number; lastLine: number };

/**
 * The lines the managed block in `info/exclude` should hold: keryx's
 * `.metaproject` entries (none when the workspace is ignored as a whole) and
 * the local targets, minus every entry a rule outside keryx's own block
 * already ignores. `undefined` when git cannot evaluate ignore rules here.
 */
async function wantedIgnoreLines(
  projectRoot: string,
  localTargets: readonly string[],
  pending: PendingGitignoreBlock | undefined,
): Promise<{ lines: string[]; entries: string[]; reincluded: string[] } | undefined> {
  const wholeWorkspace = await isMetaprojectIgnoredAsWhole(projectRoot);
  const candidates = [
    ...(wholeWorkspace.git && wholeWorkspace.ignored ? [] : renderMetaprojectGitignoreBlock().trim().split("\n")),
    ...(localTargets.length > 0 ? [LOCAL_TARGETS_COMMENT, ...localTargets] : []),
  ];
  const patterns = candidates.filter((line) => !line.startsWith("#"));
  const explanations = await explainIgnoredPaths(projectRoot, patterns.map(probePathFor));
  if (explanations === undefined) return undefined;

  const covered = new Set<string>();
  const reincluded: string[] = [];
  for (const [index, pattern] of patterns.entries()) {
    const explanation = explanations[index];
    if (explanation === undefined) continue;
    const fromPendingBlock =
      pending !== undefined &&
      explanation.sourcePath === pending.sourcePath &&
      explanation.line !== undefined &&
      explanation.line > pending.firstLine &&
      explanation.line < pending.lastLine;
    if (explanation.ignored && !explanation.managed && !fromPendingBlock) covered.add(pattern);
    if (!explanation.ignored && explanation.rule !== undefined && localTargets.includes(pattern)) {
      reincluded.push(`${pattern} (${explanation.rule})`);
    }
  }
  return {
    lines: dropCoveredEntries(candidates, covered),
    entries: patterns.filter((pattern) => !covered.has(pattern)),
    reincluded,
  };
}

/** True when `content` (a `.gitignore`) carries keryx's managed `# keryx:begin … # keryx:end` block. */
export function hasManagedIgnoreBlock(content: string): boolean {
  return managedBlockPattern().test(content);
}

/**
 * Takes the managed block out of `.gitignore`, by the same cases as the
 * index block in a team file (`moveBlockOutOfTeamFile`):
 *
 * - The block is in `HEAD`: the team committed it. The file is left alone,
 *   and since git then already ignores those entries, none is repeated in
 *   `info/exclude`.
 * - Not in `HEAD`, the file otherwise equal to `HEAD`: restored to `HEAD`,
 *   so `git diff --quiet -- .gitignore` passes. "Otherwise equal" ignores
 *   blank lines — the old writer trimmed the file's tail before appending.
 * - Not in `HEAD`, other uncommitted edits: only the block goes.
 * - The file is not in `HEAD` at all: only the block goes — unless that
 *   leaves nothing but whitespace and the file is not staged either. Then
 *   every byte of it was keryx's, and it is removed: an empty untracked
 *   `.gitignore` is the only other way to end, and it would stay in
 *   `git status` for good.
 */
async function moveBlockOutOfGitignore(projectRoot: string, notice: (line: string) => void): Promise<void> {
  const gitignorePath = path.join(projectRoot, GITIGNORE);
  if (!(await pathExists(gitignorePath))) return;
  const content = await readFile(gitignorePath, "utf8");
  if (!managedBlockPattern().test(content)) return;

  const head = await readHeadBlob(projectRoot, GITIGNORE);
  if (head !== undefined && managedBlockPattern().test(head)) {
    notice(
      `${GITIGNORE}: the managed keryx ignore block is committed in HEAD, so it stays there and its entries are not repeated in info/exclude. ` +
        `To move it, delete the block from ${GITIGNORE} and commit that; the next \`keryx update\` writes the entries to info/exclude.`,
    );
    return;
  }

  const stripped = stripManagedBlock(content);
  if (head === undefined) {
    if (stripped.trim().length === 0 && !(await isInIndex(projectRoot, GITIGNORE))) {
      await removeContained(projectRoot, GITIGNORE);
      notice(
        `${GITIGNORE}: removed the file — it was untracked and held nothing but the managed keryx ignore block. keryx now keeps its ignore rules in info/exclude.`,
      );
      return;
    }
    await writeContained(projectRoot, GITIGNORE, stripped);
    notice(
      `${GITIGNORE}: removed the managed keryx ignore block (keryx now keeps its ignore rules in info/exclude). ` +
        "The file is untracked, so the rest of it is left in place.",
    );
    return;
  }
  if (sameApartFromBlankLines(stripped, head)) {
    if (!(await restoreWorktreeFileFromHead(projectRoot, GITIGNORE))) {
      await writeContained(projectRoot, GITIGNORE, head);
    }
    notice(
      (await worktreeFileIsClean(projectRoot, GITIGNORE))
        ? `${GITIGNORE}: moved the managed keryx ignore block to info/exclude; the file is back at HEAD.`
        : `${GITIGNORE}: restored from HEAD, but git still reports a difference — a staged copy may still carry the keryx block (\`git restore --staged ${GITIGNORE}\`).`,
    );
    return;
  }
  await writeContained(projectRoot, GITIGNORE, stripped);
  notice(
    `${GITIGNORE}: removed the managed keryx ignore block (keryx now keeps its ignore rules in info/exclude); ` +
      `your other uncommitted edits in ${GITIGNORE} are kept as they were.`,
  );
}

/** Whole marker lines, so a line that merely mentions a marker is not taken for one. A fresh regex per use: it is global. */
function managedBlockPattern(): RegExp {
  return new RegExp(`^${escapeRegExp(BLOCK_START)}[ \\t]*\\r?\\n[\\s\\S]*?^${escapeRegExp(BLOCK_END)}[ \\t]*$`, "gm");
}

/**
 * `content` without its managed block(s). Besides the marker-delimited text,
 * only what the old writer itself put around it goes: the block's own line
 * terminator and the one blank line it was separated by. Every other byte
 * stays.
 */
function stripManagedBlock(content: string): string {
  let result = content;
  for (let match = managedBlockPattern().exec(result); match !== null; match = managedBlockPattern().exec(result)) {
    const before = result.slice(0, match.index).replace(/(\r?\n)\r?\n$/, "$1");
    const after = result.slice(match.index + match[0].length).replace(/^\r?\n/, "");
    result = `${before}${after}`;
  }
  return result;
}

/**
 * `candidates` without the covered patterns, and without a comment run whose
 * patterns are all gone — a comment explains the entries under it and means
 * nothing on its own.
 */
function dropCoveredEntries(candidates: readonly string[], covered: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  let comments: string[] = [];
  let sawEntry = false;
  for (const line of candidates) {
    if (line.startsWith("#")) {
      if (sawEntry) comments = [];
      sawEntry = false;
      comments.push(line);
      continue;
    }
    sawEntry = true;
    if (covered.has(line)) continue;
    kept.push(...comments, line);
    comments = [];
  }
  return kept;
}

/** A path the ignore pattern matches, to ask `git check-ignore` about: wildcards become a fixed name. */
function probePathFor(pattern: string): string {
  return pattern.replace(/^\//, "").replace(/\*\*/g, PROBE_SEGMENT).replace(/\*/g, PROBE_SEGMENT);
}

function sameApartFromBlankLines(a: string, b: string): boolean {
  const significant = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const left = significant(a);
  const right = significant(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/** True when the index holds `relativePath` — staged, even if never committed. No git counts as not staged. */
async function isInIndex(projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", relativePath], { cwd: projectRoot, stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** `.git/info/exclude` for the main checkout; the absolute path from a linked worktree, where it lies outside the project. */
function displayPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target);
  return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative.split(path.sep).join("/");
}

export async function findLegacyMemoryArtifacts(projectRoot: string): Promise<LegacyMemoryArtifact[]> {
  const found: LegacyMemoryArtifact[] = [];
  for (const relativePath of LEGACY_MEMORY_ARTIFACT_PATHS) {
    if (!(await pathExists(path.join(projectRoot, relativePath)))) continue;
    let tracked = false;
    try {
      tracked = (await Bun.spawn(
        ["git", "ls-files", "--error-unmatch", "--", relativePath],
        { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
      ).exited) === 0;
    } catch {
      // A project without Git still receives a useful untracked-path advisory.
    }
    found.push({ path: relativePath, tracked });
  }
  return found;
}

export function formatLegacyMemoryMigrationAdvisory(artifacts: LegacyMemoryArtifact[]): string {
  const tracked = artifacts.filter((artifact) => artifact.tracked).map((artifact) => artifact.path);
  const untracked = artifacts.filter((artifact) => !artifact.tracked).map((artifact) => artifact.path);
  const details = [
    tracked.length > 0 ? `tracked legacy reports: ${tracked.join(", ")}` : "",
    untracked.length > 0 ? `existing legacy reports: ${untracked.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Memory migration advisory: ${details}. Keryx no longer writes these paths. Preserve canonical .metaproject/memory entries; a maintainer may optionally untrack legacy reports with git rm --cached, but init/update never delete files or mutate the Git index.`;
}

export function renderMetaprojectGitignoreBlock(): string {
  return `# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.
.metaproject/runtime/
.metaproject/core/**/*.ts
.metaproject/data/**/storage/
.metaproject/data/**/raw/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/data/gdctx/artifacts/
.metaproject/data/gdwiki/artifacts/
.metaproject/data/gdwiki/link-check/
.metaproject/data/health/history/
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/history/
.metaproject/data/testing/logs/
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
.metaproject/data/tasks/runtime/
.metaproject/data/tasks/logs/
# The bundle ledger and staged/inspected bundle artifacts are local runtime
# state (applied-state.json, temp audit copies), not something a project
# commits.
.metaproject/data/bundles/
# Skills stocktake reports and cache are dated, regenerated-on-demand runtime
# output, not project content. (Install-state under data/integrations/ stays
# tracked — see install-state.ts for why.)
.metaproject/data/skills/stocktake/
.metaproject/flows/.flow-init.lock/
.metaproject/flows/.flow-lock-*/
# Memory generated views, caches, reports, and atomic staging are disposable.
.metaproject/data/memory/index/
.metaproject/data/memory/embeddings/
.metaproject/data/memory/artifacts/
.metaproject/runtime/memory/
# Security: local-only HMAC key, self-protect state, and local hash report must never be committed.
.metaproject/data/security/raw/
.metaproject/data/security/raw/**
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
# Forgetting/retention runtime state: the auto-sweep stamp is rewritten by the
# gdctx write path on every call, not a project artifact. These lines were added
# to this repository's .gitignore by hand INSIDE the managed block, where the
# next \`keryx update\` regenerated them away — which is how they came to belong
# here instead.
.metaproject/data/forgetting/
.metaproject/data/retention/
.metaproject/reports/
# Self-learning loop: passive observation events and not-yet-reviewed
# candidate patterns are per-machine, never meant to be shared/committed.
# ".metaproject/data/" is not blanket-ignored, so these two get their own
# entries rather than inheriting coverage that does not exist.
.metaproject/data/learning/observations/
.metaproject/data/learning/candidates/
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
