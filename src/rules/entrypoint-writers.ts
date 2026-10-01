// Flow 361: the writers behind the entrypoint-target model — the managed
// `keryx:index` block goes where `agentEntrypoints.root` says, a block still
// sitting in a team file whose scope is local is taken back out, and what
// keryx wrote into a local target a runtime no longer uses is removed.
//
// `resolveProjectEntrypoints` turns whatever the manifest holds into the
// entry form (legacy entries are settled against `HEAD`);
// `writeEntrypointBlocks` is the one writer `syncAgentRules` calls, so `init`,
// `update`, `rules sync` and `rules distill` cannot disagree about it.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { removeContained, writeContained } from "../lib/contained-write";
import { pathExists } from "../lib/fs";
import { indexHoldsFile, readHeadBlob, readIndexBlob, restoreWorktreeFileFromHead, worktreeFileIsClean } from "../lib/git-head";
import { explainIgnoredPaths } from "../lib/git-local-ignore";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { refuseEscapingSymlink } from "../lib/symlink-safety";
import { ensureMetaprojectReference, renderManagedIndexBlock } from "./agent-entrypoints";
import { overrideRulesSlot, overrideSourceHash, parseCodexOverrideProvenance, renderCodexOverride } from "./codex-override";
import { resolveLegacyEntrypointTargets, type ResolvedLegacyEntrypointTargets } from "./entrypoint-migration";
import {
  localRootEntry,
  normalizeEntrypointTargets,
  rulesExportTeamFile,
  ruleImportSources,
  unusedLocalTarget,
  type ClaudeSettingsTarget,
  type CodexLocalRootEntry,
  type EntrypointRuntime,
  type EntrypointTargets,
  type RootEntrypointEntry,
} from "./entrypoint-targets";
import {
  hasManagedIndexBlock,
  hasManagedRulesBlock,
  MANAGED_INDEX_BLOCK_START,
  stripManagedIndexBlock,
  stripManagedRulesBlock,
  UnterminatedMetaprojectReferenceError,
} from "./managed-index-block";
import { RULES_BLOCK_START_MARKER } from "./export-render";
import { computeFencedRanges, indexOfMarkerLine } from "./marker-matching";

// Flow 363: moved to light modules the rules-export surface can import
// (AFC-19); re-exported so every existing caller keeps its import.
export { parseCodexOverrideProvenance, renderCodexOverride } from "./codex-override";
export { ignoredLocalTargetPaths } from "./entrypoint-targets";

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
 * would otherwise be stale the moment the team file is restored. A runtime
 * switched back to shared (or Codex to `skip`) loses what keryx left in its
 * local target (`planLocalLeftovers`), each after its shared file has the block.
 */
