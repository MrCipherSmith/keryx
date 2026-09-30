// Flow 361: the readers' view of the entrypoint targets — where the managed
// `keryx:index` block, the managed ignore block and the keryx-managed Claude
// hooks are now, against where `agentEntrypoints` says they belong. One
// inspection feeds both `keryx doctor` (which warns) and `init --preview` /
// `update --preview` (which say what a real run would move), so the two cannot
// disagree with each other or with the writers they describe: every decision
// below is the writers' own (`resolveProjectEntrypoints`,
// `decideClaudeSettingsTarget`, `planMetaprojectIgnoreRules`).
//
// Read-only throughout: git is asked, nothing is written.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeSettingsFileHoldsManagedHooks, CLAUDE_LOCAL_SETTINGS_PATH, CLAUDE_SHARED_SETTINGS_PATH } from "../integrations/claude-settings";
import { decideClaudeSettingsTarget } from "../integrations/claude-settings-migration";
import { pathExists } from "../lib/fs";
import { indexHoldsFile, readHeadBlob } from "../lib/git-head";
import { explainIgnoredPaths } from "../lib/git-local-ignore";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { hasManagedIgnoreBlock, planMetaprojectIgnoreRules } from "../lib/metaproject-gitignore";
import { settingsTextHasManagedHooks } from "./entrypoint-migration";
import { ruleImportSources, type CodexLocalRootEntry, type EntrypointTargets } from "./entrypoint-targets";
import {
  codexOverrideByteSize,
  codexOverrideState,
  ignoredLocalTargetPaths,
  planLocalLeftovers,
  resolveProjectEntrypoints,
  type CodexOverrideState,
  type LocalLeftover,
} from "./entrypoint-writers";
import { hasManagedIndexBlock } from "./managed-index-block";

const TEAM_FILE_NAMES = ["agents.md", "claude.md"];

/** Managed content found in a file it does not belong in. */
export type MisplacedContent = {
  path: string;
  /** The index (and so, normally, `HEAD`) holds the file: an edit to it shows in `git status`. */
  tracked: boolean;
  /** `HEAD`'s version carries the managed content too — the team committed it. */
  committed: boolean;
};

export type LocalTargetState = {
  path: string;
  kind: "claude" | "codex" | "claudeSettings";
  exists: boolean;
  /** A real run would write it here: always for Claude, for Codex when its source exists, for the settings file when hooks are installed. */
  expected: boolean;
  /** Asked of git for a file that exists; `undefined` for a missing file or outside git. */
  ignored?: boolean;
};

export type EntrypointInspection = {
  git: boolean;
  /** Entry form, settled exactly as `init`/`update` settle it. */
  targets: EntrypointTargets;
  /** The writers' own "stays shared" notices for what the team committed. */
  notices: string[];
  /** Team files (and custom import sources) holding the block while no shared entry names them. */
  strayIndexBlocks: MisplacedContent[];
  /** Shared targets that hold the block, with whether `HEAD` has it. */
  sharedIndexBlocks: Array<{ path: string; committed: boolean }>;
  /** Shared targets with no file: a real run creates the team file (the only case keryx creates one). */
  missingSharedTargets: string[];
  /** The managed ignore block in `.gitignore`, where it no longer belongs unless committed. */
  gitignoreBlock?: MisplacedContent;
  /** Keryx-managed hooks in the Claude settings file that is not the target. */
  strayHooks?: MisplacedContent & { to: string };
  /** Both Claude settings files hold managed hooks: Claude Code merges them and runs each twice. */
  duplicateHooks: boolean;
  /** The target settings file holds the managed hooks. */
  targetHoldsHooks: boolean;
  localTargets: LocalTargetState[];
  /** What keryx left in the local target of a runtime that went back to shared (or Codex to `skip`), and what a run does about it. */
  localLeftovers: LocalLeftover[];
  claudeLocal?: { path: string; exists: boolean; hasBlock: boolean };
  codex?:
    | { entry: CodexLocalRootEntry; mode: "skip" }
    | { entry: CodexLocalRootEntry; mode: "override"; sourceExists: boolean; state: CodexOverrideState; bytes?: number };
};

