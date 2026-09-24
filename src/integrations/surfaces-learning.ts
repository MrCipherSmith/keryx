// Flow 312 (W3 self-learning loop), T11: the opt-in Claude Code learning
// observer surface. Registers `keryx learn observe --hook claude`
// (`src/commands/learn.ts`'s `runObserveHook`, backed by
// `src/learning/observe.ts`'s `observeHostHookPayload`) on every Claude Code
// hook event the W3 spec's "Hook event to observation event mapping" table
// names — PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit,
// SessionStart, Stop, SessionEnd — so the Extract stage sees the exact same
// observation-event vocabulary for a host-harness session as it does for a
// native `keryx shell` session (W6's `keryx.learning-observer` builtin hook,
// `src/harness/hooks/builtins.ts`).
//
// Confidence: "verified" — every one of the seven events, and the
// settings.json `hooks.<Event>: [{matcher?, hooks:[{type:"command",...}]}]`
// shape, are documented at https://code.claude.com/docs/en/hooks and
// https://code.claude.com/docs/en/agent-sdk/hooks (checked 2026-09-24), the
// same first-party basis `CTX_GUARD_CLAUDE`/`ORIENT_CLAUDE`/
// `SECURITY_CHECK_*_CLAUDE` (`surfaces.ts`) are rated `verified` on.
//
// Opt-in (`optIn: true`, plan D5): `keryx integrations install --runtime
// claude` with no `--surface` never installs this — only naming its flag
// (`--surface observe`) or its id (`--surface learning-observer`) does,
// exactly like the `agents` surfaces (`surfaces-agents.ts`). It shares
// `.claude/settings.json` with ctx-guard/orient/security through the same
// `SettingsFileOwner` (`registry.ts`'s `SETTINGS_FILE_OWNERS`), composing by
// sentinel the same way those three already coexist on `PreToolUse`/
// `UserPromptSubmit`: `mergeIntoHookArray`/`stripFromHookArray` only ever
// touch the group carrying THIS surface's own sentinel, so three (or four)
// surfaces sharing one hook key never clobber each other's entries.

import path from "node:path";
import {
  MANAGED_KEY,
  managedGroups,
  mergeIntoHookArray,
  stripFromHookArray,
} from "./settings-json";
import { SUBSYSTEM_LEARNING, type Settings, type SurfaceAdapter } from "./types";

export const LEARNING_OBSERVER_SENTINEL = "learning-observer-hooks";

/** The command every registered hook entry runs (plan D5). Always exits 0; never prints a decision. */
export function learningObserverCommand(): string {
  return "keryx learn observe --hook claude";
}

/**
 * The seven Claude Code hook events this surface registers on — byte-for-byte
 * the W3 spec's "Hook event to observation event mapping" table's left column
 * (`src/learning/observe.ts`'s `HOOK_EVENT_TO_OBSERVATION`, the same table
 * W6's `keryx.learning-observer` builtin hook registers on for a native
 * `keryx shell` session — `src/harness/hooks/builtins.ts`'s
 * `LEARNING_OBSERVER_EVENT_KIND`).
 */
export const LEARNING_OBSERVER_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SessionEnd",
] as const;

type LearningObserverEvent = (typeof LEARNING_OBSERVER_EVENTS)[number];

/** Tool-call events carry a `matcher`; the other four fire once per lifecycle point and take none (matching `ORIENT_CLAUDE`/`SECURITY_CHECK_INPUT_CLAUDE`'s no-matcher groups on non-tool events). */
const TOOL_EVENTS = new Set<LearningObserverEvent>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/** `"*"` matches every tool — this hook only observes, it never narrows to a subset of tools. */
const TOOL_MATCHER = "*";

/**
 * Seconds Claude Code allows this hook command to run before it kills it —
 * O-6: an unbounded hook is a stuck-observer risk (the command itself always
 * exits promptly under normal operation, via `readStdinBounded`'s own
 * deadline, but the host-side timeout is the outer bound that holds even if
 * that inner one is ever defeated).
 */
