# Implementation Plan

Status: approved (autonomous run; decisions recorded in journal.md)

## Approach

A new core module `src/harness/hooks/` owns the whole hook runtime. It is pure
wherever it can be (types, config merge, codec, failure semantics, composition),
and has exactly two side-effecting ports: a `HookProcessRunner` (spawns one hook
command) and the config reader (fs). Everything that consumes it takes an
OPTIONAL `hooks` dependency so a caller that does not pass one is byte-identical
to today (run.ts is deterministic/offline by contract; the replay suite binds to
its hashes).

### Module layout (src/harness/hooks/)

- `types.ts` — `HookEventName` (10), `HookClass`, `HookRegistration` (resolved:
  id, event, matcher, class, command|builtinHandler, timeoutMs, runsIn, network,
  appliesToChildAgents, profiles, enabled, scope: builtin|user|project, order),
  payload types per event, `HookOutcome`, `HookInvocationRecord`,
  `HookAnomaly`/warning names (`hook-timeout`, `hook-crashed`, `hook-malformed-output`,
  `hook-advisory-failed`, `hook-observer-failed`, `hook-context-failed`,
  `hook-decision-ignored`, `hook-attempted-input-rewrite`,
  `hook-context-truncated`, `hook-sandbox-unavailable`).
- `hook-config.schema.json` — byte-identical runtime copy of the docs schema
  (a test asserts equality).
- `config.ts` — `loadHookConfig({projectRoot, homeDir, readFile})`: read both
  files (absent = empty), validate with the repo's JSON-schema validator, reject
  full registrations whose id collides with a built-in
  (`hook-id-collides-with-builtin`), refuse unknown major `schemaVersion`,
  merge built-in → user → project (file order), apply disable-only overrides by
  id, return `{registrations, diagnostics}`. Invalid config = fail closed for the
  runtime (the loader returns errors; the caller refuses to start hooks rather
  than silently dropping them — recorded as a diagnostic, and `keryx hooks
  validate` reports it).
- `builtins.ts` — the five built-in declarations (fixed order) plus the two
  extension ports: `LearningObservationSink` (W3; default no-op) and
  `ImpactEvidenceProvider` (W8; default returns no context). ctx-guard and the
  two security built-ins are spawned commands (`keryx ctx hook claude`,
  `keryx security check-input --source untrusted-external --runtime claude`,
  `keryx security check-output --runtime claude`), resolved to the running keryx
  binary; the two stubs run in-process through their ports (built-in only —
  user/project hooks are always spawned commands).
