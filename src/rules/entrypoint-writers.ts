// Flow 361: the writers behind the entrypoint-target model — the managed
// `keryx:index` block goes where `agentEntrypoints.root` says, and a block
// still sitting in a team file whose scope is local is taken back out.
//
// `resolveProjectEntrypoints` turns whatever the manifest holds into the
// entry form (legacy entries are settled against `HEAD`);
// `writeEntrypointBlocks` is the one writer `syncAgentRules` calls, so `init`,
// `update`, `rules sync` and `rules distill` cannot disagree about it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeContained } from "../lib/contained-write";
import { pathExists } from "../lib/fs";
import { readHeadBlob, restoreWorktreeFileFromHead, worktreeFileIsClean } from "../lib/git-head";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { ensureMetaprojectReference, renderManagedIndexBlock } from "./agent-entrypoints";
import { resolveLegacyEntrypointTargets, type ResolvedLegacyEntrypointTargets } from "./entrypoint-migration";
import {
  localRootEntry,
  normalizeEntrypointTargets,
  ruleImportSources,
  type ClaudeSettingsTarget,
  type CodexLocalRootEntry,
  type EntrypointTargets,
  type RootEntrypointEntry,
} from "./entrypoint-targets";
import { hasManagedIndexBlock, MANAGED_INDEX_BLOCK_START, stripManagedIndexBlock } from "./managed-index-block";
import { computeFencedRanges, indexOfMarkerLine } from "./marker-matching";

const MANIFEST_REL = ".metaproject/metaproject.json";
const TEAM_FILE_NAMES = ["agents.md", "claude.md"];
const LOCAL_FILE_NAMES = ["agents.override.md", "claude.local.md"];

/** Codex reads at most this many bytes of project instructions (`project_doc_max_bytes` default). */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** `agentEntrypoints` as keryx writes it. `index`, `readme` and `metaproject` are routing pointers, unchanged by flow 361. */
export type AgentEntrypointsManifest = {
  index?: string;
  readme?: string;
  metaproject?: string;
  root: RootEntrypointEntry[];
  claudeSettings: ClaudeSettingsTarget;
  /**
   * Extra project-root files imported as tracked rules besides the team
   * files. A legacy `root` string array could name such a file; the entry
   * form has no runtime to hang it on, so it is kept here instead of dropped.
   */
  importSources?: string[];
};

export type ProjectEntrypoints = {
  /** Entry form throughout — safe to write from and to persist. */
  targets: EntrypointTargets;
  importSources: string[];
  /**
   * How each legacy entry was settled; empty for an entry-form manifest. The
   * `claudeSettings` target is settled again by `init`/`update` from the
   * settings files themselves (`decideClaudeSettingsTarget`), which also
   * covers a manifest that is already in entry form.
   */
  decisions: ResolvedLegacyEntrypointTargets["decisions"];
  /** Lines for the command output: a legacy entry that stays shared, and how to switch it. */
  notices: string[];
};

/**
 * The manifest's `agentEntrypoints`, whatever shape it is in, as settled
 * targets. A legacy string array, a missing field and a missing manifest all
 * go through the `HEAD` decision, so a block the team committed stays where
 * it is and everything else becomes local; a manifest already in entry form
 * is taken at its word. Reads git, writes nothing.
 */
export async function resolveProjectEntrypoints(projectRoot: string, agentEntrypoints: unknown): Promise<ProjectEntrypoints> {
  const normalized = normalizeEntrypointTargets(agentEntrypoints);
  const resolved = await resolveLegacyEntrypointTargets(projectRoot, normalized);
  const targets: EntrypointTargets = {
    root: resolved.targets.root.map(keepLocalEntryOffTeamFile),
    claudeSettings: resolved.targets.claudeSettings,
  };
  const notices: string[] = [];
  for (const decision of resolved.decisions) {
    if (decision.legacy.kind !== "root" || decision.scope !== "shared") continue;
    notices.push(
      `${decision.legacy.path}: the managed keryx block is committed in HEAD, so it stays there (scope "shared"). ` +
        `To move it to a local file, set the ${decision.legacy.runtime} entry's scope to "local" under agentEntrypoints.root in ${MANIFEST_REL}, ` +
        "run `keryx update`, and commit the removal.",
    );
  }
  return {
    targets,
    importSources: customImportSources(agentEntrypoints, normalized.ignored),
    decisions: resolved.decisions,
    notices,
  };
}

