# W6 — Keryx shell lifecycle hooks
Version: 0.1.3

Implemented in flow 322. See "Implementation notes" below for where the shipped
runtime deviates from (or fills a gap left open by) this design; user-facing
documentation lives at [docs/docs/hooks.md](../../../docs/hooks.md).

## Summary

Keryx's own agent runtime (`src/harness/`) has a real, deterministic, well-tested tool-call
interception layer — the policy engine (`src/harness/policy/engine.ts`) — but no pluggable,
project- or user-authored hook system: zero `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop`-named
events exist anywhere in `src/harness`, and no config file lets a project or a person register a
command against a lifecycle point. W6 is `planned`: it adds a hook runtime to `keryx shell` with ten
named lifecycle events, a config-file pair (`~/.keryx/hooks.json`, `.metaproject/hooks.json`) merged
over Keryx's built-in registrations, and a JSON stdin/exit-code/stdout I/O contract shaped like the
public Claude Code hooks convention so one hook command runs unmodified whether invoked here or
installed into a host harness by W5. Hooks never replace the policy engine; they can only tighten
its allow/ask/deny outcome, never loosen it.

## Current state

Verified by reading the cited files in this worktree.

- **The policy engine is the harness's PreToolUse-equivalent gate.** `src/harness/policy/types.ts`
  defines `PolicyOutcome = "allow" | "ask" | "deny"`, three frozen profiles (`read-only-review`,
  `monitored-trusted-local`, `unattended-untrusted`), and a side-effect-free `decide()` in
  `src/harness/policy/engine.ts` with fixed precedence: hard deny (terminal, unoverridable,
  `HARD_DENY_RISKS`) → managed flow-file guard (`isManagedFlowFile`, `engine.ts:92-96`) → profile
  baseline → approval-authorized allow (`hasValidApproval`, `engine.ts:104-110`) → headless
  fail-closed (`ask`→`deny` when `ctx.interactive === false`, `engine.ts:234-241`) → interactive
  `ask`. `role` is advisory-only, never self-escalating (`types.ts:78-80`).
- **The exact choke point** is `src/harness/run/run.ts:374`: `let decision = decide({ toolCallId,
  risk }, policyContext, { clock: deps.clock, idSeq: deps.idSeq });`, called once per resolved
  `tool_call_end` event, then appended to the session log (`run.ts:398-405`); per the comment at
  `run.ts:407-408`, "a transport can never upgrade a policy decision: only an in-process `allow`
  reaches the executor." `src/lib/serve-turn.ts` drives the same `run.ts` loop for `keryx serve` and
  does not call `decide()` itself. This is where a `PreToolUse` hook must run before `decide()`, and
  where `PostToolUse`/`PostToolUseFailure` must run after execution.
- **`src/harness/startup.ts`**'s `startRun()` (outcomes `disabled`/`environment_blocked`/`started`,
  emitting a `StartupEvent`) is the closest analogue to `SessionStart`, but it is an internal record
  — it takes no hook list and calls no external command.