- `codec.ts` — build the stdin payload (W6 camelCase fields + `schemaVersion`,
  `timestamp`, `hookId` + Claude-Code snake_case aliases `hook_event_name`,
  `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `prompt`) and
  parse the result: exit 0 → stdout JSON (`decision`, `additionalContext`,
  `reason`; also Claude `hookSpecificOutput.permissionDecision` /
  `.additionalContext` and legacy `decision:"block"`→deny,
  `decision:"approve"`→allow); empty stdout = silent approve; exit 2 = deny with
  stderr reason; other = crash. `updatedInput` dropped + anomaly.
  `additionalContext` capped (bound from `src/harness/context/manifest.ts`) with
  `hook-context-truncated`.
- `semantics.ts` — pure failure table: `(class, event, failure, profileId,
  decideOutcome) → effect` exactly as the W6 table.
- `compose.ts` — pure `composeDecision(policyDecision, hookResults, {interactive})`:
  hard deny untouched; any hook deny → deny; any hook ask → at least ask; never
  loosens; headless ask→deny applied after composition; returns a new
  `PolicyDecision` whose `matchedRules` records `hook:<id>:<outcome>`.
- `runner.ts` — `HookProcessRunner` port + `createRealHookRunner()` (async
  `child_process.spawn`, argv only, stdin write+close, stdout/stderr capture
  capped, SIGKILL on timeout, env = allowlist + `command.env`, cwd confined to the
  project root, argv wrapped via `wrapWithSandbox` + `detectSandboxLauncher` with
  a `network: "off"` profile unless `restricted`; sandbox unavailable ⇒
  spawn failure (fail-closed classification), `runsIn: unsandboxed` refused when
  the profile's `requiredControls.isolation` is `required-fail-closed`).
- `runtime.ts` — `createHookRuntime({registrations, runner, clock, profile,
  interactive, sessionId, runId, projectRoot, ports})` with
  `fire(event, payload, {decideOutcome?, toolName?})` → `{decision?, contexts,
  records, warnings, anomalies}`: filters by event/matcher/profile/enabled, runs
  gate + gate-advisory sequentially (first deny short-circuits the decision but
  already-started ones finish), observe/context in parallel, never awaits an
  observe hook past its own timeout. `inheritedHookIds()` for subagents.
- `index.ts` — public surface.

### Integration points

1. `src/harness/run/run.ts` — `RunDeps.hooks?: HookRuntime`. SessionStart after
   startup `started`; UserPromptSubmit before the provider stream (deny → run ends
   blocked, context appended to the first user message); PreToolUse before
   `decide()` and composition after it (and after MP-6); PostToolUse /
   PostToolUseFailure after execution; Stop at `model_end`; SessionEnd at the end.
   `hook_invocation` session entries (new `type` in the artifactRef branch of
   `SessionEntryPayload` and in `session-entry.schema.json`), correlationId = the
   tool call id or the event id.
2. Subagents — external path in `spawn-subagent-tool.ts` around `deps.runExternal`
   and the internal path through a new async `spawnChildWithHooks()` in
   `src/harness/child/` wrapping the sync `spawnChild()` (SubagentStart deny ⇒
   `{ok:false}`; SubagentStop when the result resolves); inheritedHookIds from
   `appliesToChildAgents`.
3. `src/commands/agent.ts` (`keryx shell`'s real loop) — `AgentDeps.hooks?`:
   PreToolUse in `executeCall` after schema validation and the unattended floor:
   hook deny ⇒ refused result; hook ask ⇒ force `requestApproval` (never `auto`,
   never saved allowlist); allow ⇒ unchanged path. UserPromptSubmit per turn,
   PostToolUse/Failure, Stop at turn end. `interactive = !deps.unattended`.
4. Production wiring: `keryx shell` (shell.ts / tui-shell.ts builder),
   trigger/schedule agent deps (interactive false), `keryx harness run` /
   serve-turn deps; PreCompact at the shell compaction entry point.
5. CLI `src/commands/hooks.ts` + registration in `src/cli.ts` + help:
   `list [--json]`, `test <id> [--event] [--payload-file] [--json]`,
   `validate [--json] [--ci]`, `enable|disable <id> [--user]`.

### Decisions

- D1 Hooks integrate through optional deps; absent = byte-identical (replay safety).
- D2 The existing `ProcessAdapter` is sync (`spawnSync`) and has no stdin/stdout
  channel, so hooks reuse the sandbox layer at the `wrapWithSandbox` +
  `detectSandboxLauncher` level (the same wrap the adapter applies) inside an
  async runner. No new sandbox.
- D3 Stdin carries both the W6 camelCase fields and Claude-Code snake_case
  aliases, and stdout accepts both shapes, so the Claude-format built-in commands
  and third-party Claude hooks run unmodified.
- D4 Stub built-ins run in-process through ports (the only in-process hooks; not
  configurable by users) so W3/W8 plug in without a process boundary.
- D5 Env allowlist: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` (inherited
  values), plus `KERYX_HOOK_EVENT`, `KERYX_HOOK_ID`, `KERYX_SESSION_ID`,
  `KERYX_RUN_ID`, `KERYX_PROJECT_ROOT`, `KERYX_POLICY_PROFILE`,
  `CLAUDE_PROJECT_DIR` (= project root), then `command.env`. Nothing else.
- D6 PR shape: one PR if the diff stays reviewable, else runtime+run.ts first and
  built-ins+CLI+shell wiring stacked on it.

## Steps

See tasks.md (T5–T14).

## Risks

- Composition is security-sensitive: guard tests with property-style sweeps over
  every (decide outcome × hook outcome × class × profile) combination.
- run.ts determinism: hooks absent ⇒ unchanged hashes; hooks present use only the
  injected clock/idSeq in records.
- agent.ts is large and heavily tested; PreToolUse wiring must not change any
  existing approval path when hooks are absent.
- Spawning `keryx` per Bash call costs latency; acceptable in v1 (spec), noted.