/**
 * Every root file a manifest asks to import as rules, without touching git:
 * the read-only twin `--preview` uses, where the scope decision is not needed
 * because a team file is an import source under either scope.
 */
export function declaredImportSources(agentEntrypoints: unknown): string[] {
  const normalized = normalizeEntrypointTargets(agentEntrypoints);
  return [...new Set([...ruleImportSources(normalized.targets), ...customImportSources(agentEntrypoints, normalized.ignored)])];
}

/**
 * The value to store under `agentEntrypoints`. Keys the manifest already has
 * keep their position, so a second run serialises the same bytes; `fixed`
 * carries the pointer fields a command owns (`index`, `readme`, `metaproject`).
 */
export function manifestAgentEntrypoints(
  existing: unknown,
  entrypoints: Pick<ProjectEntrypoints, "targets" | "importSources">,
  fixed: Pick<AgentEntrypointsManifest, "index" | "readme" | "metaproject"> = {},
): AgentEntrypointsManifest {
  const { importSources: _previous, ...kept } = isRecord(existing) ? existing : {};
  return {
    ...fixed,
    ...kept,
    ...fixed,
    root: entrypoints.targets.root,
    claudeSettings: entrypoints.targets.claudeSettings,
    ...(entrypoints.importSources.length > 0 ? { importSources: entrypoints.importSources } : {}),
  };
}

export type WriteEntrypointBlocksOptions = {
  enableTasks?: boolean;
  /** The team files found on disk (import sources), as `findAgentEntrypoints` reports them. */
  sources: readonly string[];
  onNotice?: (line: string) => void;
};

/**
 * Puts the block where `targets` says and nowhere else. Order matters: the
 * Claude target is written before any team file loses its block, so the block
 * is never absent everywhere, and the Codex override is generated last, from
 * the team file as it stands after that cleanup — its recorded source hash
 * would otherwise be stale the moment the team file is restored.
 */
export async function writeEntrypointBlocks(
  projectRoot: string,
  targets: EntrypointTargets,
  options: WriteEntrypointBlocksOptions,
): Promise<void> {
  const notice = options.onNotice ?? (() => {});
  const blockOptions = { ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }), root: projectRoot };

  const sharedPaths = new Set<string>();
  for (const entry of targets.root) {
    if (entry.scope === "shared") {
      sharedPaths.add(entry.path.toLowerCase());
      const filePath = path.join(projectRoot, entry.path);
      if (await pathExists(filePath)) await ensureMetaprojectReference(filePath, blockOptions);
    } else if (entry.runtime === "claude") {
      await writeClaudeLocalTarget(projectRoot, entry.path, options.sources, blockOptions);
    }
  }

  const inGit = (await resolveGitCommonDir(projectRoot)) !== undefined;
  const codexSources = new Set(targets.root.flatMap((entry) => (entry.runtime === "codex" && entry.scope === "local" ? [entry.source] : [])));
  for (const source of options.sources) {
    if (sharedPaths.has(source.toLowerCase())) continue;
    const teamFile = TEAM_FILE_NAMES.includes(source.toLowerCase()) || codexSources.has(source);
    await moveBlockOutOfTeamFile(projectRoot, source, { inGit, teamFile, notice });
  }

  await writeCodexLocalTargets(projectRoot, targets, options);
}

/**
 * Generates `AGENTS.override.md` for a Codex `override` entry, or says why
 * Codex was skipped. Exported for `rules distill`, which rewrites the team
 * file after the first pass and must not leave a stale override behind.
 */
