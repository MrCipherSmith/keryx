// Flow 361: moving keryx-managed Claude Code hooks to the file
// `agentEntrypoints.claudeSettings` names, out of the other one. Run by
// `keryx init` and `keryx update`; every other command only ever resolves the
// path (`./claude-settings.ts`).
//
// Two steps, because the ignore rules are written between them:
// `decideClaudeSettingsTarget` reads and settles the scope, then
// `moveClaudeSettingsHooks` writes. What moves is every group carrying a
// `_keryxManaged` sentinel — all surfaces at once, the ones `update` never
// reinstalls (ctx guard, orient, learning observer, jev edit guard) included,
// verbatim, so a partial or customised install arrives as it was.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { removeContained, writeContained } from "../lib/contained-write";
import { indexHoldsFile, readHeadBlob, restoreWorktreeFileFromHead, worktreeFileIsClean } from "../lib/git-head";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { refuseEscapingSymlink } from "../lib/symlink-safety";
import { settingsTextHasManagedHooks } from "../rules/entrypoint-migration";
import { localClaudeSettingsTarget, sharedClaudeSettingsTarget, type ClaudeSettingsTarget } from "../rules/entrypoint-targets";
import { CLAUDE_LOCAL_SETTINGS_PATH, CLAUDE_SHARED_SETTINGS_PATH, statedClaudeSettingsTarget } from "./claude-settings";
import { retargetInstallStatePath } from "./install-state";
import { JEV_EDIT_GUARD_SURFACE } from "./jev-edit-guard-surface";
import { settingsFileOwnerFor } from "./registry";
import { MANAGED_KEY, addSentinelTo, hooksObject, readSettingsFile, writeSettingsFile } from "./settings-json";
import type { Settings } from "./types";

const MANIFEST_REL = ".metaproject/metaproject.json";
const CLAUDE_RUNTIME_ID = "claude";

type ManagedGroup = Record<string, unknown>;

async function readText(projectRoot: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(projectRoot, ...relativePath.split("/")), "utf8");
  } catch {
    return undefined;
  }
}

function isManagedGroup(value: unknown): value is ManagedGroup {
  return typeof value === "object" && value !== null && typeof (value as ManagedGroup)[MANAGED_KEY] === "string";
}

/**
 * Settles where this project's managed Claude hooks live, before anything is
 * written. Decided from the files, not from how the manifest got its entry:
 *
 * - The manifest says `shared`: the tracked `.claude/settings.json`.
 * - Managed hook groups are in `HEAD`'s `.claude/settings.json` and still in
 *   the working tree: the team committed them, so the scope is — or becomes —
 *   `shared`, whatever the manifest says, and the notice explains the switch.
 * - Anything else is local; hooks sitting in the tracked file as uncommitted
 *   edits are what `moveClaudeSettingsHooks` then takes out.
 *
 * Agrees with `resolveClaudeSettingsTarget` once the move has run, which is
 * what lets the installers called later in the same command go through the
 * resolver without being handed the answer. Reads git, writes nothing.
 */
export async function decideClaudeSettingsTarget(projectRoot: string): Promise<{ target: ClaudeSettingsTarget; notices: string[] }> {
  const stated = statedClaudeSettingsTarget(projectRoot);
  if (stated?.scope === "shared") return { target: stated, notices: [] };
  const local = localClaudeSettingsTarget();
  const working = await readText(projectRoot, CLAUDE_SHARED_SETTINGS_PATH);
  if (working === undefined || !settingsTextHasManagedHooks(working)) return { target: local, notices: [] };
  const head = await readHeadBlob(projectRoot, CLAUDE_SHARED_SETTINGS_PATH);
  if (head === undefined || !settingsTextHasManagedHooks(head)) return { target: local, notices: [] };
  return {
    target: sharedClaudeSettingsTarget(),
    notices: [
      `${CLAUDE_SHARED_SETTINGS_PATH}: keryx-managed hooks are committed in HEAD, so they stay there — agentEntrypoints.claudeSettings is ` +
        `recorded as scope "shared" and nothing is installed into ${CLAUDE_LOCAL_SETTINGS_PATH}. To switch to the per-developer file: commit ` +
        `${CLAUDE_SHARED_SETTINGS_PATH} without the keryx-managed hook groups, set claudeSettings to scope "local" in ${MANIFEST_REL}, run ` +
        "`keryx update`, and re-run any other hook installer you use (ctx, orient, learning observer, jev edit guard).",
    ],
  };
}

