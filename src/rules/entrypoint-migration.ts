// Flow 361: the one decision a legacy manifest cannot answer on its own —
// does an entry that used to mean "the block is in the tracked team file"
// migrate as `scope: "shared"` or `scope: "local"`.
//
// The evidence is `HEAD`, never the working tree: a managed block (for the
// settings file, a keryx-managed hook group) that is COMMITTED is the team's
// choice and stays shared; one that exists only as an uncommitted edit is
// keryx's own write into a tracked file, which is exactly what local scope
// exists to stop.

import { MANAGED_KEY } from "../integrations/settings-json";
import { classifyAgainstHead, readHeadBlob, type HeadStatus } from "../lib/git-head";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import {
  localClaudeSettingsTarget,
  localRootEntry,
  type EntrypointScope,
  type EntrypointTargets,
  type LegacyEntrypoint,
  type NormalizedEntrypointTargets,
} from "./entrypoint-targets";
import { hasManagedIndexBlock } from "./managed-index-block";

export type LegacyScopeDecision = {
  scope: EntrypointScope;
  reason:
    /** The block / managed hooks are in `HEAD`'s version: the team committed them. */
    | "managed-in-head"
    /** `HEAD` has the file, without the block / managed hooks. */
    | "not-managed-in-head"
    /** `HEAD` has no such file: untracked, missing, or no commit yet. */
    | "not-in-head"
    | "not-a-git-repository";
  /** The file against `HEAD`, for the caller choosing between restore, strip and leave-in-place. */
  head: HeadStatus;
};

export type ResolvedLegacyEntrypointTargets = {
  /** Entry form throughout; normalizing it again reports nothing left to decide. */
  targets: EntrypointTargets;
  decisions: Array<LegacyScopeDecision & { legacy: LegacyEntrypoint }>;
};

/**
 * True when `text` is a JSON settings file with at least one keryx-managed
 * hook group — an object carrying the `_keryxManaged` sentinel under
 * `hooks.<event>[]`. Parsed, not substring-matched, and for any sentinel, so
 * every surface (security, ctx guard, orient, learning, edit guard) counts.
 * Unparseable text holds no managed group.
 */
export function settingsTextHasManagedHooks(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
  return Object.values(parsed.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((group) => isRecord(group) && typeof group[MANAGED_KEY] === "string"),
  );
}

/** Decides the migrated scope of one legacy entry from `HEAD`'s version of its file. */
export async function decideLegacyEntrypointScope(projectRoot: string, legacy: LegacyEntrypoint): Promise<LegacyScopeDecision> {
  if ((await resolveGitCommonDir(projectRoot)) === undefined) {
    return { scope: "local", reason: "not-a-git-repository", head: "untracked" };
  }
  const committed = await readHeadBlob(projectRoot, legacy.path);
  if (committed === undefined) {
    return { scope: "local", reason: "not-in-head", head: "untracked" };
  }
  const head = await classifyAgainstHead(projectRoot, legacy.path);
  const managed = legacy.kind === "claudeSettings" ? settingsTextHasManagedHooks(committed) : hasManagedIndexBlock(committed);
  return managed
    ? { scope: "shared", reason: "managed-in-head", head }
    : { scope: "local", reason: "not-managed-in-head", head };
}

/**
 * Settles every legacy candidate of a normalized manifest. A `shared`
 * decision keeps the provisional shared entry untouched; a `local` one swaps
 * in the local target, and a Codex override keeps the legacy file as its
 * source. Reads git, writes nothing.
 */
export async function resolveLegacyEntrypointTargets(
  projectRoot: string,
  normalized: NormalizedEntrypointTargets,
): Promise<ResolvedLegacyEntrypointTargets> {
  const targets: EntrypointTargets = {
    root: [...normalized.targets.root],
    claudeSettings: normalized.targets.claudeSettings,
  };
  const decisions: ResolvedLegacyEntrypointTargets["decisions"] = [];
  for (const legacy of normalized.legacy) {
    const decision = await decideLegacyEntrypointScope(projectRoot, legacy);
    decisions.push({ ...decision, legacy });
    if (decision.scope === "shared") continue;
    if (legacy.kind === "claudeSettings") {
      targets.claudeSettings = localClaudeSettingsTarget();
      continue;
    }
    const index = targets.root.findIndex((entry) => entry.runtime === legacy.runtime);
    if (index >= 0) targets.root[index] = localRootEntry(legacy.runtime, legacy.path);
  }
  return { targets, decisions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