export async function writeCodexLocalTargets(
  projectRoot: string,
  targets: EntrypointTargets,
  options: { enableTasks?: boolean; onNotice?: (line: string) => void },
): Promise<void> {
  const notice = options.onNotice ?? (() => {});
  for (const entry of targets.root) {
    if (entry.runtime !== "codex" || entry.scope !== "local") continue;
    if (entry.mode === "skip") {
      notice(`Codex: skipped — the codex entry in ${MANIFEST_REL} has mode "skip", so no Codex file is written.`);
      continue;
    }
    const sourcePath = path.join(projectRoot, entry.source);
    if (!(await pathExists(sourcePath))) {
      notice(
        `Codex: skipped — ${entry.source} does not exist, and ${entry.path} is only ever generated from it. ` +
          `Create ${entry.source}, or set the codex entry's scope to "shared" in ${MANIFEST_REL}.`,
      );
      continue;
    }
    const overridePath = path.join(projectRoot, entry.path);
    const existing = (await pathExists(overridePath)) ? await readFile(overridePath, "utf8") : undefined;
    if (existing !== undefined && parseCodexOverrideProvenance(existing) === undefined) {
      notice(`Codex: skipped — ${entry.path} exists and was not generated by keryx; it is left untouched. Remove it, or set the codex entry's mode to "skip".`);
      continue;
    }
    const next = renderCodexOverride({
      source: entry.source,
      sourceContent: await readFile(sourcePath, "utf8"),
      block: await renderManagedIndexBlock({ ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }), root: projectRoot }),
      sourcePath,
    });
    if (next !== existing) await writeContained(projectRoot, entry.path, next);
  }
}

const OVERRIDE_PROVENANCE = /^<!-- keryx:override source="([^"\n]+)" sha256=([0-9a-f]{64}) /;

/**
 * `AGENTS.override.md`: a provenance line (source file and the sha256 of the
 * source content it was built from), the keryx block, then the source — with
 * any managed block the source itself still carries left out of the copy.
 * Codex reads the override INSTEAD of the source, so the copy is the point.
 */
export function renderCodexOverride(input: { source: string; sourceContent: string; block: string; sourcePath?: string }): string {
  const body = stripManagedIndexBlock(input.sourceContent, input.sourcePath ?? input.source);
  const provenance = `<!-- keryx:override source="${input.source}" sha256=${sha256(input.sourceContent)} — generated by keryx; edit ${input.source}, then run \`keryx update\` -->`;
  return `${provenance}\n${input.block.trimEnd()}\n\n${body}`;
}

export function parseCodexOverrideProvenance(content: string): { source: string; sha256: string } | undefined {
  const match = OVERRIDE_PROVENANCE.exec(content);
  return match?.[1] !== undefined && match[2] !== undefined ? { source: match[1], sha256: match[2] } : undefined;
}

export type CodexOverrideState =
  /** The override was built from the source as it is now. */
  | "fresh"
  /** The source changed since the override was generated: Codex is reading older team text. */
  | "stale"
  /** No override file (not generated yet in this worktree). */
  | "missing"
  /** The override exists but its source is gone. */
  | "source-missing"
  /** The file has no keryx provenance line: not generated by keryx. */
  | "unmanaged";

export async function codexOverrideState(projectRoot: string, entry: Pick<CodexLocalRootEntry, "path" | "source">): Promise<CodexOverrideState> {
  const overridePath = path.join(projectRoot, entry.path);
  if (!(await pathExists(overridePath))) return "missing";
  const provenance = parseCodexOverrideProvenance(await readFile(overridePath, "utf8"));
  if (provenance === undefined) return "unmanaged";
  const sourcePath = path.join(projectRoot, entry.source);
  if (!(await pathExists(sourcePath))) return "source-missing";
  return provenance.sha256 === sha256(await readFile(sourcePath, "utf8")) ? "fresh" : "stale";
}

/** True when a keryx-generated override no longer matches its source — what `keryx update` would regenerate. */
export async function isCodexOverrideStale(projectRoot: string, entry: Pick<CodexLocalRootEntry, "path" | "source">): Promise<boolean> {
  const state = await codexOverrideState(projectRoot, entry);
  return state === "stale" || state === "source-missing";
}