const HOOK_TIMEOUT_SECONDS = 5;

function learningObserverGroup(event: LearningObserverEvent): Settings {
  const hooksEntry = {
    hooks: [{ type: "command", command: learningObserverCommand(), timeout: HOOK_TIMEOUT_SECONDS }],
    [MANAGED_KEY]: LEARNING_OBSERVER_SENTINEL,
  };
  return TOOL_EVENTS.has(event) ? { matcher: TOOL_MATCHER, ...hooksEntry } : hooksEntry;
}

function learningObserverValidate(settings: Settings): string[] {
  const problems: string[] = [];
  for (const event of LEARNING_OBSERVER_EVENTS) {
    const present = managedGroups(settings, {
      sentinel: LEARNING_OBSERVER_SENTINEL,
      container: "hooks",
      key: event,
      shape: "nested",
      commandMatches: (c) => c === learningObserverCommand(),
    });
    if (present.length === 0) problems.push(`learning-observer: missing ${event} hook`);
  }
  return problems;
}

/**
 * Claude Code — https://code.claude.com/docs/en/hooks,
 * https://code.claude.com/docs/en/agent-sdk/hooks — VERIFIED: all seven
 * events below, and the settings.json group shape (`matcher?` +
 * `hooks:[{type:"command",command}]`) this surface writes, are confirmed in
 * first-party docs (checked 2026-09-24), including `PostToolUseFailure` —
 * documented alongside `PostToolUse` as a real, distinct hook event ("Tool
 * execution failure"), not a keryx invention.
 */
export const LEARNING_OBSERVER_CLAUDE: SurfaceAdapter = {
  id: "learning-observer",
  flag: "observe",
  subsystem: SUBSYSTEM_LEARNING,
  sentinel: LEARNING_OBSERVER_SENTINEL,
  confidence: "verified",
  optIn: true,
  riskNotes: [
    "Passive observation only: appends a redacted, 200-char-bounded-preview JSONL line per event under " +
      ".metaproject/data/learning/observations/ (gitignored) — never blocks, never returns a decision, always exits 0.",
  ],
  sourceDocs: [
    "https://code.claude.com/docs/en/hooks",
    "https://code.claude.com/docs/en/agent-sdk/hooks",
    "docs/requirements/keryx-agent-platform-expansion/workstreams/W3-self-learning.md",
    "src/learning/observe.ts",
  ],
  settingsFile: (root) => path.join(root, ".claude", "settings.json"),
  relativePath: ".claude/settings.json",
  // Same `hooks: object` / `_keryxManaged: array` / `unmigratedHooks: array`
  // slots every other `.claude/settings.json` surface declares (`surfaces.ts`)
  // — same types, so `assertRegistryCoherent` sees no collision; this surface
  // only ever ADDS its own sentinel-tagged group to each event's array, it
  // never owns a key any sibling surface doesn't already share.
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (settings) => {
    let next = settings;
    for (const event of LEARNING_OBSERVER_EVENTS) {
      next = mergeIntoHookArray(next, event, learningObserverGroup(event), LEARNING_OBSERVER_SENTINEL);
    }
    return next;
  },
  strip: (settings) => {
    let next = settings;
    for (const event of LEARNING_OBSERVER_EVENTS) {
      next = stripFromHookArray(next, event, LEARNING_OBSERVER_SENTINEL);
    }
    return next;
  },
  validate: learningObserverValidate,
  label: ".claude/settings.json (learning observer)",
  groupShape: "nested",
  // Deterministic single-key presence check for `installer.ts`'s
  // `wasSurfaceInstalled` fallback (used only when `validate` reports a
  // partial/stale install, not a clean one): `PreToolUse` is always written
  // first by `merge` above and is never shared ambiguously with another
  // surface's OWN sentinel, so a managed group there unambiguously means
  // "this surface was installed", independent of the other six events'
  // state.
  groupKey: "PreToolUse",
  groupContainer: "hooks",
};