export async function writeEntrypointBlocks(
  projectRoot: string,
  targets: EntrypointTargets,
  options: WriteEntrypointBlocksOptions,
): Promise<void> {
  const notice = options.onNotice ?? (() => {});
  const blockOptions = { ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }), root: projectRoot };

  const inGit = (await resolveGitCommonDir(projectRoot)) !== undefined;
  const sharedPaths = new Set<string>();
  for (const entry of targets.root) {
    if (entry.scope === "shared") {
      sharedPaths.add(entry.path.toLowerCase());
      const filePath = path.join(projectRoot, entry.path);
      if (await pathExists(filePath)) await ensureMetaprojectReference(filePath, blockOptions);
    } else if (entry.runtime === "claude") {
      // A tracked local file is the team's: the block would be a change to
      // commit after every update (review round 1, F-011).
      if (inGit && (await trackedInGit(projectRoot, entry.path))) {
        notice(
          `${entry.path}: tracked in git, so keryx does not write its block there — it would show as a change after every update. ` +
            `Untrack it (\`git rm --cached ${entry.path}\`) to keep it per-developer, or set the claude entry's scope to "shared" in ${MANIFEST_REL}.`,
        );
      } else if (await writeClaudeLocalTarget(projectRoot, entry.path, options.sources, blockOptions)) {
        notice(`${entry.path}: created with the keryx block (${await localFileNote(projectRoot, entry.path)}).`);
      }
    }
  }
  // After the shared target has its block, so Claude is never left without one.
  await removeLocalLeftovers(projectRoot, await planLocalLeftovers(projectRoot, targets, "claude"), notice);

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
  await removeLocalLeftovers(projectRoot, await planLocalLeftovers(projectRoot, targets, "codex"), notice);
  for (const entry of targets.root) {
    if (entry.runtime !== "codex" || entry.scope !== "local") continue;
    if (entry.mode === "skip") {
      notice(`Codex: skipped — the codex entry in ${MANIFEST_REL} has mode "skip", so no Codex file is written.`);
      continue;
    }
    // `readFile` follows symlinks: a source under a committed `home -> $HOME`
    // link would be copied into the file Codex sends to its model provider
    // (review round 1, F-002). Checked before every read of the source.
    const refusal = (await refuseEscapingSymlink(projectRoot, entry.source)) ?? (await refuseEscapingSymlink(projectRoot, entry.path));
    if (refusal !== undefined) {
      notice(
        `Codex: skipped — ${refusal} (a symlink keryx does not follow), so ${entry.source} is not read and ${entry.path} is not generated. ` +
          `Point the codex entry's source at a file inside the project in ${MANIFEST_REL}.`,
      );
      continue;
    }
    const sourcePath = path.join(projectRoot, entry.source);
    if (!(await pathExists(sourcePath))) {
      if (await removeOrphanedOverride(projectRoot, entry)) {
        notice(
          `${entry.path}: removed the keryx-generated override — ${entry.source} no longer exists, and Codex would keep reading the override in its place. ` +
            `Create ${entry.source} and run \`keryx update\` to generate it again.`,
        );
        continue;
      }
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
    let next: string;
    try {
      next = renderCodexOverride({
        source: entry.source,
        sourceContent: await readFile(sourcePath, "utf8"),
        block: await renderManagedIndexBlock({ ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }), root: projectRoot }),
        sourcePath,
        ...(existing === undefined ? {} : { previous: existing }),
      });
    } catch (error) {
      // Only the carried `keryx:rules` block can be unterminated here — the
      // source was checked before any write. Regenerating without it would
      // drop the block, so the override is left as it is.
      if (!(error instanceof UnterminatedMetaprojectReferenceError) || !hasManagedRulesBlock(existing ?? "")) throw error;
      notice(`${entry.path}: not regenerated — its ${RULES_BLOCK_START_MARKER} block has no end marker; fix it by hand, then run \`keryx update\`.`);
      continue;
    }
    if (next === existing) continue;
    await writeContained(projectRoot, entry.path, next);
    // Said once, when the file first appears; regenerating it is routine.
    if (existing === undefined) {
      notice(
        `${entry.path}: generated from ${entry.source} with the keryx block (${await localFileNote(projectRoot, entry.path)}); Codex reads it instead of ${entry.source}.`,
      );
    }
  }
}

/**
 * Removes the override `entry` names when its source is gone and keryx made
 * it: it carries keryx's provenance line, is not tracked, and is not reached
 * through an escaping symlink. Codex reads `AGENTS.override.md` instead of
 * `AGENTS.md`, so a leftover would keep serving stale team text (review round
 * 1, F-010). True when the file was removed.
 */
async function removeOrphanedOverride(projectRoot: string, entry: CodexLocalRootEntry): Promise<boolean> {
  const overridePath = path.join(projectRoot, entry.path);
  if (!(await pathExists(overridePath))) return false;
  if ((await refuseEscapingSymlink(projectRoot, entry.path)) !== undefined) return false;
  if (parseCodexOverrideProvenance(await readFile(overridePath, "utf8")) === undefined) return false;
  if (await trackedInGit(projectRoot, entry.path)) return false;
  await removeContained(projectRoot, entry.path);
  return true;
}

