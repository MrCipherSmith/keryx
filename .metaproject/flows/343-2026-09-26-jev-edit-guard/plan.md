# Implementation Plan

Status: implemented

## Approach

Reuse, not reinvent: `review jev-rules`'s `computeJevRulesResult`
(`src/commands/review-jev-rules.ts`) already does discovery, clause tagging
with a cache, pair selection bounded by a call cap, batching, and
threshold-based finding synthesis. The edit guard is a thin adapter around
it — diff one file's changed region against `HEAD`, hand the resulting
region(s) to `computeJevRulesResult`, and turn the findings into hook
feedback text. Added `signal?: AbortSignal` to `JevRulesRunOptions`
(threaded to every `callJevSystemOne` call) so the hook's own wall-clock
timeout can actually abort an in-flight Jev call rather than merely give up
waiting on it.

The Claude Code hook shape (`hookSpecificOutput.additionalContext`, stdin
JSON, root anchored on `CLAUDE_PROJECT_DIR`) mirrors
`src/commands/security-impact-evidence.ts`'s own `PreToolUse` hook exactly.
The merge-safe settings.json install reuses the SAME primitives
`src/integrations/settings-json.ts` gives every other surface
(`mergeIntoHookArray`/`stripFromHookArray`/`managedGroups`) through a new,
standalone `SurfaceAdapter` (`src/integrations/jev-edit-guard-surface.ts`,
exported via `service.ts`) rather than a second hand-rolled JSON editor —
and rather than joining the full `HARNESS_ADAPTERS` W5 registry, which is
scoped to cross-harness capabilities this single-runtime feature is not.

The TUI `/editguard` modal mirrors `turn-guard-inspector.ts`'s `/guard`
modal shape (`openModal`, a `TextRenderable` body, its own keypress
handler) but reads/writes the PROJECT's `tasks.config.json` (async) instead
of session memory (sync) — closer to the async-then-open shape `/bus`
already uses.

## Steps

1. Core: `src/review/jev-edit-guard.ts` (constants, hook-payload parsing,
   feedback rendering), `jev-edit-guard-config.ts` (opt-in/threshold/
   max-calls read + write), `jev-edit-guard-log.ts` (JSONL append/read/
   stats).
2. Additive: thread `signal` through `review-jev-rules.ts`'s
   `JevRulesRunOptions` and its two `callJevSystemOne` call sites.
3. Adapter: `src/integrations/jev-edit-guard-surface.ts` (standalone
   `SurfaceAdapter`) + its `service.ts` export; `src/commands/review-jev-
   edit-guard.ts` (the hook, install/uninstall/status, `--fixtures`).
4. Registration: `src/commands/review.ts` (`jev-edit-guard` subcommand).
5. TUI: `src/tui/jev-edit-guard-inspector.ts` (modal), sidebar row + `/route`-
   shaped toggle wiring in `tui-shell.ts`, `AGENT_SLASH_COMMANDS`/
   `HELP_GROUPS` entries, regenerated `commands-by-task.md`.
6. Tests for every new module + the CLI hook (flagged/silent/error/timeout/
   threshold/installer-idempotent/credential-via-env/no-network) + the TUI's
   pure formatting functions; fixed the 4 pinned `agent-commands.test.ts`
   command lists the new `/editguard` entry shifted.
7. Docs: README section, `cli-reference.md` section, `CHANGELOG.md`
   `[Unreleased]`.
8. Manual end-to-end proof: real `keryx` CLI binary, a real git repo, a real
   rule file, `--fixtures` (no network), piped a real `PostToolUse` JSON —
   flagged, silent, install, uninstall, status all verified.

## Risks

- **Cache reuse across probability changes**: `review-jev-rules.ts`'s
  violation cache keys on (rule, clause, region, clause text) — NOT on
  threshold — so a manual re-run with the SAME hunk but a different fixture
  probability must clear `.metaproject/data/review-jev-rules/` first (a real
  agent session never hits this: the file content changes on every real
  edit).
- **Tagging vs. violation call keys differ**: the tagging call
  (`buildClauseTagQuestions`) answers by bare `clause_id`; the violation
  call (`ruleQuestionKey`) answers by `<ruleId>::<clauseId>`. A fixture that
  conflates them silently produces zero candidates rather than erroring —
  caught once, during the manual proof, documented in the CLI's own test
  file and the fixture's inline comment.