- **Zero lifecycle-event names exist in `src/harness`**: `keryx ctx rg
  "PreToolUse|PostToolUse|SessionStart|hooks.json" src/harness` returns 0 matches (confirmed). The
  101 "hook" matches elsewhere (e.g. `SpawnSubagentToolDeps.runExternal`, documented in
  `src/harness/run-external-factory.ts:5` as "the hook `spawn_subagent` accepts", and the "external
  hook" in `spawn-subagent-tool.ts:274-290`) are dependency-injection test seams, not a user-facing
  hooks system.
- **`src/harness/tool/builtin/spawn-subagent-tool.ts`** (`deps.runExternal`, lines 298/623/645) is
  where an *external* Keryx subagent (`spawnKind: "external"`) is spawned — the attach point for
  `SubagentStart`/`SubagentStop` and hook-inheritance on that path. **`src/harness/child/`**
  (`spawn.ts`, `orchestrate.ts`, `escalation.ts`, `worktree.ts`, `ledger.ts`, `quarantine.ts`,
  `isolation.ts`) holds subagent lifecycle machinery; `spawnChild()` (`src/harness/child/spawn.ts:119`)
  is the corresponding attach point for an *internal* (in-process, `spawnKind: "internal"`) child —
  its fixed guard order (budget → policy → model, fail-closed, no partial extension/session
  entry/provenance on denial) is where `SubagentStart` must run before a bounded child is built, and
  where `SubagentStop` must run once `ChildSpawnResult` resolves. Neither path registers an external
  hook command today.
- **`src/harness/process/sandbox/`** already implements OS-level containment — `adapter.ts`
  (`SandboxedProcessAdapter`, a decorator that "OS-contains every command before delegating to an
  inner real adapter"), `bwrap.ts`, `detect.ts`, `network-run.ts`, `profile.ts` — fail-closed: a
  `required` profile or `network: "restricted"` refuses to run unsandboxed rather than silently
  weaken containment (`adapter.ts:9-23`). W6 reuses this adapter; it adds no new sandbox.
- **`src/harness/external/codec/claude-cli.ts:20-24`** documents that Keryx passes `--safe-mode`
  (not `--bare`) when spawning `claude -p` as an external subagent specifically because, without it,
  "the child runs the OPERATOR's hooks (`system/hook_started`, `system/hook_response` appeared in
  the probe) and loads their whole skill set, ~130 slash commands." This is the precedent for W6's
  "child agents inherit an explicit hook set, never the host's ambient hooks" rule.
- **`src/acp/permission.ts`**: every ACP `session/request_permission` outcome that is not an explicit
  allow is a denial (file header, lines 24-26) — Keryx's own policy layer governs ACP tool calls, not
  a host-side hook. `src/trigger/hooks.ts`/`src/trigger/unattended.ts` are the trigger/schedule
  subsystem's own run-lock/admission bookkeeping (`src/commands/trigger.ts:1`: "the single entry
  point every hook, cron ... a run may proceed under the project's trigger lock") — a separate
  concern from the hook runtime defined here (see "ACP/serve/trigger/schedule behavior").
- **Three separate host-installer registries already exist** (`src/ctx/runtimes.ts`,
  `src/ctx/orient-runtimes.ts`, `src/security/agent-hooks/runtimes.ts`) for pushing Keryx's guard
  logic into host harnesses' native hook config — that is W5's unified-adapter-registry concern, not
  W6's. W6 is `keryx shell`'s own runtime; W5 is how the same built-ins additionally reach hosts not
  running Keryx as the agent.

## Goals & non-goals

**Goals**
- A first-class, pluggable hook runtime in `keryx shell` with the ten lifecycle events below,
  config-file driven, deterministic ordering, enforced timeouts.
- An I/O contract compatible enough with the public Claude Code hooks convention that one hook
  command works unmodified here and (via W5) in a host harness.
- Strict composition with the policy engine: hooks can only tighten (`allow`→`ask`/`deny`, add
  context); never loosen, never override a hard deny or the flow-file guard.
- Explicit, profile-aware failure semantics (timeout/crash/malformed output) per event class.
- Register Keryx's built-in hooks (ctx guard, security check-input/output, W3 learning observer, W8
  impact-evidence) through this runtime so `keryx shell` and a host harness enforce the same policy.
- Explicit, auditable child-agent hook inheritance.
- Identical behavior under `keryx serve` (ACP), `keryx trigger run`, and `keryx schedule`, fail-closed
  by default when unattended.

**Non-goals (v1)**
- **No input rewriting.** A `PreToolUse` hook may add `additionalContext` and tighten the decision;
  it may not return an `updatedInput` the executor substitutes for the model's original tool input.
  Rationale: this is the highest-leverage vector for a buggy/compromised hook to silently change what
  a tool does while the transcript still shows the original call — it would add a second, harder-to-
  audit mutation path next to the "transport can never upgrade a policy decision" invariant already
  enforced at `run.ts:407-408`. Revisit only behind a capability flag once an audit-trail design
  exists (see Open questions).
- No in-process, prompt-type, or HTTP-handler hook — every hook is a spawned, sandboxable command.
- No hook marketplace or remote-fetched hook code.
- Does not add new host-harness adapters (that is W5); W6 defines the shape W5 exports.
- Does not change the policy engine's precedence or profiles — strictly additive above `decide()`.

## Design

### Event list

| Event | Fires | Payload (stdin JSON) | Can it change the outcome? |
|---|---|---|---|
| `SessionStart` | After `startRun()` returns `started`, before the first turn | `{event, sessionId, runId, projectRoot, policyProfile, contextHash, provider, model}` | No; may add `additionalContext`. |
| `UserPromptSubmit` | Per submitted prompt, before it reaches the model | `{event, sessionId, runId, prompt}` | May add context or `deny`, gate-class. |
| `PreToolUse` | Per resolved tool call, immediately before `decide()` at `run.ts:374` | `{event, sessionId, runId, toolCallId, toolName, toolInput, risk, policyProfile}` | Yes — `allow`/`ask`/`deny` + `additionalContext`. |
| `PostToolUse` | Per successfully-executed tool call | `{event, sessionId, runId, toolCallId, toolName, toolInput, toolOutput, policyDecision}` | Observe-only. |
| `PostToolUseFailure` | Per tool call whose execution errored | `{event, sessionId, runId, toolCallId, toolName, toolInput, error:{message, code}}` | Observe-only. |
| `PreCompact` | Before session context is compacted | `{event, sessionId, runId, reason:"auto"|"manual", tokenCount}` | May add context; cannot block compaction. |
| `Stop` | Agent loop about to yield control (turn end) | `{event, sessionId, runId, stopReason}` | May `ask`/`deny`, gate-class. |
| `SubagentStart` | At `deps.runExternal` (external, `spawn-subagent-tool.ts`) or `spawnChild()` (internal, `src/harness/child/spawn.ts:119`) | `{event, sessionId, runId, subagentId, parentSessionId, spawnKind:"external"|"internal", inheritedHookIds}` | May `deny` the spawn. |
| `SubagentStop` | `runExternal` resolves, `escalation.ts`'s ladder terminates the child (external), or `spawnChild()`'s `ChildSpawnResult` resolves (internal) | `{event, sessionId, runId, subagentId, outcome, escalationStop?}` | Observe-only. |
| `SessionEnd` | Session teardown (normal/abort/error) | `{event, sessionId, runId, endReason}` | Observe-only. |

