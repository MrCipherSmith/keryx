# Lifecycle hooks

`keryx shell`'s own agent loop fires ten named lifecycle events — `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PreCompact`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd` — that a
project or a person can hook into with an external command, registered in a
config file. A hook is a spawned process: it reads one JSON payload on stdin,
and its exit code plus stdout tell Keryx whether to allow, ask about, or deny
whatever is happening, and optionally add context for the model.

Hooks never replace the policy engine (`keryx.*`'s `decide()`,
[architecture.md](./architecture.md)). They can only **tighten** its
allow/ask/deny outcome — turn an `allow` into `ask` or `deny`, or an `ask`
into `deny` — never loosen it, and never override a hard deny.

The field names and the stdin/exit-code/stdout shape intentionally mirror the
public Claude Code hooks convention, so a hook command you already have for a
Claude Code-shaped host runs unmodified under `keryx shell` too.

Source: `src/harness/hooks/` (the runtime), `src/commands/hooks.ts` (the
CLI), `src/commands/agent-hooks.ts` (production wiring into `keryx shell`).
Design doc:
[W6-shell-hooks.md](../requirements/keryx-agent-platform-expansion/workstreams/W6-shell-hooks.md).
Schema:
[hook-config.schema.json](../requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json).

## The ten events

| Event | Fires | Can it change the outcome? |
|---|---|---|
| `SessionStart` | After startup completes, before the first turn | No — may only add `additionalContext`. |
| `UserPromptSubmit` | Per submitted prompt, before it reaches the model | Yes — gate-capable. |
| `PreToolUse` | Per resolved tool call | Yes — gate-capable (`allow`/`ask`/`deny` + context). |
| `PostToolUse` | Per successfully executed tool call | No — observe-only. |
| `PostToolUseFailure` | Per tool call whose execution errored | No — observe-only. |
| `PreCompact` | Before session context is compacted | No — may add context; cannot block compaction. |
| `Stop` | Turn end (agent loop about to yield control) | Yes — gate-capable. |
| `SubagentStart` | Before a subagent (external or internal) is spawned | Yes — gate-capable; may deny the spawn. |
| `SubagentStop` | Once a subagent's result resolves | No — observe-only. |
| `SessionEnd` | Session teardown (normal/abort/error) | No — observe-only. |

Only four events are **gate-capable** — able to change the composed outcome
at all — regardless of a hook's own `class`: `PreToolUse`, `UserPromptSubmit`,
`Stop`, `SubagentStart` (`GATE_CAPABLE_EVENTS` in `src/harness/hooks/types.ts`).
A `decision` returned on any other event is dropped and recorded as the
`hook-decision-ignored` anomaly.

Only three events are **per-tool**: `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`. Their `matcher` is a regex tested against the tool
name; every other event's `matcher` must be `"*"`.

### Payload fields

Every payload carries the shared base fields, plus event-specific fields.
Each payload is shaped by `buildHookStdin` (`src/harness/hooks/codec.ts`)
into **both** a camelCase field and, where the Claude Code convention has an
equivalent, a snake_case alias — so one hook command works against either
naming convention unmodified.

Base fields, every event: `schemaVersion`, `timestamp`, `hookId`, `event`,
`sessionId`, `runId` — aliased as `hook_event_name` (the event name) and
`session_id`. `cwd` (the project root) is aliased in whenever it is known to
the caller.

| Event | camelCase fields | snake_case aliases also sent |
|---|---|---|
| `SessionStart` | `projectRoot`, `policyProfile`, `contextHash?`, `provider?`, `model?` | `cwd` |
| `UserPromptSubmit` | `prompt` | `prompt` |
| `PreToolUse` | `toolCallId`, `toolName`, `toolInput`, `risk?`, `policyProfile` | `tool_name`, `tool_input` |
| `PostToolUse` | `toolCallId`, `toolName`, `toolInput`, `toolOutput`, `policyDecision?` | `tool_name`, `tool_input`, `tool_response` |
| `PostToolUseFailure` | `toolCallId`, `toolName`, `toolInput`, `error: {message, code?}` | `tool_name`, `tool_input` |
| `PreCompact` | `reason: "auto"\|"manual"`, `tokenCount?` | — |
| `Stop` | `stopReason?` | — |
| `SubagentStart` | `subagentId`, `parentSessionId`, `spawnKind: "external"\|"internal"`, `inheritedHookIds` | — |
| `SubagentStop` | `subagentId`, `outcome`, `escalationStop?` | — |
| `SessionEnd` | `endReason` | — |