/** The override's size in bytes — block plus team content, the number Codex's cap applies to. `undefined` when there is no file. */
export async function codexOverrideByteSize(projectRoot: string, entry: Pick<CodexLocalRootEntry, "path">): Promise<number | undefined> {
  const overridePath = path.join(projectRoot, entry.path);
  if (!(await pathExists(overridePath))) return undefined;
  return (await readFile(overridePath)).byteLength;
}

/**
 * `CLAUDE.local.md`, created when missing. Claude Code counts a
 * `CLAUDE.local.md` as a `CLAUDE.md` when deciding whether to fall back to
 * `AGENTS.md`, so in a repository that has `AGENTS.md` and no `CLAUDE.md` the
 * file keryx creates would silently stop Claude reading the team's
 * instructions; the generated file imports them instead
 * (code.claude.com/docs/en/memory, "When Claude Code reads AGENTS.md"). A
 * file the developer already had is only given the block: its effect on the
 * fallback predates keryx.
 */
async function writeClaudeLocalTarget(
  projectRoot: string,
  relativePath: string,
  sources: readonly string[],
  blockOptions: { enableTasks?: boolean; root: string },
): Promise<void> {
  const filePath = path.join(projectRoot, relativePath);
  if (!(await pathExists(filePath))) {
    const agentsFile = sources.find((source) => source.toLowerCase() === "agents.md");
    const hasClaudeFile =
      sources.some((source) => source.toLowerCase() === "claude.md") ||
      (await pathExists(path.join(projectRoot, ".claude", "CLAUDE.md")));
    const agentsImport =
      agentsFile !== undefined && !hasClaudeFile
        ? `\n<!-- keryx: this file stops Claude Code from falling back to ${agentsFile}; the import keeps the team instructions loaded. -->\n@${agentsFile}\n`
        : "";
    await writeContained(projectRoot, relativePath, `# Local Claude Instructions\n${agentsImport}`);
  }
  await ensureMetaprojectReference(filePath, blockOptions);
}

/**
 * Takes the managed block out of a team file whose scope is local.
 *
 * - The file equals `HEAD` apart from the block: restored to `HEAD`, so
 *   `git diff --quiet` passes. "Apart from the block" ignores blank lines,
 *   because inserting the block padded it and refreshing it collapsed runs
 *   of them — a plain strip never byte-matches `HEAD`.
 * - The file has other uncommitted edits: only the block goes; reported.
 * - The block is in `HEAD` (the manifest was switched to local by hand): the
 *   block goes and the removal is left for the team to commit. A custom
 *   import source is left alone in that case — nothing claimed it as a target.
 * - Untracked, or no git repository: only the block goes; the file stays,
 *   since keryx cannot prove it created it.
 */
async function moveBlockOutOfTeamFile(
  projectRoot: string,
  relativePath: string,
  context: { inGit: boolean; teamFile: boolean; notice: (line: string) => void },
): Promise<void> {
  const filePath = path.join(projectRoot, relativePath);
  const content = await readFile(filePath, "utf8");
  if (!hasManagedIndexBlock(content)) return;

  const head = context.inGit ? await readHeadBlob(projectRoot, relativePath) : undefined;
  if (head === undefined) {
    await writeContained(projectRoot, relativePath, removeBlock(content, filePath, undefined));
    context.notice(
      context.inGit
        ? `${relativePath}: removed the managed keryx block. The file is untracked, so it is left in place — delete it if keryx created it and nothing else is in it.`
        : `${relativePath}: removed the managed keryx block. Not a git repository, so there is no HEAD to restore the file to — only the block was stripped.`,
    );
    return;
  }
  if (hasManagedIndexBlock(head)) {
    if (!context.teamFile) return;
    await writeContained(projectRoot, relativePath, removeBlock(content, filePath, head));
    context.notice(`${relativePath}: removed the managed keryx block, which is committed in HEAD — commit this removal to finish the switch to local scope.`);
    return;
  }
  if (sameApartFromBlankLines(stripManagedIndexBlock(content, filePath), head)) {
    if (!(await restoreWorktreeFileFromHead(projectRoot, relativePath))) {
      await writeContained(projectRoot, relativePath, head);
    }
    context.notice(
      (await worktreeFileIsClean(projectRoot, relativePath))
        ? `${relativePath}: moved the managed keryx block to the local target; the file is back at HEAD.`
        : `${relativePath}: restored from HEAD, but git still reports a difference — a staged copy may still carry the keryx block (\`git restore --staged ${relativePath}\`).`,
    );
    return;
  }
  await writeContained(projectRoot, relativePath, removeBlock(content, filePath, head));
  context.notice(`${relativePath}: removed the managed keryx block; your other uncommitted edits in ${relativePath} are kept as they were.`);
}