Every payload also carries `schemaVersion`, `timestamp` (same injected clock `decide()` uses), and
`hookId`. No payload field is echoed back from a hook as authoritative — only the decision/context
fields defined below are trusted.

### Config files and precedence

Three layers, lowest to highest precedence:

1. **Built-in** — compiled into `keryx shell`; ids namespaced `keryx.<name>` so a project/user id can
   never collide.
2. **User scope** — `~/.keryx/hooks.json` (`hook-config.schema.json`); applies across projects.
3. **Project scope** — `.metaproject/hooks.json`, same schema; version-controlled, highest precedence.

Merge: registrations concatenate built-in → user → project, each in file order. A project/user `id`
that collides with a built-in's namespaced id is rejected at load (`hook-id-collides-with-builtin`),
not silently shadowed — applying the "never let two writers silently clobber the same slot" lesson
from `src/security/agent-hooks/runtimes.ts:169-201` to Keryx's own files. A project may still
*disable* an inherited hook (`enabled: false` on the same `id`) — override-by-id, not collision.

`hook-config.schema.json`'s `id` pattern is `^(keryx\.)?[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`, and a
`keryx.<name>` id is valid in a project/user file only through the schema's `oneOf`: a full
registration (all of `id`/`matcher`/`command`/`class`, `id` without the `keryx.` prefix) or a
disable-only override (`{id, enabled: false}` exactly, `id` with the `keryx.` prefix). A full
registration using a `keryx.`-prefixed `id`, or an override carrying any field beyond `id`/`enabled`,
fails schema validation — this is what makes "disable a built-in" and "collide with a built-in" two
distinct, distinguishable shapes instead of one ambiguous one.

`_keryxManaged` sentinel: `keryx hooks enable|disable` records `managedHookIds` so a later
`keryx hooks enable|disable` or `validate` call can distinguish exactly what Keryx added from a
hand-edited entry, never touching the latter — the same discipline W5's host-config installers use,
applied to Keryx's own files. Its shape (`{tool, version, managedHookIds}`) is intentionally an object,
not the string/string-array sentinel form existing host settings files (e.g. `.claude/settings.json`)
use — see `hook-config.schema.json`'s `_keryxManaged` description.

### Hook I/O contract

- **stdin**: one JSON event payload, written once, then closed.
- **exit code**: `0` = success (stdout parsed as optional JSON; empty/invalid stdout = silent
  approve, no context). `2` = explicit block for a `gate`-class hook (`decision: "deny"`; stderr
  captured as the reason). Any other non-zero = crash (failure-semantics table below).
- **stdout JSON** (exit `0` only): `{"decision": "allow"|"ask"|"deny", "additionalContext": "...",
  "reason": "..."}`. `decision` is honored only for `gate`- and `gate-advisory`-class hooks on
  gate-capable events (`PreToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart`); an `observe`- or
  `context`-class hook's `decision` is ignored and logged as a governance anomaly. **`updatedInput` is
  explicitly not part of this
  contract in v1** — accepted for forward-compat parsing, dropped before composition, and its
  presence is recorded once per session as `hook-attempted-input-rewrite` for future design data.
  `additionalContext` is appended (never replaces) turn context, capped by the same bound class as
  `MAX_CONTEXT_BYTES`/`MAX_CONTEXT_TOKENS` (`src/harness/context/manifest.ts`), truncated with a
  named reason on overflow.

### Composition with the policy engine

Hooks run before `decide()` for `PreToolUse` and the other gate-capable events, and can only
tighten:

```
tool call → PreToolUse hooks (built-in→user→project; allow=no-op, ask=tighten, deny=terminal)
          → decide() (unchanged: hard-deny → flow-file guard → baseline → approval →
                       headless fail-closed → ask)
          → any hook said deny? final = deny.  decide() said hard-deny? untouchable by any hook.
          → final PolicyDecision → (if allow) executor runs the tool
          → PostToolUse / PostToolUseFailure (observe-only, cannot revisit the decision)
```