No payload field is ever read back from a hook as authoritative — only the
`decision`/`additionalContext`/`reason` fields described below are trusted.

## Config files and precedence

Three layers, lowest to highest precedence, concatenated in this order (file
order within each layer):

1. **Built-in** — compiled into `keryx shell`, ids namespaced `keryx.<name>`
   so a project/user id can never collide with one.
2. **User scope** — `~/.keryx/hooks.json`, applies across every project.
3. **Project scope** — `.metaproject/hooks.json`, same schema,
   version-controlled, highest precedence.

Ties within one event are broken by `id` (`localeCompare`).

A project/user `id` that collides with a built-in's namespaced id is
rejected at load time (`hook-id-collides-with-builtin`), never silently
shadowed. A project may still **disable** an inherited (including built-in)
hook with a disable-only override: `{"id": "keryx.ctx-guard", "enabled": false}`
— exactly those two keys, nothing else. Adding any other field to an entry
whose `id` starts with `keryx.` fails schema validation, and so does a full
registration (with `matcher`/`command`/`class`) whose `id` starts with
`keryx.` — these are the schema's two distinguishable shapes, so "disable a
built-in" and "collide with a built-in" can never be confused with each
other.

An absent config file is treated as empty (no diagnostic). Anything else
wrong with a present file — invalid JSON, schema-invalid, an unrecognised
major `schemaVersion`, a built-in id collision, or a duplicate
full-registration id within one event — is a load error, and the whole load
reports `ok: false`. **Nothing is silently dropped or partially applied.**

## Schema

Both files validate against
[hook-config.schema.json](../requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json)
(the runtime keeps a byte-identical copy at `src/harness/hooks/hook-config.schema.json`,
checked for equality by test). Top level: `{"schemaVersion": "1.0.0", "hooks": {<event>: [...]}}`,
plus an optional `_keryxManaged` sentinel block Keryx itself writes (see
below). Every registration entry is one of:

- **A full registration**: `id` (pattern `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`,
  no `keryx.` prefix), `matcher` (default `"*"`), `command: {argv, cwd?,
  env?}`, `class` (`gate` | `gate-advisory` | `observe` | `context`),
  `timeoutMs` (1–60000, default 5000), `runsIn` (`sandbox` default |
  `unsandboxed`), `network` (`none` default | `restricted`),
  `appliesToChildAgents` (default `true`), `profiles` (omitted/empty = all
  three profiles), `enabled` (default `true`), `description?`.
- **A disable-only override**: `{"id": "keryx.<name>", "enabled": false}`
  exactly.

`argv` is never shell-interpolated — it is spawned directly, closing the
command-injection-via-interpolation class.

## Classes and failure semantics

| Class | Can it change the outcome? | On timeout / crash / malformed output |
|---|---|---|
| `gate` (only on gate-capable events) | Yes | **Fail closed in every profile.** Timeout → `deny` (`hook-timeout`). Crash (non-zero exit, not 2) → `deny` (`hook-crashed`). Malformed stdout on exit 0 → silent-approve **unless** the outcome it was gating was already `ask`, in which case it denies too (`hook-malformed-output`) — a broken hook must never be the thing that turns an `ask` into an approval. |
| `gate-advisory` (only `keryx.impact-evidence` today) | Yes, same tightening power as `gate` when it runs cleanly | **Profile-aware.** `read-only-review` / `monitored-trusted-local`: fail **open** with a `hook-advisory-failed` warning — the lifecycle proceeds without the hook's tightening/context. `unattended-untrusted`: fail **closed**, `deny` (`hook-advisory-failed`). |
| `observe` | No | Always fail open with a `hook-observer-failed` warning, in every profile. |
| `context` | No (may only add `additionalContext`) | Always fail open with a `hook-context-failed` warning. |

`SessionStart` is an event-level override on top of that table: **any**
class registered on it always proceeds with a warning on failure, never
denies — nothing on `SessionStart` is gate-capable, so a hook there cannot
change the outcome even when it runs cleanly, and its failure cannot regress
enforcement either (`src/harness/hooks/semantics.ts`).