export type InspectEntrypointsOptions = {
  /** Keryx-managed Claude hooks are installed for this project, so a local settings file is expected. */
  hooksExpected?: boolean;
};

export async function inspectEntrypoints(
  projectRoot: string,
  agentEntrypoints: unknown,
  options: InspectEntrypointsOptions = {},
): Promise<EntrypointInspection> {
  const git = (await resolveGitCommonDir(projectRoot)) !== undefined;
  const resolved = await resolveProjectEntrypoints(projectRoot, agentEntrypoints);
  const claudeSettings = await decideClaudeSettingsTarget(projectRoot);
  const targets: EntrypointTargets = { root: resolved.targets.root, claudeSettings: claudeSettings.target };

  const placement = async (relativePath: string, managed: (text: string) => boolean): Promise<MisplacedContent> => {
    if (!git) return { path: relativePath, tracked: false, committed: false };
    const head = await readHeadBlob(projectRoot, relativePath);
    return {
      path: relativePath,
      tracked: head !== undefined || (await indexHoldsFile(projectRoot, relativePath)),
      committed: head !== undefined && managed(head),
    };
  };

  const sharedPaths = new Set(targets.root.filter((entry) => entry.scope === "shared").map((entry) => entry.path.toLowerCase()));
  const strayIndexBlocks: MisplacedContent[] = [];
  const seen = new Set<string>();
  for (const source of [...ruleImportSources(targets), ...resolved.importSources]) {
    const key = source.toLowerCase();
    if (seen.has(key) || sharedPaths.has(key)) continue;
    seen.add(key);
    const text = await readText(projectRoot, source);
    if (text === undefined || !hasManagedIndexBlock(text)) continue;
    const found = await placement(source, hasManagedIndexBlock);
    // `moveBlockOutOfTeamFile` leaves a committed block in a custom import source alone.
    if (found.committed && !TEAM_FILE_NAMES.includes(key)) continue;
    strayIndexBlocks.push(found);
  }
  const sharedIndexBlocks: EntrypointInspection["sharedIndexBlocks"] = [];
  const missingSharedTargets: string[] = [];
  for (const entry of targets.root) {
    if (entry.scope !== "shared") continue;
    const text = await readText(projectRoot, entry.path);
    if (text === undefined) missingSharedTargets.push(entry.path);
    if (text === undefined || !hasManagedIndexBlock(text)) continue;
    sharedIndexBlocks.push({ path: entry.path, committed: (await placement(entry.path, hasManagedIndexBlock)).committed });
  }

  const gitignoreText = await readText(projectRoot, ".gitignore");
  const gitignoreBlock =
    gitignoreText !== undefined && hasManagedIgnoreBlock(gitignoreText) ? await placement(".gitignore", hasManagedIgnoreBlock) : undefined;

  const hooksTarget = targets.claudeSettings.path;
  const hooksOther = targets.claudeSettings.scope === "local" ? CLAUDE_SHARED_SETTINGS_PATH : CLAUDE_LOCAL_SETTINGS_PATH;
  const targetHoldsHooks = claudeSettingsFileHoldsManagedHooks(projectRoot, hooksTarget);
  const otherHoldsHooks = claudeSettingsFileHoldsManagedHooks(projectRoot, hooksOther);
  const strayHooks = otherHoldsHooks ? { ...(await placement(hooksOther, settingsTextHasManagedHooks)), to: hooksTarget } : undefined;

  const localTargets: LocalTargetState[] = [];
  let claudeLocal: EntrypointInspection["claudeLocal"];
  let codex: EntrypointInspection["codex"];
  for (const entry of targets.root) {
    if (entry.scope !== "local") continue;
    if (entry.runtime === "claude") {
      const text = await readText(projectRoot, entry.path);
      claudeLocal = { path: entry.path, exists: text !== undefined, hasBlock: text !== undefined && hasManagedIndexBlock(text) };
      localTargets.push({ path: entry.path, kind: "claude", exists: text !== undefined, expected: true });
      continue;
    }
    if (entry.mode === "skip") {
      codex = { entry, mode: "skip" };
      continue;
    }
    const sourceExists = await pathExists(path.join(projectRoot, entry.source));
    const state = await codexOverrideState(projectRoot, entry);
    const bytes = await codexOverrideByteSize(projectRoot, entry);
    codex = { entry, mode: "override", sourceExists, state, ...(bytes === undefined ? {} : { bytes }) };
    localTargets.push({ path: entry.path, kind: "codex", exists: state !== "missing", expected: sourceExists });
  }
  if (targets.claudeSettings.scope === "local") {
    const exists = await pathExists(path.join(projectRoot, ...hooksTarget.split("/")));
    localTargets.push({ path: hooksTarget, kind: "claudeSettings", exists, expected: options.hooksExpected === true });
  }
  const existing = localTargets.filter((target) => target.exists);
  const explained = git && existing.length > 0 ? await explainIgnoredPaths(projectRoot, existing.map((target) => target.path)) : undefined;
  for (const [index, target] of existing.entries()) {
    const ignored = explained?.[index]?.ignored;
    if (ignored !== undefined) target.ignored = ignored;
  }

  return {
    git,
    targets,
    notices: [...resolved.notices, ...claudeSettings.notices],
    strayIndexBlocks,
    sharedIndexBlocks,
    missingSharedTargets,
    ...(gitignoreBlock === undefined ? {} : { gitignoreBlock }),
    ...(strayHooks === undefined ? {} : { strayHooks }),
    duplicateHooks: targetHoldsHooks && otherHoldsHooks,
    targetHoldsHooks,
    localTargets,
    localLeftovers: await planLocalLeftovers(projectRoot, targets),
    ...(claudeLocal === undefined ? {} : { claudeLocal }),
    ...(codex === undefined ? {} : { codex }),
  };
}