Rules (explicit because this is the exact failure class `src/security/agent-hooks/runtimes.ts:169-201`
documents for the *installer* side — two subsystems silently fighting over one settings key):

- **Hard deny is untouchable.** No hook, of any class or precedence, turns `hardDeny: true` into
  `allow`/`ask` — the composition function never resolves hook decisions once `decide()` has already
  hard-denied.
- **`ask` is the floor once any gate hook asks; `deny` is the floor once any gate hook denies.** A
  hook can never turn a `decide()`-produced `ask`/`deny` into `allow`.
- **Headless**: the `engine.ts:234-241` ask→deny rule applies *after* hook composition, so a hook
  tightening to `ask` under `interactive: false` still fails closed to `deny`.
- **Multiple gate hooks on one event** run in the deterministic order from
  `hook-config.schema.json` (built-in→user→project, ties by `id`); the first `deny` short-circuits
  the remaining hooks for the *decision*, but already-started hooks still finish (within their own
  timeout) so their `additionalContext`/evidence output is not lost.

### Failure semantics

| Event class | Failure | `read-only-review` / `monitored-trusted-local` | `unattended-untrusted` |
|---|---|---|---|
| `gate` (Pre*, UserPromptSubmit, Stop, SubagentStart) | Timeout | fail closed: `deny`, reason `hook-timeout` | fail closed: `deny`, reason `hook-timeout` |
| `gate` | Crash (non-zero, not `2`) | fail closed: `deny`, reason `hook-crashed` | fail closed: `deny`, reason `hook-crashed` |
| `gate` | Malformed stdout on exit `0` | silent-approve **only if** `decide()`'s own outcome is not `ask`; if `decide()` said `ask`, fails closed to `deny` — a broken hook must never be the thing that turns an ask into an approval | same |
| `gate-advisory` (e.g. `keryx.impact-evidence`) | Timeout/crash/malformed | fail **open**: lifecycle proceeds without the hook's `additionalContext`/tightening; `hook-advisory-failed` warning recorded | fail **closed**: `deny`, reason `hook-advisory-failed` |
| `observe` (Post*, PreCompact, SubagentStop, SessionEnd) | Timeout/crash/malformed | fail open: lifecycle proceeds unchanged; `hook-observer-failed` warning recorded | fail open: lifecycle proceeds unchanged; `hook-observer-failed` warning recorded |
| `context` | Timeout/crash/malformed | fail open: lifecycle proceeds without the added context; warning recorded | fail open: lifecycle proceeds without the added context; warning recorded |
| `SessionStart` | Timeout/crash/malformed | fail open (session starts without the hook's context); warning recorded | fail open (session starts without the hook's context); warning recorded |

`gate` fails closed and `observe`/`context` fail open, in every profile, because those two classes are
defined incapable of changing a decision — their failure can never weaken enforcement, so tying loop
availability to them would be a category error. A `gate` hook's whole purpose is to change a decision,
so its failure is treated like a missing/corrupt policy input, matching the existing headless
fail-closed posture rather than inventing a new one. `gate-advisory` sits between the two: it can
tighten a decision when it runs, but a project may need it to degrade gracefully rather than block
every matching tool call outright, so its failure is profile-aware — fail-open-with-warning in the two
supervised profiles, and fail-closed only in `unattended-untrusted`, matching W8's requirement that an
unattended run never silently loses impact-evidence enforcement.

### Execution

- **Sandboxed**: every hook is spawned through the existing `SandboxedProcessAdapter`
  (`src/harness/process/sandbox/adapter.ts`) — `runsIn: "sandbox"` by default; the adapter's own
  fail-closed rule (`adapter.ts:9-23`) applies unchanged.
- **No network by default** (`network: "none"`); `network: "restricted"` routes through the sandbox's
  existing proxy-allowlist (`network-run.ts`); never `full`.
- **Env allowlist**: a fixed, minimal environment (session id, run id, project root, policy profile
  id — no ambient shell env, no credentials) plus explicit `command.env` entries; nothing else passes
  through, closing the command-injection-via-interpolation and ambient-secret-leak classes W8 audits.
- **Timeouts**: per-registration `timeoutMs` (default 5000ms, max 60000ms), enforced by the existing
  executor-level timeout mechanism (`src/harness/process/executor.ts`).
- **Ordering**: deterministic (built-in→user→project, file order, ties by `id`), never wall-clock —
  reproducible the way `decide()` is.
- **Parallelism**: `gate`-class hooks on one event run sequentially (first `deny` short-circuits);
  `observe`-class hooks run in parallel with no ordering guarantee, since none affects the others.