/**
 * `content` without its managed block, and without the blank-line padding
 * keryx put around the block when it inserted it. Only the blank lines
 * directly around the first block are touched: when `head` shows the two
 * neighbouring lines adjacent, their spacing there is reused; otherwise one
 * blank line separates them. Every other byte is `stripManagedIndexBlock`'s.
 */
function removeBlock(content: string, filePath: string, head: string | undefined): string {
  const stripped = stripManagedIndexBlock(content, filePath);
  const start = indexOfMarkerLine(content, MANAGED_INDEX_BLOCK_START, computeFencedRanges(content));
  if (start < 0) return stripped;
  const before = content.slice(0, start).replace(/\n+$/, "");
  const after = stripped.slice(start).replace(/^\n+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return `${before}\n`;
  const blankLines = head === undefined ? undefined : blankLinesBetween(head, lastLine(before), firstLine(after));
  return `${before}${"\n".repeat((blankLines ?? 1) + 1)}${after}`;
}

function lastLine(text: string): string {
  return text.slice(text.lastIndexOf("\n") + 1);
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline < 0 ? text : text.slice(0, newline);
}

/** How many blank lines separate `first` from `second` where they follow each other in `text`; `undefined` when they do not. */
function blankLinesBetween(text: string, first: string, second: string): number | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== first) continue;
    let next = index + 1;
    while (next < lines.length && lines[next]?.trim() === "") next += 1;
    if (lines[next] === second) return next - index - 1;
  }
  return undefined;
}

function sameApartFromBlankLines(a: string, b: string): boolean {
  const significant = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const left = significant(a);
  const right = significant(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * A local entry must never point at the team file: a hand-edited
 * `{ path: "AGENTS.md", scope: "local" }` would make the override overwrite
 * its own source (and put the "local" Claude block straight back into
 * `CLAUDE.md`). Such an entry means "switch this runtime to local" and gets
 * the local path.
 */
function keepLocalEntryOffTeamFile(entry: RootEntrypointEntry): RootEntrypointEntry {
  if (entry.scope !== "local") return entry;
  const lower = entry.path.toLowerCase();
  if (entry.runtime === "claude") return TEAM_FILE_NAMES.includes(lower) ? localRootEntry("claude") : entry;
  if (!TEAM_FILE_NAMES.includes(lower) && lower !== entry.source.toLowerCase()) return entry;
  return { ...(localRootEntry("codex", entry.source) as CodexLocalRootEntry), mode: entry.mode };
}

/** The manifest's own `importSources` plus legacy `root` strings that named some other root file. */
function customImportSources(agentEntrypoints: unknown, ignored: readonly unknown[]): string[] {
  const declared = isRecord(agentEntrypoints) && Array.isArray(agentEntrypoints.importSources) ? (agentEntrypoints.importSources as unknown[]) : [];
  const sources: string[] = [];
  for (const item of [...declared, ...ignored]) {
    if (typeof item !== "string" || !isSafeRelativePath(item)) continue;
    const lower = item.toLowerCase();
    if (TEAM_FILE_NAMES.includes(lower) || LOCAL_FILE_NAMES.includes(lower)) continue;
    if (!sources.includes(item)) sources.push(item);
  }
  return sources;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