`gate` fails closed and `observe`/`context` fail open in every profile
because those two classes can never change a decision — tying loop
availability to their failure would be a category error. `gate-advisory`
sits in between: it can tighten a decision when it runs, but a project may
want it to degrade gracefully rather than block every matching call, except
when unattended (matching W8's requirement that an unattended run never
silently loses impact-evidence enforcement).

## Composition with the policy engine

```
tool call → decide() (hard-deny → flow-file guard → baseline → approval →
                       headless fail-closed → ask)
          → PreToolUse hooks fire, with decide()'s outcome known to them
          → composeDecision(policyDecision, hookDecisions, {interactive})
          → final PolicyDecision gates execution
```

- **A `decide()` hard deny (or any `deny`) is untouchable.** `composeDecision`
  (`src/harness/hooks/compose.ts`) returns the policy decision unchanged
  without even looking at hook decisions once `decide()` has already denied.
- **Any hook `deny` wins** over an `allow`/`ask` policy decision.
- **Any hook `ask` tightens `allow` to `ask`.** It is a no-op if the policy
  decision is already `ask`.
- A hook `allow` never loosens anything and by itself changes nothing.
- **Headless fail-closed runs after composition**: a hook tightening to
  `ask` under `interactive: false` still resolves to `deny`
  (`matchedRules` records `headless-fail-closed` alongside the hook's own
  entry), matching the policy engine's own `ask`→`deny` rule for
  non-interactive runs.
- **Multiple gate hooks on one event run sequentially, in the deterministic
  merge order** (built-in → user → project, ties by `id`); the first `deny`
  short-circuits the remaining hooks for that event — but each hook that did
  run finished within its own timeout, so no `additionalContext` it already
  produced is discarded.
- The non-tool gate-capable events (`UserPromptSubmit`/`Stop`/
  `SubagentStart`, which have no `PolicyDecision` of their own) use the same
  tighten-only rule against an implicit `allow` baseline, via
  `tightenOutcome`.

### Where `PreToolUse` actually fires, relative to `decide()`

The design doc's pipeline diagram reads "hooks before `decide()`". The
production wiring in `src/harness/run/run.ts` instead runs `decide()` (and
the optional MP-6 blast-radius escalation) **first**, then fires
`PreToolUse` with `decide()`'s outcome passed in as `ctx.decideOutcome`,
*then* composes. This is deliberate, not a spec violation: `decide()` is pure
and a hook cannot influence its inputs (the hook payload carries the same
`toolCallId`/`toolName`/`toolInput`/`risk`/`policyProfile` either way), so
the only point a hook's decision and the policy decision actually meet is
`composeDecision`, which runs after both are known regardless of firing
order. Running `decide()` first is what makes the gate malformed-output
asymmetry above implementable at all — the malformed-stdout-on-`ask` rule
needs to know what `decide()` said, which does not exist yet if the hook ran
first.

## stdout / exit-code contract

- **stdin**: one JSON payload, written once, then the stream is closed.
- **exit 0**: stdout is parsed as optional JSON.
  - Empty or whitespace-only stdout is a **silent approve** — no decision, no
    anomaly.
  - Otherwise stdout must be a JSON object: `{"decision": "allow"|"ask"|"deny",
    "additionalContext": "...", "reason": "..."}`. The Claude Code shape is
    also accepted: `hookSpecificOutput.permissionDecision` (also
    `"approve"`→`allow` and `"block"`→`deny` legacy aliases),
    `hookSpecificOutput.additionalContext`,
    `hookSpecificOutput.permissionDecisionReason`. Anything that is not valid
    JSON, or is JSON but not an object, or has an unrecognised `decision`
    string, is a **malformed** failure (see the failure-semantics table).
- **exit 2**: an explicit `deny`, with trimmed/capped stderr as the `reason`.
- **Any other non-zero exit, a timeout, or a spawn failure**: a **crash**-class
  failure.
- **`decision` is honored only for `gate`/`gate-advisory` hooks on
  gate-capable events.** A `decision` from any other combination is dropped
  and recorded as the `hook-decision-ignored` anomaly — it never reaches
  composition.
- **`additionalContext` is capped** at 1% of the harness's whole-session
  context ceiling (`MAX_CONTEXT_BYTES` in `src/harness/context/manifest.ts`,
  so ~20 KiB) so one hook cannot consume the whole budget; an overflow is
  truncated with the `hook-context-truncated` anomaly. `reason`/stderr-as-
  reason is capped separately at 4000 bytes.
