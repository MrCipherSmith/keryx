// Flow 305 (W5-a): the ONE set of JSON walkers every surface's merge/strip/
// validate is built from. Moved verbatim (in behaviour) from
// `src/ctx/runtimes.ts`, `src/ctx/orient-runtimes.ts` and
// `src/security/agent-hooks/runtimes.ts`, which used to carry three
// independently-drifting copies — the root cause of the `hooks: object` vs
// `hooks: array` collision (OQ-3) this refactor closes by construction.
//
// Nothing here knows about any particular harness or subsystem; every
// function takes the sentinel/container/key/shape it needs as parameters.

import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { writeContained } from "../lib/contained-write";
import type { Settings } from "./types";

export const MANAGED_KEY = "_keryxManaged";

// --- sentinel bookkeeping ----------------------------------------------------

/** True when `value` is a managed group carrying exactly this sentinel. */
export function isManagedBy(sentinel: string): (value: unknown) => boolean {
  return (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[MANAGED_KEY] === sentinel;
}

/** `existing` with every group carrying `sentinel` removed; non-arrays become `[]`. */
export function stripManagedBy(sentinel: string): (existing: unknown) => unknown[] {
  const isManaged = isManagedBy(sentinel);
  return (existing: unknown): unknown[] => (Array.isArray(existing) ? existing.filter((g) => !isManaged(g)) : []);
}

/** Move `sentinel` to the end of `settings._keryxManaged`, filtering any duplicate. */
export function addSentinelTo(settings: Settings, sentinel: string): void {
  const managed = Array.isArray(settings[MANAGED_KEY])
    ? (settings[MANAGED_KEY] as unknown[]).filter((v) => v !== sentinel)
    : [];
  settings[MANAGED_KEY] = [...managed, sentinel];
}

/** Remove `sentinel` from `settings._keryxManaged`; deletes the key when it empties out. */
export function removeSentinelFrom(settings: Settings, sentinel: string): void {
  if (!Array.isArray(settings[MANAGED_KEY])) return;
  const managed = (settings[MANAGED_KEY] as unknown[]).filter((v) => v !== sentinel);
  if (managed.length > 0) settings[MANAGED_KEY] = managed;
  else delete settings[MANAGED_KEY];
}

// --- `hooks` object helpers ---------------------------------------------------

/** `settings.hooks` as a shallow-copied object, or `{}` when it is absent/not an object/array. */
export function hooksObject(settings: Settings): Settings {
  return typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
    ? { ...(settings.hooks as Settings) }
    : {};
}

/**
 * Merge `group` into `settings.hooks[key]`, stripping any prior group carrying
 * `sentinel` first (idempotent re-install) and moving `sentinel` to the end of
 * `_keryxManaged`.
 *
 * A pre-existing LEGACY ARRAY under `hooks` (the shape written before ctx and
 * security used the same key) is not ours and is not discarded: it is moved to
 * `unmigratedHooks` so a caller that wrote raw entries there does not lose them
 * to a wholesale replace.
 *
 * F6 (deliberate behaviour change, decision recorded by the orchestrator):
 * every JSON surface built on this walker — including orient and claude
 * security, which previously discarded a pre-existing legacy `hooks` array
 * outright on that class of installer — now preserves it under
 * `unmigratedHooks` instead. This is intentionally not "no behaviour change":
 * the old discard-on-migrate behaviour was itself the bug this generalises
 * away from.
 */
export function mergeIntoHookArray(settings: Settings, key: string, group: Settings, sentinel: string): Settings {
  if (Array.isArray(settings.hooks) && settings.hooks.length > 0) {
    settings.unmigratedHooks = [
      ...(Array.isArray(settings.unmigratedHooks) ? settings.unmigratedHooks : []),
      ...settings.hooks,
    ];
    delete settings.hooks;
  }
  const hooks = hooksObject(settings);
  hooks[key] = [...stripManagedBy(sentinel)(hooks[key]), group];
  settings.hooks = hooks;
  addSentinelTo(settings, sentinel);
  return settings;
}

/** The counterpart of `mergeIntoHookArray`: strip `sentinel`'s group from `hooks[key]`. */
export function stripFromHookArray(settings: Settings, key: string, sentinel: string): Settings {
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    removeSentinelFrom(settings, sentinel);
    return settings;
  }
  const hooks = { ...(settings.hooks as Settings) };
  if (Array.isArray(hooks[key])) {
    const remaining = stripManagedBy(sentinel)(hooks[key]);
    if (remaining.length > 0) hooks[key] = remaining;
    else delete hooks[key];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  removeSentinelFrom(settings, sentinel);
  return settings;
}

// --- the generalised managed-groups walker -----------------------------------

export type GroupShape = "flat" | "nested" | "lenient";

export interface ManagedGroupsQuery {
  readonly sentinel: string;
  /** Top-level key holding a nested container object; omit for a flat top-level array. */
  readonly container?: string;
  /** Sub-key under `container`, or the top-level array key when `container` is omitted. */
  readonly key: string;
  /**
   * `flat`: the group's own `command` must match. `nested`: the group's
   * `hooks` array must contain an entry whose `command` matches AND whose
   * `type` is `"command"` (a harness executes only `type:"command"` entries,
   * so a `type:"prompt"` entry must not read as installed). `lenient`: either
   * shape counts, and the nested check drops the `type` requirement — used
   * only where two harness families use `command` and `hooks[].command`
   * interchangeably and drift between them (see orient's matcher).
   */
  readonly shape: GroupShape;
  readonly commandMatches: (command: string) => boolean;
  /** Extra field a group must carry to belong to this query (security's `on`). */
  readonly matchField?: { readonly key: string; readonly value: string };
}

/** The array at `container[key]` (or top-level `key` when `container` is omitted). */
export function arrayAt(settings: Settings, container: string | undefined, key: string): unknown[] {
  const holder = container
    ? typeof settings[container] === "object" && settings[container] !== null
      ? (settings[container] as Settings)
      : undefined
    : settings;
  const list = holder ? holder[key] : undefined;
  return Array.isArray(list) ? (list as unknown[]) : [];
}

function ownsCommand(group: Record<string, unknown>, shape: GroupShape, commandMatches: (c: string) => boolean): boolean {
  const entry = group as { hooks?: unknown; command?: unknown };
  const flatOwns = typeof entry.command === "string" && commandMatches(entry.command);
  const nestedOwns = (requireType: boolean): boolean =>
    Array.isArray(entry.hooks) &&
    (entry.hooks as Array<{ command?: unknown; type?: unknown }>).some(
      (h) => typeof h?.command === "string" && commandMatches(h.command) && (!requireType || h.type === "command"),
    );
  if (shape === "flat") return flatOwns;
  if (shape === "nested") return nestedOwns(true);
  return flatOwns || nestedOwns(false);
}

/**
 * Managed groups matching `query` — one walker for every JSON surface in the
 * registry. Generalises `managedGroupsFor` (ctx), `hasManaged` (orient) and the
 * flat/claude validators (security) into a single implementation, so a fourth
 * settings shape needs to teach this ONE function its shape rather than one of
 * several copies that can silently fall behind.
 */
export function managedGroups(settings: Settings, query: ManagedGroupsQuery): Array<Record<string, unknown>> {
  const isManaged = isManagedBy(query.sentinel);
  return arrayAt(settings, query.container, query.key).filter((group): group is Record<string, unknown> => {
    if (!isManaged(group)) return false;
    const record = group as Record<string, unknown>;
    if (query.matchField && record[query.matchField.key] !== query.matchField.value) return false;
    return ownsCommand(record, query.shape, query.commandMatches);
  });
}

// --- settings file read/write -------------------------------------------------

/** Reads a JSON settings file; `{}` when absent or not a plain object. Throws on invalid JSON. */
export async function readSettingsFile(file: string): Promise<Settings> {
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
    return {};
  } catch {
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

/**
 * Writes `settings` as 2-space-indented JSON, newline-terminated, creating
 * parent dirs. Routed through `writeContained` (flow 313 W4 lane C1): `root`
 * + `relativePath`, not a pre-joined absolute path, so the containment check
 * runs on the same segments the caller resolved the symlink refusal against.
 */
export async function writeSettingsFile(root: string, relativePath: string, settings: Settings): Promise<void> {
  await writeContained(root, relativePath, `${JSON.stringify(settings, null, 2)}\n`);
}