### Built-in Keryx hooks registered

| id | event(s) | class | Backs |
|---|---|---|---|
| `keryx.ctx-guard` | `PreToolUse` (`Bash`) | gate | The routing/shell guard `src/ctx/runtimes.ts` installs into host harnesses, invoked here as `keryx ctx hook` directly instead of through a settings file. |
| `keryx.security-check-input` | `UserPromptSubmit` | gate | `keryx security check-input`, the same scan `src/security/agent-hooks.ts` installs into hosts; unchanged blocking-pre-hook semantics. |
| `keryx.security-check-output` | `PreToolUse` (`Write\|Edit`) | gate | `keryx security check-output`; unchanged blocking-pre-hook semantics — the scan runs *before* the write/edit executes, matching today's installed behavior, not as a post-hoc observation. |
| `keryx.learning-observer` (W3) | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SessionEnd` | observe | Appends redacted, bounded, TTL'd observation records per W3's Observe stage, one per mapped event (`PreToolUse→tool-start`, `PostToolUse→tool-complete`, `PostToolUseFailure→tool-failed`, `UserPromptSubmit→user-prompt`, `SessionStart→session-start`, `Stop→turn-stop`, `SessionEnd→session-end`). Registered on exactly these seven events, no more and no fewer. Writes data only, never rules/skills/memory (W3 D-3: mutation stays human-applied). |
| `keryx.impact-evidence` (W8/F) | `PreToolUse` (`Write\|Edit`) | gate-advisory (default); `gate` in W8 strict mode | On a session's first edit of a file, injects `additionalContext` (`gdgraph affected` importers, `test related`, memory caveats). Escalates to `ask` only when W8's strict mode is enabled for the active profile; at `gate-advisory`, a failed lookup degrades to fail-open-with-warning per profile (see failure-semantics table) instead of blocking the edit. |

All five register at built-in precedence with `keryx.*` ids; a project must use `enabled: false`
(recorded, auditable) to turn one off, never a colliding id.

`keryx.ctx-guard`'s matcher is deliberately narrower than the installed host guard's
`Bash|Grep` matcher (`.claude/settings.json`, confirmed): `keryx shell`'s builtin tool set
(`src/harness/tool/builtin/`) has no `Grep`-named tool for a shell command to route through — its
tools are `shell-exec-tool`, `apply-patch-tool`, `ask-user-tool`, `slate-tool`,
`spawn-subagent-tool`, `web-fetch-tool`, `web-search-tool`, `workspace-context-tool`,
`workspace-lifecycle-tool`, `execution-plan-tool`, `background-job-registry`, and
`metaproject-tools` — so `Bash` alone covers every builtin tool the guard needs to intercept here.
If a future builtin tool adds its own search/grep surface, this matcher must grow to name it.

### Child agents inherit an explicit hook set

Mirrors the `--safe-mode` precedent (`claude-cli.ts:20-24`): a Keryx subagent never inherits a host
harness's ambient hooks, and does not implicitly inherit the parent's full merged set either.
`SubagentStart`'s `inheritedHookIds` is computed from each registration's `appliesToChildAgents` flag
(schema default `true`), so a project can scope which hooks follow a subagent (e.g. keep the guard
and security hooks, keep an expensive observe-only evidence hook parent-only). Recorded once per
spawn in the session's evidence log.

### ACP/serve/trigger/schedule behavior

- **`keryx serve`**: drives the same `run.ts` loop that calls `decide()` at line 374 — hooks attach
  at the same point regardless of transport.
- **ACP**: `src/acp/permission.ts` already denies everything but an explicit allow. A gate hook can
  tighten an ACP-mediated decision, never loosen a `reject_*`/`cancelled` outcome to allow.
  `UserPromptSubmit`/`SessionStart`/`SessionEnd` fire around the ACP session boundary; `PreToolUse`/
  `PostToolUse` fire per ACP tool-call turn as in the non-ACP loop.
- **`keryx trigger run` / `keryx schedule`**: unattended entry points
  (`src/commands/trigger.ts:1`: "the single entry point every hook, cron ... a run may proceed under
  the project's trigger lock"). `interactive: false` is set on every hook invocation's context, so a
  gate hook whose composed outcome would be `ask` fails closed to `deny`, matching `decide()`'s own
  headless posture. `src/trigger/hooks.ts`/`unattended.ts` remain the trigger subsystem's own
  admission bookkeeping (should this run start at all) and are unchanged by W6, which governs tool
  calls *inside* a run trigger/schedule already admitted.

### Observability

Every hook invocation (id, event, decision or failure class, duration, whether it changed the
outcome) is appended to the same append-only session record stream `run.ts:398-405` uses for
`policy_decision`, as a `hook_invocation` record with an `artifactRef` content hash. `observe`-class
failures additionally surface as named-reason warnings (`hook-observer-failed`) so a W8 governance
review or W1 stocktake can find silently-failing hooks without grepping raw logs.

### CLI

- `keryx hooks list [--json]` — resolved, merged hook list with precedence and `enabled` state.
- `keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json]` — runs one hook against a
  synthetic/captured payload outside a real session; reports decision, stdout/stderr, exit code,
  duration.
- `keryx hooks validate [--json] [--ci]` — validates both config files against
  `hook-config.schema.json`, checks id collisions with built-ins, and (best-effort, no execution)
  that each `command.argv[0]` resolves.
- `keryx hooks enable <id>` / `keryx hooks disable <id>` — flips `enabled` in the project-scope file
  by default (`--user` targets `~/.keryx/hooks.json`), updating `_keryxManaged` bookkeeping.

## Data contracts

- `hook-config.schema.json` (this package) — the `~/.keryx/hooks.json`/`.metaproject/hooks.json`
  shape.
- Hook stdin/stdout payloads are not separately schema-pinned in v1 (the Event list and I/O contract
  sections above are the source of truth); a follow-up `hook-event.schema.json` is an open question.
- `hook_invocation` session records reuse the existing session-record envelope (`artifactRef`,
  `correlationId`) already used for `policy_decision` at `run.ts:398-405` — no new envelope format.

## Integration

- **W3**: `keryx.learning-observer` is W6's delivery mechanism for W3's Observe stage; W3 owns the
  observation schema/retention/redaction, W6 owns delivering the events reliably and observe-only.
- **W5**: W6 defines the event names, I/O contract, and built-in hook commands that W5's unified
  adapter registry installs into host harnesses. W6 writes nothing outside `keryx shell`; W5 is the
  only writer into `.claude/settings.json`, `.cursor/hooks.json`, etc.
- **W8**: `keryx.impact-evidence` is delivered through W6's runtime; W8 owns the evidence content and
  strict-mode/acknowledgement/exemption-glob policy. W8's harness-config audit also scans
  `.metaproject/hooks.json`/`~/.keryx/hooks.json` for the same classes it scans host hook files for.
- **Policy engine**: the composition rules above are the full integration surface; W6 does not modify
  `engine.ts` or `types.ts`.

## Risks

- **Two subsystems silently fighting over the same call** is a documented, already-observed failure
  class here (the ctx-guard/security-hooks coexistence bug for Cursor/Windsurf,
  `src/security/agent-hooks/runtimes.ts:169-201`, caught only after shipping once). W6's mitigation is
  structural (tighten-only, hard deny untouchable, namespaced ids); any future change to the
  composition function should be treated as security-sensitive.
- **A slow gate hook is a denial-of-service on every matching tool call.** Mitigated by a 60s hard
  cap and `keryx hooks test` for pre-registration latency checks; no automatic circuit-breaker in v1
  (open question).
- **The malformed-output-on-`ask` asymmetry** (fails closed only when `decide()`'s own outcome is
  `ask`) is easy to regress; needs a dedicated test analogous to `engine.test.ts`'s headless cases.
- **Exact env allowlist fields are not enumerated here** — an implementation decision needing a
  security-review pass before the first gate hook ships.

## Acceptance criteria

- **W6-AC1**: A `PreToolUse` gate hook returning `{"decision":"ask"}` for a call `decide()` would
  otherwise `allow` yields a final `ask` (or `deny` under `interactive: false`), through `run.ts`'s
  existing decision pipeline.
- **W6-AC2**: No hook or combination of hooks turns a `decide()` hard deny into `allow`/`ask` —
  covered by a test registering a hook returning `allow` against a hard-denied risk, asserting the
  final decision stays `deny` with `hardDeny: true`.
- **W6-AC3**: A gate hook exceeding `timeoutMs` produces `deny` under all three profiles, reason
  `hook-timeout`, recorded as a `hook_invocation` record.
- **W6-AC4**: An observe hook that crashes does not block, delay past its own timeout, or alter the
  observed tool's result; a `hook-observer-failed` warning is recorded.
- **W6-AC5**: `keryx hooks validate` rejects a hook `id` colliding with a built-in
  (`hook-id-collides-with-builtin`) and rejects non-conformance to `hook-config.schema.json`.
- **W6-AC6**: A spawned subagent receives exactly the hook ids whose `appliesToChildAgents` is
  `true`/unset, recorded in `SubagentStart.inheritedHookIds`, and none of a host's ambient hooks.
- **W6-AC6b**: An internal child spawned through `spawnChild()` (`src/harness/child/spawn.ts:119`,
  `spawnKind: "internal"`) fires `SubagentStart`/`SubagentStop` with the same inheritance and
  deny-the-spawn semantics as an external child spawned through
  `spawn-subagent-tool.ts`'s `deps.runExternal` (`spawnKind: "external"`); a hook denying
  `SubagentStart` prevents `spawnChild()` from returning a usable extension, matching its existing
  fail-closed guard order.
- **W6-AC7**: `keryx trigger run`/`keryx schedule` set `interactive: false` on every hook invocation;
  a gate hook whose composed outcome would be `ask` resolves to `deny`, matching `engine.ts:234-241`.
- **W6-AC8**: `keryx hooks list --json` with no config files present still lists exactly the five
  built-in hooks with `enabled: true`.

## Open questions

- **`hook-event.schema.json`**: pin the ten payload shapes once real fixtures exist, or keep the
  Markdown table authoritative until an implementation reveals gaps? Leaning toward pinning only
  after `PreToolUse`/`PostToolUse` run against real fixtures — premature pinning risks the same trap
  the unverified `securityHooks` key hit on the installer side (`src/security/agent-hooks/runtimes.ts:195-200`, OQ-3).
- **Circuit breaker for chronically slow/failing hooks**: auto-disable a gate hook after N timeouts
  in a session (with a recorded reason), or leave this to `keryx hooks validate`/stocktake? Leaning
  toward a session-scoped breaker for gate hooks specifically, since a DoS there degrades every
  subsequent tool call.
- **Exact env allowlist field list**: deferred to implementation; needs a security-review pass first.
- **Do `UserPromptSubmit`/`Stop` need full deny power, or only ask/context?** Granted full gate power
  here for symmetry with the Claude Code convention, but no concrete Keryx use case for denying a
  `Stop` exists yet beyond an illustrative "run tests before stopping" pattern.
- **Input-rewriting revisit criteria for v2**: what audit-trail design (e.g. re-validating a rewritten
  input through `decide()` as if it were the original call, with the substitution itself a
  non-suppressible session event) would make `updatedInput` safe enough to reconsider?

## Implementation notes (flow 322)

The runtime, CLI, and `keryx shell` wiring described above shipped in flow 322
(`src/harness/hooks/`, `src/commands/hooks.ts`, `src/commands/agent-hooks.ts`).
User-facing documentation is at
[docs/docs/hooks.md](../../../docs/hooks.md). Decisions D1–D6 below are the
plan's own record (`.metaproject/flows/322-.../plan.md`); the rest are
deviations or gaps this design left open, found while implementing and
documenting it.

- **D1 — Hooks integrate through optional deps.** `RunDeps.hooks?`,
  `AgentDeps.hooks?`. Absent is byte-identical to hooks never having existed
  (replay-safe).
- **D2 — No new sandbox.** Hooks reuse the existing `wrapWithSandbox` +
  `detectSandboxLauncher` layer inside a new async runner, rather than
  extending the sync `ProcessAdapter`.
- **D3 — Dual-shape stdin/stdout.** Stdin carries both the camelCase W6
  fields and Claude-Code-style snake_case aliases (`hook_event_name`,
  `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`,
  `prompt`); stdout accepts both `decision`/`additionalContext`/`reason` and
  `hookSpecificOutput.*`, so one hook command runs unmodified under either
  convention.
- **D4 — The two stub built-ins run in-process.** `keryx.learning-observer`
  and `keryx.impact-evidence` are the only `{kind: "builtin"}` handlers,
  invoked through the `LearningObservationSink`/`ImpactEvidenceProvider`
  ports (`src/harness/hooks/builtins.ts`) rather than spawned — never
  available to a user/project registration.
- **D5 — Env allowlist**: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`
  (inherited, only if already set), plus `KERYX_HOOK_EVENT`,
  `KERYX_HOOK_ID`, `KERYX_SESSION_ID`, `KERYX_RUN_ID`, `KERYX_PROJECT_ROOT`,
  `KERYX_POLICY_PROFILE`, `CLAUDE_PROJECT_DIR` (= project root), then
  `command.env`. Nothing else reaches a hook process — this resolves the
  "exact env allowlist" open question above.