- **No input rewriting.** `updatedInput` (native or
  `hookSpecificOutput.updatedInput`) is accepted for forward-compatible
  parsing and then dropped — it never reaches the executor. Its mere
  presence is recorded once as the `hook-attempted-input-rewrite` anomaly.
  This is deliberate (see the design doc's non-goals): letting a hook
  silently substitute what a tool actually does, while the transcript still
  shows the model's original call, is the highest-leverage vector for a
  buggy or compromised hook to do quiet damage.

## Execution

- **Sandboxed by default** (`runsIn: "sandbox"`): every hook is spawned
  through the same OS sandbox layer that wraps every other process Keryx
  runs (`wrapWithSandbox` + `detectSandboxLauncher`,
  `src/harness/process/sandbox/`). If the sandbox launcher is unavailable,
  the hook invocation fails closed as `sandbox-unavailable` (classified like
  a crash) — it never silently falls back to running unsandboxed.
  `runsIn: "unsandboxed"` is refused outright (`spawnError: "refused"`)
  whenever the active security profile's isolation is
  `required-fail-closed`.
- **Built-in command hooks run unsandboxed off `required-fail-closed`**
  (flow 306, W6, T15): `keryx.ctx-guard`, `keryx.security-check-input` and
  `keryx.security-check-output` spawn the running `keryx` binary itself —
  the same trust domain and containment as the Keryx process that spawns
  them, not an untrusted third-party command, so wrapping them in the OS
  sandbox adds no containment while making them load-bearing on a launcher
  (`bwrap`/`sandbox-exec`) that is frequently unavailable. A Linux user
  without bubblewrap would otherwise see EVERY prompt denied by
  `keryx.security-check-input`'s fail-closed sandbox-unavailable path — a
  usability regression, not a security gain. So `resolveBuiltinCommandRunsIn`
  (`src/harness/hooks/runtime.ts`) resolves these three to `runsIn:
  "unsandboxed"` for whichever profile is active on THIS fire, whenever that
  profile's `requiredControls.isolation` is not `required-fail-closed`
  (`read-only-review` and `monitored-trusted-local` today —
  `src/harness/policy/profiles.ts`). Under `unattended-untrusted`
  (`required-fail-closed`), they stay `sandbox` and fail closed exactly as
  before. A user/project hook's own `runsIn` is never touched by this —
  it only ever widens a `scope: "builtin"` + `handler.kind: "command"`
  registration, and stays `sandbox` by default with the same
  sandbox-unavailable fail-closed path (named `hook-sandbox-unavailable`) it
  always had. `keryx hooks list`/`keryx hooks test` (optionally with
  `--profile <id>`) report the EFFECTIVE `runsIn` for the profile in play,
  not just the registration's own default.
- **No network by default** (`network: "none"`); `network: "restricted"`
  routes through the sandbox's existing proxy allowlist. Never `full`.
- **Env allowlist** (`buildHookEnv` in `src/harness/hooks/runner.ts`) — the
  exact, fixed set that reaches a hook process, nothing else:
  - Inherited from the real process environment, only if already set:
    `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`.
  - Always set by the runner: `KERYX_HOOK_EVENT`, `KERYX_HOOK_ID`,
    `KERYX_SESSION_ID`, `KERYX_RUN_ID`, `KERYX_PROJECT_ROOT`,
    `KERYX_POLICY_PROFILE`, `CLAUDE_PROJECT_DIR` (= the project root, for
    Claude-Code-shaped hook commands).
  - Then the registration's own `command.env` entries, applied last (so
    they can override the above).

  Anything else sitting in the ambient shell environment — a secret not on
  this list and not explicitly in `command.env` — is stripped before the
  hook process ever starts, not merely left unset.
- **Timeouts**: per-registration `timeoutMs`, default 5000ms, clamped to
  [1ms, 60000ms]. A hook that exceeds it is SIGKILLed (its whole process
  group on POSIX) and classified as a `timeout` failure.
- **Ordering**: deterministic — built-in → user → project, file order within
  each, ties by `id` — never wall-clock, so a hook run replays the same way
  `decide()` does.
- **Parallelism**: `gate`/`gate-advisory` hooks on one event run
  **sequentially** (a `deny` short-circuits the rest for that event);
  `observe`/`context` hooks run **in parallel**, each raced against its own
  timeout, so `fire()` never waits longer than the slowest one's own budget.

## Built-ins