/**
 * Moves every keryx-managed hook group out of the Claude settings file that
 * is NOT `target` and into the one that is, so each hook exists once across
 * the two. The destination is written first: a failure in between leaves the
 * hooks doubled for one run, never absent.
 *
 * What happens to the file the hooks leave, when it is the tracked one:
 *
 * - Apart from keryx's groups it equals `HEAD` (compared as parsed content,
 *   not text): restored to `HEAD`'s bytes, so `git diff --quiet` passes.
 *   Re-serialising would not reproduce hand formatting.
 * - It has other uncommitted edits: only keryx's groups and its own
 *   top-level keys go; every other key and hook stays. Reported by name.
 * - It is not in `HEAD` (or there is no repository): same strip — unless
 *   nothing else is left and the file is not staged either. Then every byte
 *   of it was keryx's and it is removed; the alternative, an untracked `{}`,
 *   would sit in `git status` for good.
 */
export async function moveClaudeSettingsHooks(
  projectRoot: string,
  target: ClaudeSettingsTarget,
  onNotice: (line: string) => void = () => {},
): Promise<void> {
  const toLocal = target.scope === "local";
  const from = toLocal ? CLAUDE_SHARED_SETTINGS_PATH : CLAUDE_LOCAL_SETTINGS_PATH;
  const to = toLocal ? CLAUDE_LOCAL_SETTINGS_PATH : CLAUDE_SHARED_SETTINGS_PATH;

  const sourceText = await readText(projectRoot, from);
  if (sourceText === undefined || !settingsTextHasManagedHooks(sourceText)) return;
  const notMoved = (reason: string) => onNotice(`${from}: keryx-managed hooks were not moved to ${to} — ${reason}`);
  for (const relativePath of [from, to]) {
    const refusal = await refuseEscapingSymlink(projectRoot, relativePath);
    if (refusal) return notMoved(refusal);
  }
  let destination: Settings;
  try {
    destination = await readSettingsFile(path.join(projectRoot, ...to.split("/")));
  } catch (error) {
    return notMoved((error as Error).message);
  }

  const source = JSON.parse(sourceText) as Settings;
  const { remainder, groupsByEvent, sentinels } = splitManaged(source);
  const merged = mergeManaged(destination, groupsByEvent, sentinels);
  const broken = surfacesBrokenByMove(source, merged, to);
  if (broken.length > 0) return notMoved(`the result would not validate (${broken.join("; ")}).`);

  await writeSettingsFile(projectRoot, to, merged);
  await retargetInstallStatePath(projectRoot, CLAUDE_RUNTIME_ID, from, to);

  const nothingElse = Object.keys(remainder).length === 0;
  if (!toLocal) {
    // The per-developer file: gitignored, so there is no HEAD to honour.
    if (nothingElse) await removeContained(projectRoot, from);
    else await writeSettingsFile(projectRoot, from, remainder);
    onNotice(`${from}: moved the keryx-managed hooks to ${to} (claudeSettings scope is "shared").`);
    return;
  }

  const inGit = (await resolveGitCommonDir(projectRoot)) !== undefined;
  const head = inGit ? await readHeadBlob(projectRoot, from) : undefined;
  if (head === undefined) {
    const noHead = inGit ? "" : " Not a git repository, so there is no HEAD to restore the file to.";
    if (nothingElse && !(await indexHoldsFile(projectRoot, from))) {
      await removeContained(projectRoot, from);
      onNotice(`${from}: removed the file — it held nothing but keryx-managed hooks, which are now in ${to}.${noHead}`);
      return;
    }
    await writeSettingsFile(projectRoot, from, remainder);
    onNotice(
      `${from}: removed the keryx-managed hooks (now in ${to}).` +
        (inGit ? " The file is untracked, so the rest of it is left in place." : `${noHead} Only keryx's own groups and keys were taken out.`),
    );
    return;
  }
  if (settingsTextHasManagedHooks(head)) {
    // Only reachable when a caller forces local over hooks the team committed.
    await writeSettingsFile(projectRoot, from, remainder);
    onNotice(`${from}: removed the keryx-managed hooks (now in ${to}), which are committed in HEAD — commit this removal to finish the switch to local scope.`);
    return;
  }
  const headSettings = parseSettings(head);
  if (headSettings !== undefined && sameSettings(remainder, splitManaged(headSettings).remainder)) {
    if (!(await restoreWorktreeFileFromHead(projectRoot, from))) {
      await writeContained(projectRoot, from, head);
    }
    onNotice(
      (await worktreeFileIsClean(projectRoot, from))
        ? `${from}: moved the keryx-managed hooks to ${to}; the file is back at HEAD.`
        : `${from}: moved the keryx-managed hooks to ${to} and restored the file from HEAD, but git still reports a difference — a staged copy may still carry the hooks (\`git restore --staged ${from}\`).`,
    );
    return;
  }
  await writeSettingsFile(projectRoot, from, remainder);
  onNotice(`${from}: removed the keryx-managed hooks (now in ${to}); your other uncommitted edits in ${from} are kept.`);
}