- **D6 — PR shape**: runtime+`run.ts` integration landed first, with
  built-ins/CLI/shell wiring stacked on top, per the plan's fallback.

**Deviations from this design, documented rather than silently accepted:**

- **`PreToolUse` fires AFTER `decide()`, not before it, in the production
  `run.ts` wiring** — the opposite of the "hooks before `decide()`" order the
  pipeline diagram above shows. This is deliberate: `decide()` is pure and a
  hook cannot influence its inputs, so the only point a hook decision and the
  policy decision actually meet is `composeDecision`, which runs after both
  are known regardless of firing order — and running `decide()` first is
  what makes the gate malformed-output asymmetry (fails closed only when
  `decide()`'s own outcome was `ask`) implementable at all: that rule cannot
  be evaluated by a hook that fires before `decide()` has run. See
  `src/harness/run/run.ts:529-542` and docs/docs/hooks.md's "Where
  `PreToolUse` actually fires" section.
- **Tool-name aliases for matcher matching**: `executeCall`'s Keryx tool
  names are aliased to the Claude-Code-shaped names a built-in/host matcher
  expects before matcher evaluation — `shell_exec` → `Bash`,
  `apply_patch` → `Edit` (`HOOK_TOOL_NAME_ALIASES` in
  `src/commands/agent-hooks.ts`). This table is not named in the design
  above; it exists because `keryx shell`'s builtin tool names
  (`shell-exec-tool`, `apply-patch-tool`, ...) do not literally match the
  Claude Code tool names the built-in matchers (`Bash`, `Write|Edit`) are
  written against. The hook still receives the original Keryx tool name in
  its payload (`toolName`) — only the value tested against `matcher` is
  aliased.
- **`hook-config-invalid` fail-closed runtime**: not itself part of the
  `src/harness/hooks/` runtime design above — it is `buildShellHookRuntime`'s
  own addition (`src/commands/agent-hooks.ts`) for the case `loadHookConfig`
  reports `ok: false`. Rather than the ambiguous "config missing" treatment
  (empty, no diagnostic), a load *failure* builds a runtime whose every
  gate-capable event unconditionally denies with reason
  `hook-config-invalid`, so a broken/tampered config file cannot silently
  degrade to "hooks disabled".
- **`keryx.impact-evidence`'s W8 strict mode is not implemented.** The
  Built-ins table above describes `gate-advisory (default); gate in W8
  strict mode`; the shipped registration's `class` is fixed at
  `gate-advisory` in `builtins.ts` and is not conditioned on any strict-mode
  flag. `ImpactEvidenceResult` only supports escalating to `decision: "ask"`
  (tightening within the advisory hook's own gate-capable power), not a
  class change to full `gate`. W8 can add strict mode without touching this
  runtime, either by making the registration's `class` conditional when the
  registration list is built, or by having the provider always return
  `decision: "ask"` on a disqualifying failure and relying on
  `composeDecision`'s existing tighten-only rule. See docs/docs/hooks.md's
  "Extension points for W3 and W8" section for the two candidate paths.
- **Built-in command hooks run unsandboxed off `required-fail-closed`
  profiles (T15).** Wiring a real `HookRuntime` into ACP (`src/acp/
  server.ts`) surfaced a usability regression the sandboxed-by-default design
  above did not anticipate: `keryx.ctx-guard`, `keryx.security-check-input`
  and `keryx.security-check-output` spawn the running `keryx` binary itself
  — the same trust domain as the process that spawns them — but sandboxing
  them anyway meant every ordinary prompt was denied on a host without a
  working OS-sandbox launcher (no bubblewrap on Linux, in particular), via
  the fail-closed `sandbox-unavailable` path. Since there is no containment
  boundary between Keryx and Keryx, `resolveBuiltinCommandRunsIn`
  (`src/harness/hooks/runtime.ts`) now resolves a `scope: "builtin"` +
  `handler.kind: "command"` registration to `runsIn: "unsandboxed"` for
  whichever `PolicyProfileId` is active on THIS `fire()`, whenever
  `resolveLocalProfile(profileId).requiredControls.isolation !==
  "required-fail-closed"` — `read-only-review` and `monitored-trusted-local`
  today (`src/harness/policy/profiles.ts`). Under `unattended-untrusted`
  (`required-fail-closed`), the three stay `sandbox` and fail closed exactly
  as the original design specified — an unattended/untrusted turn gets no
  exception. A user/project hook's own `runsIn` (default `sandbox`, same
  `hook-sandbox-unavailable` fail-closed path) is never touched — the
  override only ever widens a built-in's own registration, never a
  configured one, even when a project file names an id starting with
  `keryx.` (`config.ts` already refuses that as a built-in-id collision
  before it can reach a `HookRegistration`, so the only way to see a
  `keryx.*` id at `scope: "project"` is a runtime-constructed test double,
  never a real load path). `keryx hooks list`/`keryx hooks test` (both now
  accept `--profile <id>`) print the EFFECTIVE `runsIn` under that profile,
  not just the registration's static default, so an operator can see which
  mode a built-in will actually run in before relying on it. See
  docs/docs/hooks.md's "Execution" section for the operator-facing writeup,
  and `src/harness/hooks/runtime.test.ts`'s "built-in command hooks run
  unsandboxed off required-isolation profiles" suite for the pinned
  behavior (including the negative case: a `sandbox-unavailable` launcher
  still fails a default-`runsIn` user hook closed on the exact same profile
  and event).