/** True when git tracks `relativePath` — committed in `HEAD`, or staged. No git counts as not tracked. */
async function trackedInGit(projectRoot: string, relativePath: string): Promise<boolean> {
  if ((await resolveGitCommonDir(projectRoot)) === undefined) return false;
  return (await indexHoldsFile(projectRoot, relativePath)) || (await readHeadBlob(projectRoot, relativePath)) !== undefined;
}

/**
 * How a creation notice describes a local target. Asked of git rather than
 * assumed: `init`/`update` write the ignore rules first, but `rules sync` does
 * not write them at all.
 */
async function localFileNote(projectRoot: string, relativePath: string): Promise<string> {
  const [explanation] = (await explainIgnoredPaths(projectRoot, [relativePath])) ?? [];
  if (explanation === undefined) return "a per-developer file";
  return explanation.ignored
    ? "gitignored, per checkout"
    : "per checkout, but git does not ignore it yet — `keryx update` adds it to info/exclude";
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
  /** The source is reached through a symlink leaving the project: keryx does not read it (review round 1, F-002). */
  | "source-refused"
  /** The file has no keryx provenance line: not generated by keryx. */
  | "unmanaged";

export async function codexOverrideState(projectRoot: string, entry: Pick<CodexLocalRootEntry, "path" | "source">): Promise<CodexOverrideState> {
  const overridePath = path.join(projectRoot, entry.path);
  if (!(await pathExists(overridePath))) return "missing";
  const provenance = parseCodexOverrideProvenance(await readFile(overridePath, "utf8"));
  if (provenance === undefined) return "unmanaged";
  if ((await refuseEscapingSymlink(projectRoot, entry.source)) !== undefined) return "source-refused";
  const sourcePath = path.join(projectRoot, entry.source);
  if (!(await pathExists(sourcePath))) return "source-missing";
  return provenance.sha256 === overrideSourceHash(await readFile(sourcePath, "utf8")) ? "fresh" : "stale";
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
 * fallback predates keryx. Returns true when this call created the file.
 */
async function writeClaudeLocalTarget(
  projectRoot: string,
  relativePath: string,
  sources: readonly string[],
  blockOptions: { enableTasks?: boolean; root: string },
): Promise<boolean> {
  const filePath = path.join(projectRoot, relativePath);
  const created = !(await pathExists(filePath));
  if (created) {
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
  return created;
}

const LOCAL_CLAUDE_HEADING = "# Local Claude Instructions";
/** The comment `writeClaudeLocalTarget` puts above the `@AGENTS.md` import it adds; it is what proves keryx added the import. */
const KERYX_AGENTS_IMPORT_COMMENT = /^<!-- keryx: this file stops Claude Code from falling back to (.+); the import keeps the team instructions loaded\. -->$/;

/**
 * What keryx left in a runtime's local target once that runtime no longer
 * uses it — its scope went back to shared, or Codex's mode to `skip`. The one
 * plan behind the writer, `--preview` and `keryx doctor`.
 */
export type LocalLeftover = {
  runtime: EntrypointRuntime;
  path: string;
  /** Why the file is no longer keryx's target, for the output: `the claude entry's scope is "shared"`. */
  because: string;
  /** The file the runtime reads instead. */
  instead: string;
} & (
  /** Nothing but keryx's content (`CLAUDE.local.md`), or a keryx-generated override: the file goes. */
  | { action: "remove" }
  /** `CLAUDE.local.md` also holds the developer's own lines: only keryx's part goes, `next` is what stays. */
  | { action: "strip"; next: string }
  /** Left in place: an override keryx did not generate, a tracked file, a symlink out of the project, a broken block. */
  | { action: "keep"; reason: string }
);

/**
 * For every runtime that no longer writes a local target, what keryx left
 * there and what a run does about it. Read-only: asks git whether the file is
 * tracked, writes nothing.
 *
 * - `CLAUDE.local.md`: keryx's part is the managed block, the rules-export
 *   `keryx:rules` block (flow 363), and the `@AGENTS.md`
 *   import when the keryx comment above it shows keryx added it. With nothing
 *   left but blank lines and the heading keryx gave the file, the file is
 *   removed; otherwise only keryx's part goes and every other byte stays.
 * - `AGENTS.override.md`: removed only when it carries keryx's provenance
 *   line. One without it is the developer's and is left alone.
 * - A tracked file is never deleted: that would be a change for the team to
 *   commit. A tracked `CLAUDE.local.md` still loses keryx's part.
 */
export async function planLocalLeftovers(
  projectRoot: string,
  targets: EntrypointTargets,
  only?: EntrypointRuntime,
): Promise<LocalLeftover[]> {
  const tracked = (relativePath: string) => trackedInGit(projectRoot, relativePath);
  const leftovers: LocalLeftover[] = [];
  for (const entry of targets.root) {
    if (only !== undefined && entry.runtime !== only) continue;
    const unused = unusedLocalTarget(entry);
    if (unused === undefined || TEAM_FILE_NAMES.includes(unused.path.toLowerCase())) continue;
    const filePath = path.join(projectRoot, unused.path);
    if (!(await pathExists(filePath))) continue;
    const content = await readFile(filePath, "utf8");
    const refusal = await refuseEscapingSymlink(projectRoot, unused.path);

    if (unused.runtime === "codex") {
      if (parseCodexOverrideProvenance(content) === undefined) {
        leftovers.push({ ...unused, action: "keep", reason: `it was not generated by keryx, so it is left untouched — Codex reads it instead of ${unused.instead}` });
      } else if (refusal !== undefined) {
        leftovers.push({ ...unused, action: "keep", reason: refusal });
      } else if (await tracked(unused.path)) {
        leftovers.push({ ...unused, action: "keep", reason: "keryx generated it, but it is tracked in git, so removing it is the team's change to make (git rm)" });
      } else {
        leftovers.push({ ...unused, action: "remove" });
      }
      continue;
    }

    let next: string;
    try {
      // The rules-export block is keryx's too: `init`/`update` install it
      // again at the shared target (`rulesBlocksLeavingLocalTargets`).
      next = removeKeryxAgentsImport(removeBlock(removeBlock(content, filePath, undefined), filePath, undefined, RULES_BLOCK));
    } catch (error) {
      leftovers.push({ ...unused, action: "keep", reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (next === content) continue;
    if (refusal !== undefined) {
      leftovers.push({ ...unused, action: "keep", reason: refusal });
    } else if (holdsOnlyLocalHeading(next) && !(await tracked(unused.path))) {
      leftovers.push({ ...unused, action: "remove" });
    } else {
      leftovers.push({ ...unused, action: "strip", next });
    }
  }
  return leftovers;
}

async function removeLocalLeftovers(projectRoot: string, leftovers: readonly LocalLeftover[], notice: (line: string) => void): Promise<void> {
  for (const leftover of leftovers) {
    if (leftover.action === "remove") {
      await removeContained(projectRoot, leftover.path);
      notice(
        leftover.runtime === "claude"
          ? `${leftover.path}: removed the file — it held nothing but keryx's content, and ${leftover.because}, so the managed block is in ${leftover.instead}.`
          : `${leftover.path}: removed the keryx-generated override — ${leftover.because}, so Codex reads ${leftover.instead} again.`,
      );
    } else if (leftover.action === "strip") {
      await writeContained(projectRoot, leftover.path, leftover.next);
      notice(
        `${leftover.path}: removed the managed keryx block (${leftover.because}, so it is in ${leftover.instead}); the rest of the file is yours and is kept as it was.`,
      );
    } else {
      notice(`${leftover.path}: left in place — ${leftover.reason}.`);
    }
  }
}

/**
 * `content` without the `@AGENTS.md` import keryx added under its own
 * comment, and the blank line before that comment. Lines are compared
 * without a trailing `\r` and the rest is rejoined as it was, so a CRLF file
 * stays CRLF.
 */
function removeKeryxAgentsImport(content: string): string {
  const lines = content.split("\n");
  const bare = (index: number) => lines[index]?.replace(/\r$/, "");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const match = KERYX_AGENTS_IMPORT_COMMENT.exec(bare(index) ?? "");
    if (match === null || bare(index + 1) !== `@${match[1]}`) continue;
    const from = index > 0 && bare(index - 1) === "" ? index - 1 : index;
    lines.splice(from, index + 2 - from);
    return lines.join("\n");
  }
  return content;
}

function holdsOnlyLocalHeading(content: string): boolean {
  return content.split(/\r?\n/).every((line) => line.trim() === "" || line.trim() === LOCAL_CLAUDE_HEADING);
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
 *
 * A strip changes the working tree only. Where the index still holds a copy
 * with the block, the notice says so — a plain `git commit` would record it
 * (review round 1, F-009).
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
    const staged = context.inGit ? await readIndexBlob(projectRoot, relativePath) : undefined;
    if (!context.inGit) {
      context.notice(`${relativePath}: removed the managed keryx block. Not a git repository, so there is no HEAD to restore the file to — only the block was stripped.`);
    } else if (staged === undefined) {
      context.notice(`${relativePath}: removed the managed keryx block. The file is untracked, so it is left in place — delete it if keryx created it and nothing else is in it.`);
    } else {
      context.notice(
        `${relativePath}: removed the managed keryx block. The file is staged but not committed yet` +
          (hasManagedIndexBlock(staged)
            ? `, and the staged copy still carries the block — \`git add ${relativePath}\` stages this version (or \`git restore --staged ${relativePath}\` unstages the file).`
            : "."),
      );
    }
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
  const staged = await readIndexBlob(projectRoot, relativePath);
  context.notice(
    `${relativePath}: removed the managed keryx block; your other uncommitted edits in ${relativePath} are kept as they were.` +
      (staged !== undefined && hasManagedIndexBlock(staged)
        ? ` A staged copy still carries the block — \`git restore --staged ${relativePath}\` drops it from the index (or \`git add ${relativePath}\` stages this version).`
        : ""),
  );
}

/** One kind of keryx-managed markdown block: its start marker line and how to strip every such block. */
type ManagedBlockKind = { startMarker: string; strip: (content: string, filePath: string) => string };

const INDEX_BLOCK: ManagedBlockKind = { startMarker: MANAGED_INDEX_BLOCK_START, strip: stripManagedIndexBlock };
const RULES_BLOCK: ManagedBlockKind = { startMarker: RULES_BLOCK_START_MARKER, strip: stripManagedRulesBlock };

/**
 * Flow 363: takes the rules-export surface's `keryx:rules` block out of a
 * tracked team file whose runtime's scope is local, so the surface can write
 * it into the local target instead. Returns the runtimes whose block was
 * taken out: the caller installs the surface for them again once the local
 * targets exist (`src/rules/rules-export-migration.ts`), re-rendering the
 * block from the current rules library.
 *
 * Runs before the index block is written, and follows
 * `moveBlockOutOfTeamFile`'s cases, with one difference:
 *
 * - The file equals `HEAD` apart from keryx's blocks and blank lines:
 *   restored to `HEAD`, so `git diff --quiet` passes. The index block counts
 *   as keryx's here too — it moves out of the same file in the same run.
 * - Other uncommitted edits: only the rules block goes; reported by name.
 * - The block is committed in `HEAD`: the team's shared choice. Nothing is
 *   touched and nothing is written locally — the surface keeps writing the
 *   team file (`resolveRulesExportTarget`), so the block is never in both.
 * - The file is not tracked, there is no repository, or the runtime has no
 *   local target (Codex `skip`, an override keryx did not generate): left
 *   alone, and the surface keeps writing where the block is.
 */
export async function moveRulesBlocksOutOfTeamFiles(
  projectRoot: string,
  targets: EntrypointTargets,
  notice: (line: string) => void = () => {},
): Promise<EntrypointRuntime[]> {
  if ((await resolveGitCommonDir(projectRoot)) === undefined) return [];
  const moved: EntrypointRuntime[] = [];
  for (const entry of targets.root) {
    if (!(await rulesBlockHasLocalTarget(projectRoot, entry))) continue;
    const teamFile = rulesExportTeamFile(entry);
    if ((await refuseEscapingSymlink(projectRoot, teamFile)) !== undefined) continue;
    const filePath = path.join(projectRoot, teamFile);
    if (!(await pathExists(filePath))) continue;
    const content = await readFile(filePath, "utf8");
    if (!hasManagedRulesBlock(content)) continue;
    const head = await readHeadBlob(projectRoot, teamFile);
    if (head !== undefined && hasManagedRulesBlock(head)) continue;
    if (head === undefined && !(await indexHoldsFile(projectRoot, teamFile))) continue;

    const withoutKeryx = (text: string) => stripManagedIndexBlock(stripManagedRulesBlock(text, filePath), filePath);
    if (head !== undefined && sameApartFromBlankLines(withoutKeryx(content), withoutKeryx(head))) {
      if (!(await restoreWorktreeFileFromHead(projectRoot, teamFile))) await writeContained(projectRoot, teamFile, head);
      notice(
        (await worktreeFileIsClean(projectRoot, teamFile))
          ? `${teamFile}: moved the ${RULES_BLOCK_START_MARKER} block to the local target; the file is back at HEAD.`
          : `${teamFile}: restored from HEAD, but git still reports a difference — a staged copy may still carry the ${RULES_BLOCK_START_MARKER} block (\`git restore --staged ${teamFile}\`).`,
      );
    } else {
      await writeContained(projectRoot, teamFile, removeBlock(content, filePath, head, RULES_BLOCK));
      notice(
        head === undefined
          ? `${teamFile}: removed the ${RULES_BLOCK_START_MARKER} block for the local target. The file is staged but not committed yet — \`git add ${teamFile}\` stages this version.`
          : `${teamFile}: removed the ${RULES_BLOCK_START_MARKER} block for the local target; your other uncommitted edits in ${teamFile} are kept as they were.`,
      );
    }
    moved.push(entry.runtime);
  }
  return moved;
}

/** Why a runtime's rules-export block has no local file to go to (see `rulesBlockLocalTargetGap`). */
export type RulesBlockLocalTargetGap =
  /** The runtime's scope is shared: the team file is the target. */
  | "shared"
  /** Codex with mode `skip`: keryx writes no Codex file. */
  | "codex-skip"
  /** Codex's team file does not exist, so no override is generated. */
  | "codex-no-source"
  /** `AGENTS.override.md` exists and keryx did not generate it. */
  | "codex-foreign-override"
  /** `CLAUDE.local.md` is tracked in git: it is the team's file. */
  | "claude-tracked-local";

/**
 * Why the rules-export surface of `entry`'s runtime has no local file once
 * `init`/`update` has run, or `undefined` when it has one: Claude with scope
 * local unless git tracks `CLAUDE.local.md`; Codex with mode `override` when
 * its team file exists and the override is either not there yet (the same run
 * generates it) or keryx's own. The one predicate behind the migration
 * (`moveRulesBlocksOutOfTeamFiles`) and `keryx doctor`'s warning (flow 363
 * review round 1, F-005), matching what `resolveRulesExportTarget` resolves.
 */
export async function rulesBlockLocalTargetGap(projectRoot: string, entry: RootEntrypointEntry): Promise<RulesBlockLocalTargetGap | undefined> {
  if (entry.scope !== "local") return "shared";
  // A tracked `CLAUDE.local.md` is the team's; `writeEntrypointBlocks` does not write it either.
  if (entry.runtime === "claude") return (await trackedInGit(projectRoot, entry.path)) ? "claude-tracked-local" : undefined;
  if (entry.mode === "skip") return "codex-skip";
  if (!(await pathExists(path.join(projectRoot, entry.source)))) return "codex-no-source";
  const overridePath = path.join(projectRoot, entry.path);
  if (!(await pathExists(overridePath))) return undefined;
  return parseCodexOverrideProvenance(await readFile(overridePath, "utf8")) === undefined ? "codex-foreign-override" : undefined;
}

async function rulesBlockHasLocalTarget(projectRoot: string, entry: RootEntrypointEntry): Promise<boolean> {
  return (await rulesBlockLocalTargetGap(projectRoot, entry)) === undefined;
}

/**
 * Flow 363 review round 1, F-002: the runtimes switched to a shared scope
 * whose local target still holds the rules-export block keryx installed
 * there — `CLAUDE.local.md`, or keryx's slot in a keryx-generated
 * `AGENTS.override.md`. The writers are about to take that file (or keryx's
 * part of it) away (`planLocalLeftovers`), the rules block with it, so the
 * caller installs the surface again once the manifest names the new target
 * (`reinstallRulesExport`) — the block ends up in the team file, once.
 * Read-only. A Codex entry switched to `skip` is not listed: it has no file
 * to carry the block to.
 */
export async function rulesBlocksLeavingLocalTargets(projectRoot: string, targets: EntrypointTargets): Promise<EntrypointRuntime[]> {
  const runtimes: EntrypointRuntime[] = [];
  for (const leftover of await planLocalLeftovers(projectRoot, targets)) {
    if (leftover.action === "keep") continue;
    if (targets.root.find((entry) => entry.runtime === leftover.runtime)?.scope !== "shared") continue;
    const content = await readFile(path.join(projectRoot, leftover.path), "utf8");
    if (leftover.runtime === "codex" ? overrideSlotHoldsBlock(content) : hasManagedRulesBlock(content)) runtimes.push(leftover.runtime);
  }
  return runtimes;
}

/** A broken slot block counts as one: the override is about to go, and installing again renders it whole. */
function overrideSlotHoldsBlock(content: string): boolean {
  try {
    return overrideRulesSlot(content) !== undefined;
  } catch {
    return true;
  }
}

/**
 * `content` without its managed block, and without the blank-line padding
 * keryx put around the block when it inserted it. Only the blank lines
 * directly around the first block are touched: when `head` shows the two
 * neighbouring lines adjacent, their spacing there is reused; otherwise one
 * blank line separates them. Every other byte is `stripManagedIndexBlock`'s,
 * and the padding is written in the file's own line ending, so a CRLF file
 * stays CRLF (review round 1, F-008).
 */
function removeBlock(content: string, filePath: string, head: string | undefined, block: ManagedBlockKind = INDEX_BLOCK): string {
  const stripped = block.strip(content, filePath);
  const start = indexOfMarkerLine(content, block.startMarker, computeFencedRanges(content));
  if (start < 0) return stripped;
  const eol = lineEndingOf(content);
  const before = content.slice(0, start).replace(/(\r?\n)+$/, "");
  const after = stripped.slice(start).replace(/^(\r?\n)+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return `${before}${eol}`;
  const blankLines = head === undefined ? undefined : blankLinesBetween(head, lastLine(before), firstLine(after));
  return `${before}${eol.repeat((blankLines ?? 1) + 1)}${after}`;
}

/** `\r\n` when the file's first line ends that way, `\n` otherwise. */
function lineEndingOf(content: string): string {
  const newline = content.indexOf("\n");
  return newline > 0 && content[newline - 1] === "\r" ? "\r\n" : "\n";
}

function lastLine(text: string): string {
  return text.slice(text.lastIndexOf("\n") + 1).replace(/\r$/, "");
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