/**
 * `settings` split into keryx's part and everyone else's. Keryx's: every
 * managed group under `hooks.<event>`, the top-level `_keryxManaged` list,
 * and — when no `hooks` key is left to collide with — the `unmigratedHooks`
 * slot, whose content goes back under `hooks` where keryx took it from.
 * An event, and `hooks` itself, is dropped only when removing keryx's groups
 * is what emptied it.
 */
function splitManaged(settings: Settings): { remainder: Settings; groupsByEvent: Map<string, ManagedGroup[]>; sentinels: string[] } {
  const remainder: Settings = structuredClone(settings);
  const groupsByEvent = new Map<string, ManagedGroup[]>();
  const hooks = hooksObject(remainder);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const managed = groups.filter(isManagedGroup);
    if (managed.length === 0) continue;
    groupsByEvent.set(event, managed);
    const kept = groups.filter((group) => !isManagedGroup(group));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (groupsByEvent.size > 0) {
    if (Object.keys(hooks).length > 0) remainder.hooks = hooks;
    else delete remainder.hooks;
  }

  const moving = new Set([...groupsByEvent.values()].flat().map((group) => group[MANAGED_KEY] as string));
  const listed = Array.isArray(remainder[MANAGED_KEY]) ? (remainder[MANAGED_KEY] as unknown[]).filter((value): value is string => typeof value === "string") : [];
  // The file's own order first; a sentinel with no group left behind it is not carried over.
  const sentinels = [...new Set([...listed.filter((sentinel) => moving.has(sentinel)), ...moving])];
  if (Array.isArray(remainder[MANAGED_KEY])) delete remainder[MANAGED_KEY];
  if (Array.isArray(remainder.unmigratedHooks) && remainder.hooks === undefined) {
    remainder.hooks = remainder.unmigratedHooks;
    delete remainder.unmigratedHooks;
  }
  return { remainder, groupsByEvent, sentinels };
}

/**
 * `destination` with the moved groups appended per event. A group already
 * there under the same sentinel in the same event is replaced, not doubled,
 * and everything the developer has in the file is kept — the same merge rule
 * `mergeIntoHookArray` applies on install, legacy `hooks` array included.
 */
function mergeManaged(destination: Settings, groupsByEvent: ReadonlyMap<string, ManagedGroup[]>, sentinels: readonly string[]): Settings {
  const merged: Settings = structuredClone(destination);
  if (Array.isArray(merged.hooks) && merged.hooks.length > 0) {
    merged.unmigratedHooks = [...(Array.isArray(merged.unmigratedHooks) ? merged.unmigratedHooks : []), ...merged.hooks];
    delete merged.hooks;
  }
  const hooks = hooksObject(merged);
  for (const [event, groups] of groupsByEvent) {
    const moving = new Set(groups.map((group) => group[MANAGED_KEY]));
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing.filter((group) => !(isManagedGroup(group) && moving.has(group[MANAGED_KEY]))), ...groups];
  }
  merged.hooks = hooks;
  for (const sentinel of sentinels) addSentinelTo(merged, sentinel);
  return merged;
}

/** Every Claude settings surface that validated in the file the hooks leave and would not in the merged destination. */
function surfacesBrokenByMove(source: Settings, merged: Settings, to: string): string[] {
  const surfaces = [...(settingsFileOwnerFor(to)?.surfaces() ?? []), JEV_EDIT_GUARD_SURFACE];
  const broken: string[] = [];
  for (const surface of surfaces) {
    if (!surface.validate || surface.validate(structuredClone(source)).length > 0) continue;
    broken.push(...surface.validate(structuredClone(merged)));
  }
  return broken;
}

function parseSettings(text: string): Settings | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Settings) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Equal as settings: key order does not matter, and neither does an empty
 * `hooks` object or an empty event array — a hand-written `"hooks": {}` and
 * no `hooks` key at all configure the same thing, and only one of them
 * survives keryx's groups being taken out.
 */
function sameSettings(a: Settings, b: Settings): boolean {
  return deepEqual(withoutEmptyHooks(a), withoutEmptyHooks(b));
}

function withoutEmptyHooks(settings: Settings): Settings {
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) return settings;
  const hooks = Object.fromEntries(Object.entries(settings.hooks as Settings).filter(([, groups]) => !(Array.isArray(groups) && groups.length === 0)));
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && deepEqual(left[key], right[key]));
}