Five built-in hooks, fixed order, `keryx.`-namespaced ids, all enabled by
default. A project can only disable one by id (`{id, enabled: false}`),
never redefine it.

| id | event(s) | matcher | class | What it does |
|---|---|---|---|---|
| `keryx.ctx-guard` | `PreToolUse` | `Bash` | `gate` | Routes Bash tool calls through the gdctx routing guard (spawns `keryx ctx hook claude`). |
| `keryx.security-check-input` | `UserPromptSubmit` | `*` | `gate` | Scans a submitted prompt for injection/secret patterns before it reaches the model (`keryx security check-input --source untrusted-external --runtime claude`). |
| `keryx.security-check-output` | `PreToolUse` | `Write\|Edit` | `gate` | Scans a Write/Edit's content before it executes (`keryx security check-output --runtime claude`). |
| `keryx.learning-observer` | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SessionEnd` (exactly these seven) | `*` | `observe` | Appends a redacted, bounded observation record for W3's Observe stage — see [Extension points](#extension-points-for-w3-and-w8) below. In-process, not a spawned command. |
| `keryx.impact-evidence` | `PreToolUse` | `Write\|Edit` | `gate-advisory` | On a session's first edit of a file, injects impact evidence (importers, related tests, memory caveats) — see [Extension points](#extension-points-for-w3-and-w8) below. In-process, not a spawned command. |

`keryx.learning-observer` and `keryx.impact-evidence` are the only two
built-ins whose handler is `{kind: "builtin", name: ...}` rather than a
spawned command — they run in-process through an injectable port so W3/W8
can plug in without a process boundary. That handler kind is never available
to a user/project registration; only these two fixed declarations use it.

`keryx.ctx-guard`'s matcher is `Bash` only, not `Bash|Grep` like the guard
installed into host harnesses — `keryx shell`'s own builtin tool set has no
separate `Grep`-named tool for a shell command to route through, so `Bash`
alone covers everything that needs it here.

## Child-agent inheritance

A spawned Keryx subagent never inherits a host harness's ambient hooks, and
does not implicitly inherit its parent's full merged set either — it
inherits exactly the ids whose `appliesToChildAgents` is `true` (the
schema's default). `HookRuntime.inheritedHookIds()` computes this list (one
entry per distinct id, in registration order), and it is recorded verbatim
in `SubagentStart`'s `inheritedHookIds` payload field for both spawn paths
(`spawnKind: "external"` via `spawn-subagent-tool.ts`'s `deps.runExternal`,
and `spawnKind: "internal"` via `spawnChild()`). Set
`appliesToChildAgents: false` on an expensive or parent-only hook (e.g. a
heavy observe-only evidence hook) to keep it out of every subagent's set
while still running it for the top-level session.

## `KERYX_HOOKS=off`

Set the environment variable `KERYX_HOOKS=off` to disable the hook runtime
entirely for a session — `buildShellHookRuntime` (`src/commands/agent-hooks.ts`)
then returns `undefined`, byte-identical to `AgentDeps.hooks` never having
been wired in at all. No config file is read, no hook ever fires.

## Invalid config: fails closed, not silently disabled

If either config file fails to load — invalid JSON, schema-invalid, an
unrecognised `schemaVersion`, an id collision, or a duplicate id —
`buildShellHookRuntime` does **not** fall back to "hooks disabled". Instead
it builds a runtime whose every gate-capable event (`PreToolUse`/
`UserPromptSubmit`/`Stop`/`SubagentStart`) unconditionally denies, with
reason `hook-config-invalid`, until the config is fixed. The idea: a
broken or tampered project file must never silently weaken enforcement down
to nothing — every gate a hook *could* have covered instead fails closed.
The load diagnostics themselves are surfaced by the caller (a startup
warning, or `keryx hooks validate`), not swallowed.

## The `keryx hooks` CLI

```
keryx hooks list [--json]
keryx hooks validate [--json] [--ci]
keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]
keryx hooks enable <id> [--user]
keryx hooks disable <id> [--user]
```

- **`keryx hooks list`** — the merged, resolved registration set. With no
  config files present, exactly the five built-ins, all enabled.

  ```
  $ keryx hooks list
  keryx.ctx-guard
    scope=builtin class=gate enabled=true appliesToChildAgents=true
    events=PreToolUse matcher=Bash timeoutMs=5000
    command: keryx ctx hook claude
  ...
  ```

- **`keryx hooks validate`** — checks both files against the schema, rejects
  an id colliding with a built-in, and best-effort (no execution) checks
  that each command's `argv[0]` resolves — an unresolved `argv[0]` is always
  a warning, never a load failure. `--ci` is accepted for pipelines that
  want a stable invocation; it changes no exit-code or validation behavior
  beyond what `--json` already gives.
- **`keryx hooks test <id>`** — runs one hook once through the real runner
  (or, for the two built-ins, through the in-process port) against a
  synthetic payload for its event, or a `--payload-file` JSON document you
  supply. Reports the decision, exit code, stdout/stderr (capped, truncation
  flagged), duration, and — on a failure — what effect that failure would
  have under `--profile` (default `monitored-trusted-local`).
- **`keryx hooks enable <id>` / `keryx hooks disable <id>`** — flip a
  registration's `enabled` state in `.metaproject/hooks.json` by default, or
  `~/.keryx/hooks.json` with `--user`. For a built-in, this writes a
  disable-only override entry; the file's `_keryxManaged.managedHookIds`
  tracks exactly which ids Keryx itself added, so `keryx hooks enable`
  refuses to touch an override it does not recognise as Keryx-managed (it
  looks hand-authored — remove it by hand if that is what you want).

## Worked example: a project hook

`.metaproject/hooks.json` — deny any Bash command containing `rm -rf /`,
and log every successful edit:

```json
{
  "schemaVersion": "1.0.0",
  "hooks": {
    "PreToolUse": [
      {
        "id": "no-rm-rf-root",
        "matcher": "Bash",
        "class": "gate",
        "command": { "argv": ["./scripts/hooks/no-rm-rf-root.sh"] },
        "timeoutMs": 3000,
        "description": "Denies any Bash call whose command contains `rm -rf /`."
      }
    ],
    "PostToolUse": [
      {
        "id": "edit-log",
        "matcher": "Write|Edit",
        "class": "observe",
        "command": { "argv": ["./scripts/hooks/edit-log.sh"] },
        "appliesToChildAgents": false
      }
    ],
    "keryx.security-check-output": [
    ]
  }
}
```

(The trailing empty `"keryx.security-check-output": []` block above is
invalid and shown only as a reminder: a built-in is never redefined this
way — disable it with `{"id": "keryx.security-check-output", "enabled":
false}` under its own event key instead, if you ever need to turn it off.)

`no-rm-rf-root.sh` reads the `PreToolUse` payload from stdin and exits `2`
with a reason on stderr to deny:

```sh
#!/usr/bin/env sh
payload="$(cat)"
command="$(printf '%s' "$payload" | jq -r '.toolInput.command // empty')"
case "$command" in
  *"rm -rf /"*)
    echo "refusing a Bash command containing rm -rf /" >&2
    exit 2
    ;;