/**
 * Whether keryx-managed Claude hooks are installed for the project, from the
 * two tracked records of it: the security module's `hooks.agent` in the
 * manifest, and the Claude integration's install-state. Either one means a
 * checkout without the local settings file is missing its hooks.
 */
export async function claudeHooksExpected(projectRoot: string, manifest: unknown): Promise<boolean> {
  const security = isRecord(manifest) && isRecord(manifest.modules) ? manifest.modules.security : undefined;
  if (isRecord(security) && security.enabled === true && isRecord(security.hooks) && typeof security.hooks.agent === "string") return true;
  const state = await readText(projectRoot, ".metaproject/data/integrations/install-state/claude.json");
  if (state === undefined) return false;
  try {
    const parsed = JSON.parse(state) as { installedModules?: Array<{ writtenPaths?: unknown }> };
    return (parsed.installedModules ?? []).some(
      (record) => Array.isArray(record.writtenPaths) && record.writtenPaths.some((written) => written === CLAUDE_LOCAL_SETTINGS_PATH || written === CLAUDE_SHARED_SETTINGS_PATH),
    );
  } catch {
    return false;
  }
}

/**
 * The lines `init --preview` and `update --preview` print about entrypoints:
 * what moves (index block, `.gitignore` block, Claude hooks), what the local
 * targets would become, and what `info/exclude` would hold. Writes nothing.
 */
