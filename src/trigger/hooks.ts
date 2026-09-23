// Flow 286 T9, AC5: `keryx trigger install` writes the hook blocks that call
// `keryx trigger run <name>` for every EVENT-fired entry — extending
// `src/lib/managed-hook.ts`'s shared multi-block writer (itself pulled out of
// `src/commands/update.ts`'s `installManagedHook`, per the T5 survey's
// instruction to reuse that mechanism, not `src/sync/hooks.ts`'s narrower
// single-block one). Core zone: this module only decides WHAT block goes into
// WHICH hook file for a declared entry; it never runs `keryx trigger run`
// itself and never imports adapter code.

import { hasManagedHook, installManagedHook, removeManagedHook } from "../lib/managed-hook";
import { resolveGitHooksRoot } from "../lib/git-hooks";
import { loadTriggersConfig, type TriggerEntry, type TriggerEventName } from "./config";

/**
 * Event names a git hook can actually fire for. `"ci"` is deliberately
 * excluded — per `./config.ts`'s own doc comment, a `"ci"`-fired entry is
 * declared so a CI job's own `keryx trigger run <name>` call is documented,
 * not so keryx writes a git hook for it; there is no git hook named `ci`.
 */
const HOOKABLE_EVENTS: readonly TriggerEventName[] = ["post-merge", "post-commit", "post-checkout"];

export function isHookableTriggerEntry(entry: TriggerEntry): entry is TriggerEntry & { fire: { kind: "event"; event: TriggerEventName } } {
  // Flow 295 (F1c): a schedule-store entry is never hooked. The loader already
  // refuses a store entry that is not schedule-fired; this is the second lock.
  return entry.source !== "store" && entry.fire.kind === "event" && (HOOKABLE_EVENTS as readonly string[]).includes(entry.fire.event);
}

function blockId(name: string): string {
  return `trigger-${name}`;
}

/**
 * The managed block's shell body. Mirrors `src/sync/hooks.ts`'s `hookBody`
 * shape exactly (same guards, same "advisory, never block the hook" posture)
 * for the same reason `../commands/trigger.ts`'s own header comment gives for
 * reusing `syncCommand`/`gdgraphCommand` rather than reimplementing them: this
 * hook body is not new behaviour, it is the same "call keryx, swallow its
 * failure, never fail the git operation" contract every managed hook block in
 * this project already keeps.
 */
function hookBody(name: string, hookName: TriggerEventName): string {
  const fn = `keryx_trigger_${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${hookName.replace(/-/g, "_")}`;
  // post-checkout gets: $1 old-ref $2 new-ref $3 branch-flag (1=branch checkout).
  // Skip file-only checkouts, exactly like `src/sync/hooks.ts` does.
  const guard = hookName === "post-checkout" ? '  [ "${3:-1}" = "1" ] || return 0\n' : "";
  return `${fn}() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
${guard}  command -v keryx >/dev/null 2>&1 || return 0
  # Fired trigger "${name}" — see .metaproject/triggers.json. Never fails the
  # git operation: the run's own outcome (including a failure) is recorded by
  # \`keryx trigger run\` itself (AC4), not surfaced as a hook error here.
  keryx trigger run ${name} >/dev/null 2>&1 || true
  return 0
}
${fn} "$@"`;
}

export interface TriggerHookResult {
  readonly name: string;
  readonly hook: TriggerEventName;
  /** `installManagedHook`/`removeManagedHook`'s own return: false only when there is no `.git` hooks directory at all. */
  readonly wrote: boolean;
}

/**
 * Install (or update) a hook block for every declared, EVENT-fired trigger
 * entry — regardless of `enabled`. A disabled entry still gets its hook block
 * (so re-enabling it in the config takes effect on the very next fire without
 * needing `trigger install` run again); `keryx trigger run` is what refuses a
 * disabled entry at run time, not the hook installer.
 */
export async function installTriggerHooks(projectRoot: string): Promise<TriggerHookResult[]> {
  const { triggers } = loadTriggersConfig(projectRoot);
  const results: TriggerHookResult[] = [];
  for (const entry of triggers) {
    if (!isHookableTriggerEntry(entry)) continue;
    const hookName = entry.fire.event;
    const wrote = await installManagedHook(projectRoot, hookName, blockId(entry.name), hookBody(entry.name, hookName));
    results.push({ name: entry.name, hook: hookName, wrote });
  }
  return results;
}

/** Remove the hook block for every declared, event-fired trigger entry. Leaves every other managed block (e.g. `keryx-sync`, `gdgraph-post-commit`) untouched. */
export async function uninstallTriggerHooks(projectRoot: string): Promise<TriggerHookResult[]> {
  const { triggers } = loadTriggersConfig(projectRoot);
  const results: TriggerHookResult[] = [];
  for (const entry of triggers) {
    if (!isHookableTriggerEntry(entry)) continue;
    const hookName = entry.fire.event;
    const wrote = await removeManagedHook(projectRoot, hookName, blockId(entry.name));
    results.push({ name: entry.name, hook: hookName, wrote });
  }
  return results;
}

/** Read-only: whether `entry`'s hook block is currently installed. `false` for a schedule/`"ci"` entry — there is nothing to install for those (`keryx trigger list`'s "hook installed" column). */
export async function isTriggerHookInstalled(projectRoot: string, entry: TriggerEntry): Promise<boolean> {
  if (!isHookableTriggerEntry(entry)) return false;
  return hasManagedHook(projectRoot, entry.fire.event, blockId(entry.name));
}

/** Whether this project has a `.git` hooks directory at all — for a clear "nothing installed" reason distinct from "nothing declared". */
export async function hasGitHooksRoot(projectRoot: string): Promise<boolean> {
  return (await resolveGitHooksRoot(projectRoot)) !== null;
}