esac
exit 0
```

Try it standalone before it ever gates a real session:

```
keryx hooks validate
keryx hooks test no-rm-rf-root --event PreToolUse
```

## Extension points for W3 and W8

Two built-ins are deliberately stubs: they run in-process, through a small
injectable port, so the workstreams that own their real behavior (W3's
Observe stage, W8's impact-evidence enforcement) can plug in without adding
a process boundary. Both ports live in `src/harness/hooks/builtins.ts` and
default to a no-op.

### `LearningObservationSink` (W3)

```ts
export interface LearningObservation {
  kind: "tool-start" | "tool-complete" | "tool-failed" | "user-prompt"
      | "session-start" | "turn-stop" | "session-end";
  sessionId: string;
  runId: string;
  timestamp: string;
  payload: unknown;
}

export interface LearningObservationSink {
  record(observation: LearningObservation): Promise<void> | void;
}
```

`keryx.learning-observer` is registered on exactly seven events, mapped to
`LearningObservation.kind` via `LEARNING_OBSERVER_EVENT_KIND`:

| Event | `kind` |
|---|---|
| `PreToolUse` | `tool-start` |
| `PostToolUse` | `tool-complete` |
| `PostToolUseFailure` | `tool-failed` |
| `UserPromptSubmit` | `user-prompt` |
| `SessionStart` | `session-start` |
| `Stop` | `turn-stop` |
| `SessionEnd` | `session-end` |

On each fire, the runtime calls `sink.record(...)` with the raw event
payload passed straight through. The default port
(`NOOP_LEARNING_OBSERVATION_SINK`) writes nothing. The hook's own `class` is
`observe`, so a sink that throws or exceeds the hook's `timeoutMs` never
blocks the lifecycle — it fails open with `hook-observer-failed`, matching
the failure-semantics table above. W3 owns the observation schema,
retention, and redaction on its side of this call; W6 only guarantees the
call happens, reliably, once per mapped event, observe-only (writes data
only — per W3's own D-3, mutation to rules/skills/memory stays
human-applied, never automatic from an observation).

### `ImpactEvidenceProvider` (W8)

```ts
export interface ImpactEvidenceInput {
  sessionId: string;
  filePath: string;
  toolName: string;
  projectRoot: string;
  firstEditInSession: boolean;
}

