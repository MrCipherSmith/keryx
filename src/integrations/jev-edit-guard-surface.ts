// Flow 343: the Jev EDIT GUARD's own `PostToolUse` surface — a standalone
// `SurfaceAdapter` built from this directory's shared JSON walkers
// (`mergeIntoHookArray`/`stripFromHookArray`/`managedGroups`, `./settings-
// json.ts`), the SAME merge-safe primitives `./surfaces.ts`'s ctx-guard and
// security surfaces are built from. Deliberately NOT added to
// `HARNESS_ADAPTERS`/the capability matrix (flow 305's W5 registry) — this
// is a single-runtime (Claude Code only), single-file feature with its own
// CLI (`keryx review jev-edit-guard install|uninstall|status`,
// `src/commands/review-jev-edit-guard.ts`), not a cross-harness capability
// that belongs in the shared install/doctor/matrix surface. It is exported
// from `./service.ts` so that CLI never reaches for `./settings-json.ts`
// directly — the deep module path documented there as "for this
// directory's own surfaces... a caller outside this directory should never
// reach for directly".

import { MANAGED_KEY, managedGroups, mergeIntoHookArray, stripFromHookArray } from "./settings-json";
import type { Settings, SurfaceAdapter } from "./types";

export const EDIT_GUARD_HOOK_SENTINEL = "jev-edit-guard-hooks";
export const EDIT_GUARD_HOOK_MATCHER = "Edit|Write|MultiEdit";
export const EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

export function editGuardHookCommand(): string {
  return "keryx review jev-edit-guard --hook claude";
}

function editGuardPostToolUseGroup(): Settings {
  return {
    matcher: EDIT_GUARD_HOOK_MATCHER,
    hooks: [{ type: "command", command: editGuardHookCommand() }],
    [MANAGED_KEY]: EDIT_GUARD_HOOK_SENTINEL,
  };
}

function validateEditGuardSurface(settings: Settings): string[] {
  const present = managedGroups(settings, {
    sentinel: EDIT_GUARD_HOOK_SENTINEL,
    container: "hooks",
    key: "PostToolUse",
    shape: "nested",
    commandMatches: (c) => c === editGuardHookCommand(),
  });
  if (present.length === 0) return [`jev-edit-guard: missing PostToolUse(${EDIT_GUARD_HOOK_MATCHER}) guard`];
  const stale = present.some((g) => typeof g.matcher !== "string" || g.matcher !== EDIT_GUARD_HOOK_MATCHER);
  if (stale) {
    return [
      `jev-edit-guard: PostToolUse guard does not match ${EDIT_GUARD_HOOK_MATCHER}; an edit tool it should cover bypasses it. ` +
        "Re-run `keryx review jev-edit-guard install`.",
    ];
  }
  return [];
}

/**
 * A standalone `SurfaceAdapter`, not part of the W5 harness-adapter registry
 * (see file header). `settingsFile`/`relativePath` are still set — a future
 * caller that wants this surface through `SettingsFileOwner`'s generic path
 * rather than a direct `createSettingsFileOwner` call has everything it
 * needs, at no cost to this one.
 */
export const JEV_EDIT_GUARD_SURFACE: SurfaceAdapter = {
  id: "jev-edit-guard",
  flag: "post-tool",
  subsystem: "jev-edit-guard",
  sentinel: EDIT_GUARD_HOOK_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/commands/review-jev-edit-guard.ts"],
  settingsFile: (root) => `${root}/${EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH}`,
  relativePath: EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH,
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) => mergeIntoHookArray(s, "PostToolUse", editGuardPostToolUseGroup(), EDIT_GUARD_HOOK_SENTINEL),
  strip: (s) => stripFromHookArray(s, "PostToolUse", EDIT_GUARD_HOOK_SENTINEL),
  validate: validateEditGuardSurface,
};