export async function previewEntrypointLines(projectRoot: string, agentEntrypoints: unknown): Promise<string[]> {
  const inspection = await inspectEntrypoints(projectRoot, agentEntrypoints);
  const lines = [...inspection.notices];
  const localBlockTargets = inspection.targets.root
    .filter((entry) => entry.scope === "local" && !(entry.runtime === "codex" && entry.mode === "skip"))
    .map((entry) => entry.path);

  for (const stray of inspection.strayIndexBlocks) {
    lines.push(
      stray.committed
        ? `${stray.path}: the managed keryx block is committed in HEAD; it would be removed, and the removal left for you to commit.`
        : `${stray.path}: the managed keryx block would be taken out; it lives in ${localBlockTargets.join(" and ") || "the local targets"} instead.`,
    );
  }
  for (const missing of inspection.missingSharedTargets) {
    lines.push(`${missing}: does not exist; its scope is "shared", so a real run would create it with the managed keryx block.`);
  }
  if (inspection.claudeLocal !== undefined) {
    const { path: claudePath, exists, hasBlock } = inspection.claudeLocal;
    lines.push(
      !exists
        ? `${claudePath}: would be created with the managed keryx block.`
        : hasBlock
          ? `${claudePath}: carries the managed keryx block; it would be refreshed in place.`
          : `${claudePath}: would get the managed keryx block; the rest of the file is kept.`,
    );
  }
  lines.push(...codexPreviewLines(inspection.codex));
  lines.push(...inspection.localLeftovers.map(leftoverPreviewLine));

  if (inspection.gitignoreBlock !== undefined) {
    lines.push(
      inspection.gitignoreBlock.committed
        ? ".gitignore: the managed keryx ignore block is committed in HEAD, so it would stay there."
        : ".gitignore: the managed keryx ignore block would move to info/exclude.",
    );
  }
  if (inspection.strayHooks !== undefined) {
    lines.push(`${inspection.strayHooks.path}: the keryx-managed hooks would move to ${inspection.strayHooks.to}.`);
  }

  const localTargets = await ignoredLocalTargetPaths(projectRoot, inspection.targets);
  const plan = await planMetaprojectIgnoreRules(projectRoot, { localTargets });
  if (plan.status === "not-a-git-repository") {
    lines.push("info/exclude: skipped — not a git repository; the local targets would still be written.");
  } else if (plan.exclude.status === "refused") {
    lines.push(`info/exclude (${displayPath(projectRoot, plan.exclude.excludePath)}): would not be written — ${plan.exclude.detail}.`);
  } else if (plan.exclude.status !== "not-a-git-repository") {
    const shown = displayPath(projectRoot, plan.exclude.excludePath);
    const localEntries = plan.entries.filter((entry) => localTargets.includes(entry));
    const localNote = localEntries.length > 0 ? `; local targets: ${localEntries.join(", ")}` : "";
    lines.push(
      plan.exclude.status === "unchanged"
        ? `info/exclude (${shown}): already holds keryx's managed block (${plan.entries.length} entries); unchanged.`
        : plan.entries.length === 0
          ? `info/exclude (${shown}): would remove keryx's managed block — the repository's own rules already ignore every entry.`
          : `info/exclude (${shown}): would write keryx's managed block (${plan.entries.length} entries)${localNote}.`,
    );
  }
  return lines.map((line) => `Entrypoints: ${line}`);
}

function leftoverPreviewLine(leftover: LocalLeftover): string {
  switch (leftover.action) {
    case "remove":
      return leftover.runtime === "claude"
        ? `${leftover.path}: would be removed — it holds nothing but keryx's content, and ${leftover.because}.`
        : `${leftover.path}: would be removed — keryx generated it, and ${leftover.because}, so Codex would read ${leftover.instead} again.`;
    case "strip":
      return `${leftover.path}: the managed keryx block would be taken out (${leftover.because}); the rest of the file is kept.`;
    default:
      return `${leftover.path}: would be left in place — ${leftover.reason}.`;
  }
}

function codexPreviewLines(codex: EntrypointInspection["codex"]): string[] {
  if (codex === undefined) return [];
  if (codex.mode === "skip") return ['Codex: skipped — the codex entry has mode "skip", so no Codex file would be written.'];
  const { path: overridePath, source } = codex.entry;
  if (!codex.sourceExists) return [`Codex: skipped — ${source} does not exist, and ${overridePath} is only ever generated from it.`];
  switch (codex.state) {
    case "missing":
      return [`${overridePath}: would be generated from ${source}.`];
    case "fresh":
      return [`${overridePath}: up to date with ${source}.`];
    case "unmanaged":
      return [`${overridePath}: exists and was not generated by keryx; it would be left untouched.`];
    case "source-refused":
      return [`Codex: skipped — ${source} is reached through a symlink leaving the project, so it would not be read and ${overridePath} would not be generated.`];
    default:
      return [`${overridePath}: would be regenerated — ${source} changed since it was generated.`];
  }
}

async function readText(projectRoot: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(projectRoot, ...relativePath.split("/")), "utf8");
  } catch {
    return undefined;
  }
}

/** `.git/info/exclude` for the main checkout; the absolute path from a linked worktree, where it lies outside the project. */
function displayPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target);
  return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