export interface ImpactEvidenceResult {
  additionalContext?: string;
  decision?: "ask";
}

export interface ImpactEvidenceProvider {
  evidenceFor(input: ImpactEvidenceInput): Promise<ImpactEvidenceResult> | ImpactEvidenceResult;
}
```

`keryx.impact-evidence` is registered on `PreToolUse` with matcher
`Write|Edit`. The runtime tracks, per `HookRuntime` instance (i.e. per
session), which file paths have already been edited; the provider is
consulted **only on a session's first edit of a given file** — every
subsequent edit of that same file is a no-op (`outcome: "none"`,
`firstEditInSession` is always `true` when the provider is called, so the
field is really "was this the first" rather than something the provider
needs to check itself). The default port (`NOOP_IMPACT_EVIDENCE_PROVIDER`)
returns `{}` — no context, no escalation.

The hook's `class` is `gate-advisory`: when the provider returns
`additionalContext`, it is appended to the turn's context (capped, as
above); when it returns `decision: "ask"`, that tightens the composed
`PreToolUse` outcome exactly like any other gate-capable hook `ask`
would. This is the default, gate-advisory behavior today — the design doc
also describes a **W8 strict mode** where this same hook escalates to a full
`gate` class (fail-closed on failure in every profile, not just
`unattended-untrusted`). That escalation is not implemented by this runtime:
the registration's `class` is currently fixed at `gate-advisory` in
`builtins.ts` and is not read from a strict-mode flag. Implementing strict
mode is W8's to do, along the lines of either (a) W8 makes
`keryx.impact-evidence`'s `class` conditional on the active profile/strict
flag when building the registration list, or (b) W8's provider itself
always returns `decision: "ask"` on a lookup failure it considers
disqualifying, relying on `composeDecision`'s tighten-only rule rather than
changing the hook's own class. Either path is additive to this runtime, not
a change to it.

### Where the ports are injected

Both ports are optional fields of `HookRuntimePorts`, passed to
`createHookRuntime({..., ports})` (`src/harness/hooks/runtime.ts`). The
production wiring for `keryx shell` (`buildShellHookRuntime` in
`src/commands/agent-hooks.ts`) does not yet pass either port through — it
calls `createHookRuntime` with no `ports` option, so both built-ins run
against their no-op defaults today. W3 and W8 plug in by extending
`BuildShellHookRuntimeOptions`/`buildShellHookRuntime` to accept and forward
a real sink/provider (or by calling `createHookRuntime` directly with their
own ports, for a bespoke entry point).

### The `hook_invocation` session record

Every hook invocation — built-in or user/project-configured — produces one
`HookInvocationRecord` (`src/harness/hooks/types.ts`), mirrored into the
session's append-only record stream as a `hook_invocation` entry
(`src/harness/run/run.ts`, alongside the existing `policy_decision`
entries, same envelope: `artifactRef`, `correlationId`):

```ts
export interface HookInvocationRecord {
  hookId: string;
  event: HookEventName;
  class: HookClass;
  scope: HookScope;              // "builtin" | "user" | "project"
  outcome: PolicyOutcome | "none";
  failure?: HookFailureKind;     // "timeout" | "crash" | "malformed" | "sandbox-unavailable" | "refused"
  reason?: string;
  durationMs: number;
  changedOutcome: boolean;
  exitCode?: number;
}
```

This is the record W8 governance (or a W1 stocktake) reads to audit hook
behavior over a session or across sessions without re-deriving it from raw
logs: which hooks ran, on which events, whether each one changed the
outcome, and — for a failure — which of the five named failure kinds it was.
`correlationId` is the tool call id for per-tool events, or the session's
own deterministic id sequence otherwise, so a `hook_invocation` record can
be joined back to the `policy_decision` record it composed against.
