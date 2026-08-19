# Specification: Keryx External Agent Runtime
Version: 0.4.1

> **0.4.0 (flow 176, T8/T9 codecs).** Implementing the two codecs surfaced a
> silent-failure trap the previous three versions all prescribed: `claude -p`
> with `--input-format stream-json` *and* a positional prompt ignores the
> prompt and exits 0 with zero output. §5.2 now defines two distinct invocation
> shapes, and steerability becomes a spawn-time decision. Also: codex's `-s`
> vocabulary is not keryx's and must be translated; `--add-dir` is variadic and
> was missing from the ordering rule; the codec port's `buildResumeArgv` arity
> is corrected to match the implemented type; and `num_turns` is dropped from
> §6.2 because the canonical `usage` event has nowhere to put it.
>
> **0.3.0 (flow 176, T5 fixtures).** Transcripts were recorded from both live
> CLIs and live in `fixtures/external/` with a `manifest.json` stating which are
> captured and which are hand-authored. Four corrections: `--ephemeral` is
> dropped from the codex argv because it forbids resume; `codex exec resume`
> takes a narrower flag set than `codex exec`; retry events are non-terminal and
> arrive in bulk; and the claude login-refusal behaviour asserted in 0.1.0 does
> not reproduce on 2.1.220.
>
> **0.2.0 (flow 176, T1 discovery).** Four corrections from reading the code and
> probing both live CLIs, replacing assumptions carried in 0.1.0. The execution
> seam is not `spawnChild`; `--tools` is a real allow-list and supersedes the
> deny-list as the primary tool restriction; `--safe-mode` is added; the event
> mapping gains the types the probes actually emitted. Details inline below and
> in the flow-176 journal.

## 1. Identity

| Field | Value |
|---|---|
| Package | `keryx-external-agent-runtime` |
| Capability id | `external-agent-runtime` |
| Runtime ids | `codex-cli`, `claude-cli` |
| Source root | `src/harness/external/` |
| Contract owner | `.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json` |
| Status | specification ready (future) — nothing below is implemented |

**The seam, stated precisely (corrected in 0.2.0).** `spawnChild`
(`src/harness/child/spawn.ts:119`) is a **pure authorisation and contract
builder** — it evaluates the fail-closed guard order (caps → budget → policy →
model), returns a `ChildContractExtension`, a session-entry payload and child
provenance, and executes nothing. Its only injected dependencies are `idSeq`
and `clock`.

Execution happens one layer up, in
`src/harness/tool/builtin/spawn-subagent-tool.ts:873`, which calls
`runAgentTurn(io, childDeps, history, userLine, …)` **directly** — the import is
static and the call is not injectable. `SpawnSubagentToolDeps` injects the
*provider* (`makeProvider`), not the *runner*.

So there is no execution-strategy seam today; this package creates one. The
external runtime adds an optional `runChild` strategy to
`SpawnSubagentToolDeps`, defaulting to the current `runAgentTurn` path so every
existing call site is unchanged — the same additive-optional-dep idiom that file
already uses for `getSlateSession` and `onLedgerReady`.

Authorisation is unaffected: an external child still passes through
`spawnChild`, and there is no parallel spawn path, budget ledger, depth
accounting, or event stream.

## 2. Storage structure

```text
src/harness/external/
  types.ts          ExternalAgentCodec port; event and result types
  registry.ts       ExternalAgentEntry table + lookup + detection
  env.ts            child environment builder (deny lists, prefix sweeps)
  prompt.ts         directive + task + working-diff assembly, size ceiling
  supervise.ts      process lifecycle: spawn, stream pump, timeout, raced kill
  runtime.ts        spawnChild integration; maps codec output onto child result
  codec/
    codex-cli.ts    argv, parse, classify for `codex exec`
    claude-cli.ts   argv, parse, classify for `claude -p`
fixtures/external/
  codex-cli/*.jsonl        recorded transcripts (success, limit, auth, usage error)
  claude-cli/*.jsonl       recorded transcripts (success, not-logged-in, budget, resume)
```

Fixtures are the primary test substrate: every codec function is pure and is
exercised against recorded transcripts on machines with neither CLI installed.

## 3. Configuration

The feature is an opt-in capability resolved through `src/capability/`.

**Corrected in 0.2.0:** `src/capability/` is a *framework*, not a populated
gate — `CAPABILITY_REGISTRY` in `registry.ts:23` is an empty array, and the only
descriptor present is `REFERENCE_CAPABILITY_DESCRIPTOR`. This feature would be
the first real entry. T15 must therefore budget for registering a descriptor
against the `CapabilitySpec`/`CapabilityAdapter` seam in `seam.ts`, not merely
for reading a flag, and must confirm that the golden-rule and
no-optional-imports tests in that directory still pass with a populated
registry.

```jsonc
// user-global shell config
{
  "externalAgents": {
    "enabled": false,              // default; nothing spawns while false
    "spawnDecision": "ask",        // "ask" | "allow" — applies to model-initiated spawns
    "defaultTimeoutMs": 600000,
    "maxPromptBytes": 65536,       // single-argv ceiling; see §7.3
    "agents": {
      "codex-cli":  { "enabled": true, "model": null },
      "claude-cli": { "enabled": true, "model": null }
    }
  }
}
```

`model: null` means the CLI resolves its own default under the active
subscription — the runtime never pins a model the operator's account may not be
entitled to.

**Hard disable.** Regardless of configuration, the capability resolves to
unavailable when the active transport is remote (`keryx-remote-entry`,
`keryx-telegram-transport`) or CI is detected. The refusal is a named reason,
never a silent no-op.

## 4. Registry

An entry is metadata only. See
[schemas/external-agent-registry-entry.schema.json](schemas/external-agent-registry-entry.schema.json).

| Field | Meaning |
|---|---|
| `id` | Runtime id used in dispatch (`codex-cli`) |
| `label` | Display name for the TUI |
| `binary` | Executable resolved on `PATH` |
| `detect` | Argv that proves the binary exists (`["--version"]`) |
| `versionPattern` | Regex extracting a semver from the detect output |
| `knownGoodRange` | Version range the codec's fixtures were recorded against |
| `sandboxModes` | Sandbox levels **the CLI itself supports** — not what keryx has implemented |
| `streamingInput` | Whether the CLI accepts messages mid-run |
| `resumable` | Whether a killed session can be resumed by id |

Shipped entries:

| id | binary | sandboxModes | streamingInput | resumable |
|---|---|---|---|---|
| `codex-cli` | `codex` | `read-only`, `worktree-write` | no (resume only) | yes — requires **not** passing `--ephemeral`; see §5.1 |
| `claude-cli` | `claude` | `read-only`, `worktree-write` | yes | yes |

Both CLIs support a writable sandbox natively, so both declare it. **This is
deliberately not the release gate.** The registry records what the CLI can do;
what keryx has implemented is a separate refusal in §6.1. Keeping the two apart
means the two rejections have distinct, honest reasons — "this agent cannot do
that" versus "keryx does not do that yet" — instead of one masquerading as the
other.

`codex-cli` declares `streamingInput: false`: it has no documented mid-run input
channel, so operator messages are delivered by the resume path described in
§7.5. This asymmetry is registry data, and the supervision layer branches on it
rather than on the agent id.

## 5. Codec port

```ts
export interface ExternalAgentCodec {
  readonly id: string;

  /** Pure. Never spawns. The whole argv, including the prompt. */
  buildArgv(input: ExternalRunInput): readonly string[];

  /** Pure. One transcript line to zero or one canonical events. */
  parseLine(line: string): ExternalEvent | undefined;

  /** Pure. Null means the run succeeded; a string names the cause. */
  classifyFailure(outcome: ProcessOutcome): string | null;

  /**
   * Pure. Argv for delivering a message to a running or killed session.
   * `sessionRef` is the agent's resume handle — keryx ASSIGNS it for claude
   * (`--session-id`) but READS it for codex (`thread_id`, off `thread.started`).
   * The `input` parameter is unusable by the codex codec, since `codex exec
   * resume` cannot express any of its fields; that codec drops it and the cwd
   * becomes the spawner's responsibility (§5.1).
   */
  buildResumeArgv(sessionRef: string, message: string, input: ExternalRunInput): readonly string[];
}
```

Every function is total, side-effect free and testable without a subprocess.
`buildArgv` in particular is a named export with its own test, because the
reference implementation shipped a wrong flag for months and every run failed on
the command line before the agent was asked anything.

Codecs may export more than the port. `claude-cli` adds
`buildClaudeStreamingArgv` and `encodeClaudeStdinMessage` for the steerable
shape (§5.2). `codex-cli` adds a plural `parseCodexEvents`, because one
`turn.completed` line legitimately carries both a usage figure and the terminal
event; the port's singular `parseLine` returns the terminal one, since returning
`usage` instead would make every successful run classify as "transcript ended
without a terminal event".

### 5.1 `codex-cli` argv

```text
codex exec --json --color never -s <codex-sandbox> -C <worktree>
           --ignore-user-config --skip-git-repo-check
           [--output-schema <result-schema-path>]
           [-m <model>]
           <prompt>
```

**`<codex-sandbox>` is a translation, not keryx's own word** (added in 0.4.0).
`codex exec -s` accepts `read-only | workspace-write | danger-full-access`.
keryx's vocabulary says `worktree-write`, which codex has never heard of and
rejects with `error: invalid value` — the class of failure that killed every run
of the reference implementation on the command line before the agent was asked
anything. The codec maps `read-only → read-only` and
`worktree-write → workspace-write`; `danger-full-access` is unreachable. Dormant
today because only `read-only` is implemented, and a latent command-line failure
the moment it is not.

`--ignore-user-config` keeps the operator's codex profile out of the run.
`--output-schema` requests the structured result. The prompt is last and is a
single element.

**`--ephemeral` is deliberately absent (corrected in 0.3.0).** 0.1.0 specified
it, to keep session files off disk. It is mutually exclusive with resume: a
thread started ephemerally fails `codex exec resume` with `no rollout found for
thread id … (code -32600)`, captured in
`fixtures/external/codex-cli/resume-refused-ephemeral.stderr.txt`. Resume is
what makes operator messages (R18) and `force` (R20) work for this agent, so
persistence wins and the run leaves a rollout in the operator's `CODEX_HOME`,
exactly as a hand-run `codex` does. Redirecting `CODEX_HOME` to a temporary
directory is **not** an escape: `--ignore-user-config`'s own help states auth
still resolves from `CODEX_HOME`, so moving it loses the subscription.

**`codex exec resume` takes a narrower flag set than `codex exec`** — no
`-s/--sandbox`, no `-C/--cd`, no `--color`:

```text
codex exec resume <thread_id> --json --ignore-user-config --skip-git-repo-check
                  <prompt>
```

Two consequences the runtime must honour. The sandbox level cannot be re-asserted
on resume, so it is inherited from the resumed session and the worktree is doing
the containment work (§7.2, D-08). And the working directory cannot be passed as
a flag, so a resume must be spawned with its **process cwd set to the worktree**.

### 5.2 `claude-cli` argv

**There are two invocation shapes and they are not interchangeable (corrected in
0.4.0).**

*One-shot* — positional prompt, stdin ignored, **not** steerable:

```text
claude -p --output-format stream-json --verbose
       --safe-mode
       --tools <ALLOWED...>
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       [--max-budget-usd <n>] [--json-schema <result-schema>] [--add-dir <worktree>] [--model <m>]
       --session-id <uuid>
       <prompt>
```

*Streaming* — steerable; **no positional prompt**, the prompt and every later
operator message arrive on stdin:

```text
claude -p --output-format stream-json --input-format stream-json --verbose
       …same containment flags…
       --session-id <uuid>
```

with each stdin line being

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

**Why the split, and why 0.1.0–0.3.0 were wrong.** Those versions prescribed
`--input-format stream-json` *together with* a positional prompt. Measured on
2.1.220: the CLI **ignores the prompt**, waits for JSON on stdin, and with stdin
closed **exits 0 having written zero bytes to stdout and stderr**. No error, no
transcript, every process-level signal reporting success — the hardest failure
shape there is. The empty output is kept as
`fixtures/external/claude-cli/empty-output.stdout.jsonl` precisely because a
classifier keyed on exit code or stderr sees nothing wrong; the only signal is
the absence of a terminal event.

The operational consequence is that **steerability is chosen at spawn time.** A
one-shot run cannot later be sent a message, because the flag that would accept
one also forbids the positional prompt that started it. §7.5's delivery path for
`streamingInput: true` therefore requires the run to have been launched in
streaming mode; otherwise messages fall back to the resume path.

Constraints the argv test pins:

- `--tools`, `--mcp-config`, **`--add-dir`** and `--disallowed-tools` are
  **variadic**, so the prompt must never sit directly behind one. This is not
  theoretical: a probe that placed the prompt after `--mcp-config` failed with
  `MCP config file not found: …/Rep` — the CLI had taken the prompt's first word
  as a file path. A single-valued flag must separate them, and
  `--session-id <uuid>` is chosen for the job rather than `--model`, because the
  model is deliberately left unpinned (§3) while a session id is always assigned.
  When no session id is available the codec falls back to trailing the
  zero-valued `--strict-mcp-config` instead, and never invents a uuid — two
  concurrent runs sharing one would corrupt each other's history.
  (`--add-dir` was missing from this list before 0.4.0; `claude --help` on
  2.1.220 declares it `--add-dir <directories...>`.)
- `--verbose` accompanies `stream-json` under `-p`; the combination above was
  confirmed accepted.
- **`--safe-mode`** disables the operator's customisations — CLAUDE.md, skills,
  plugins, hooks, MCP servers — while leaving auth, model selection, built-in
  tools and permissions normal. It is **not** `--bare`, which would force
  API-key auth and defeat running on the subscription. Measured effect: without
  it the probe emitted `system/hook_started` and `system/hook_response` events
  because the operator's `SessionStart` hooks ran inside the child, and exposed
  ~130 slash commands; with it, no hook events and 46 built-ins.

`--permission-mode plan` is **not** used. It injects the vendor's own plan
workflow into the system prompt, causing the agent to answer with a
plan-approval request — exit 0, non-empty output, and therefore indistinguishable
from a successful run. Read-only is enforced by §5.3 and §7.2 instead.

### 5.3 Tool roster (`claude-cli`) — allow-list, corrected in 0.2.0

**`--tools` is an allow-list over the built-in roster and it works.** Probed
live: `--tools Read Grep Glob` produced `system/init` reporting exactly
`["Glob","Grep","Read"]`. That is the roster the model is offered, so anything
the CLI gains in a future version is **excluded by default** — the opposite of a
deny-list's failure mode.

```text
--tools Read Grep Glob
```

This supersedes 0.1.0's deny-list, which was inherited from a reference
implementation whose measured lesson concerned **`--allowed-tools`** — a
permission-rule flag that indeed does not restrict the roster. `--tools` is a
different flag and was never tested there. The two must not be conflated.

The ground truth that motivated the correction: with only
`--disallowed-tools Bash Edit Write Task`, the probe's `system/init` still
offered 27 tools, including `Monitor`, `NotebookEdit` (a write tool),
`Workflow`, `Skill`, `TaskCreate`/`TaskUpdate`/`TaskStop`, `WebFetch`,
`WebSearch`, `CronCreate`, `RemoteTrigger`, `SendMessage`, `ScheduleWakeup` and
`ToolSearch`. A deny-list would have to enumerate all of them, correctly, and
again after every release.

`--disallowed-tools` may still be passed as a redundant second layer, but it is
not the mechanism and its list is not required to be complete. MCP tools are
excluded separately by `--strict-mcp-config` with an empty config, confirmed by
`mcp_servers: []` in the same probe.

Neither flag is the guarantee. §7.2's worktree remains that, because a tool
roster governs which tools exist, not what the model does with the ones it has.

## 6. Data contracts

### 6.1 `runtime` block on `subagent-dispatch`

Additive and optional; absence means the native keryx runtime, so every existing
dispatch remains valid. See
[schemas/external-agent-runtime.schema.json](schemas/external-agent-runtime.schema.json).

```jsonc
"runtime": {
  "kind": "external",          // "keryx" | "external"
  "agent": "codex-cli",        // required when kind = "external"
  "sandbox": "read-only"       // "read-only" | "worktree-write"
}
```

**Validation (pure, fail-closed).**

- `kind: "external"` requires `agent` to resolve in the registry.
- `sandbox` must appear in that entry's `sandboxModes`.
- `sandbox: "read-only"` is rejected when `allowed_actions` contains `write`,
  `network`, or `spawn-subagent`.
- `sandbox: "worktree-write"` is schema-valid and **refused at runtime** in this
  release with the reason `worktree-write is not implemented in this release`.

### 6.2 Canonical event mapping

Vendor events are folded onto the existing `agent-event` contract so
`reduceAgents` and `reduceState` consume external children unchanged.

Observed event types, captured live in T1 (codex 0.147.0, claude 2.1.220):

- **codex** — `thread.started` (carries `thread_id`, which is the resume handle:
  codex generates it, keryx does not assign it), `turn.started`,
  `item.completed`, `turn.completed` (`usage` carries `input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
  `reasoning_output_tokens` — more than 0.1.0 assumed), `turn.failed`.
- **claude** — `system/init` (very large: it enumerates the tool roster and
  every slash command, so the first event can be multiple KB and the parser must
  not assume a small line), `system/hook_started` and `system/hook_response`
  when the operator's hooks run (suppressed by `--safe-mode`),
  `rate_limit_event`, `assistant`, `user`, `result` (`subtype`, `is_error`,
  `num_turns`, `total_cost_usd`, `result`).

`num_turns` has **no canonical home** and is deliberately not carried: the
`usage` event holds tokens and cost only. It survives in a failure message where
one is produced, and is lost on a successful run. R26 asks for turn count in the
TUI, so either `usage` gains a `turns` field in a later release or that
requirement is met from the raw transcript the modal already renders — flagged
rather than silently dropped.

`rate_limit_event` appears on **healthy** runs (it is present in the captured
success transcript), so it must not be folded to `retry`; doing so would inflate
the retry-derived drift and no-progress signals on runs that are fine. It is
recognised-but-unmapped, which the codec keeps distinct from "did not parse" so
the parse-skip counter stays a real version-drift signal.

| Canonical | `codex-cli` | `claude-cli` |
|---|---|---|
| `child_started` | `thread.started` (capture `thread_id` for resume) | `system` (`subtype: init`) |
| `tool_call` | `item.completed` where `item.type = command_execution` | `assistant` block `tool_use` |
| `tool_result` | following `item.completed` payload | `user` block `tool_result` |
| `assistant_text` | `item.completed` where `item.type = agent_message` | `assistant` block `text` |
| `thinking` | — | `assistant` block `thinking` |
| `usage` | `turn.completed.usage` | `result.usage`, `result.total_cost_usd` |
| `child_finished` | `turn.completed` | `result` |
| `child_failed` | `turn.failed` | `result` with `is_error` |
| `user_message` | synthesised on operator delivery (§7.5) | synthesised on operator delivery |

A line that does not parse is skipped and counted. A transcript that yields no
`child_finished` and no `child_failed` produces `SubagentCompletionStatus:
"Error"` with the cause `transcript ended without a terminal event`.

**Retry noise is not failure (added in 0.3.0).** Both CLIs emit repeated
non-terminal error events while retrying, and a parser that treats the first one
as terminal will misreport every transient hiccup as a dead run:

- codex emits top-level `{"type":"error","message":"Reconnecting… n/5 …"}`. The
  captured no-credentials transcript contains **ten** of them, plus an
  `item.completed` in the middle, before the single terminal `turn.failed`.
- claude emits `system/api_retry`. The captured bad-credential transcript
  contains **eight** before its terminal `result`.

Only `turn.failed` (codex) and `result` (claude) are terminal. Every other error
event maps to a counted `retry` observation that feeds the version-drift and
no-progress signals, never to a completion status.

`result.subtype` is the claude terminal discriminator: `success` versus
`error_during_execution`. It is read in preference to `is_error`, which is
retained only for backward compatibility.

### 6.3 Result

The structured result is requested through the CLI's own schema flag and
validated against `subagent-result`. Free text outside the schema passes
`quarantineChildSummary` and `keryx security check-output` before it reaches the
parent's context. A schema-invalid result is `Error`, not a silent downgrade to
prose.

## 7. Behaviour

### 7.1 Lifecycle

1. Capability gate; refuse with a named reason when disabled or transport-barred.
2. Registry lookup, binary detection, version probe against `knownGoodRange`
   (out-of-range proceeds with a recorded warning).
3. Policy `decide()` on the spawn — `ask` by default for model-initiated spawns.
4. Ledger reservation through the existing `RemainingBudgetLedger`, including
   the `maxCostUnits` dimension where the CLI reports cost.
5. Worktree creation via `createGitWorktreePort`.
6. Prompt assembly (§7.3), environment construction (§7.4), spawn.
7. Stream pump: parse, emit canonical events, update the TUI session store,
   evaluate supervision triggers (§7.6).
8. Terminal event or timeout; raced kill; result extraction and validation.
9. Worktree removal — unconditional, including on every failure path.

### 7.2 Read-only containment

Three independent mechanisms, in increasing order of reliability:

1. the CLI's own sandbox flag (`-s read-only`, or the deny-list for `claude`);
2. the tool deny-list (§5.3);
3. the disposable detached worktree.

The third is the guarantee. The first two reduce noise and wasted turns.

### 7.3 Prompt assembly

The prompt is one argv element and carries, in order:

1. the **runtime directive** (see [agent-protocol.md](agent-protocol.md)), which
   must precede everything else;
2. the task and its acceptance criteria;
3. the operator's working diff, because a detached worktree checks out `HEAD`
   and therefore contains no uncommitted changes.

Total size is capped by `maxPromptBytes`. On overflow the diff is truncated —
never the directive and never the task — and the truncation is stated inside the
prompt and recorded as an event.

### 7.4 Environment

Built by copy-then-strip from the parent environment. Named removals and
prefix sweeps, with the rationale for each, are specified in
[security-policy.md](security-policy.md). `stdin` is never inherited: it is
either the streaming-input pipe or explicitly ignored, because a CLI that
inherits an open stdin announces that it is reading from it and waits.

### 7.5 Operator messages

Messages use the pure helpers in `src/tui/main-queue.ts`, generalised from a
single main queue to a queue per addressee. `remove` and `edit` are unchanged.

Delivery depends on registry data **and on how the run was launched**:

- `streamingInput: true` **and launched in streaming mode** (§5.2) — the message
  is written to the child's stdin as an `encodeClaudeStdinMessage` line.
- `streamingInput: true` but launched one-shot — no stdin route exists, so the
  message falls back to the resume path below. This is why steerability is a
  spawn-time decision and not a runtime one.
- `streamingInput: false` (codex) — the message is held until the run completes,
  then delivered by resuming the session.

`force` is kill plus resume: the process is terminated and restarted with
`buildResumeArgv(sessionRef, message, input)`. For claude keryx assigns the
session id, so the handle is known before the child says anything; for codex the
handle is `thread_id`, read off `thread.started`, so a run killed before that
event **cannot be resumed at all** and `force` degrades to a plain kill. Where
resume is available the restart retains prior context, so intervention costs a
process restart rather than the accumulated work.

Every delivery also emits a `user_message` canonical event, so the parent's
folded view reflects what the operator said (D-09).

### 7.6 Supervision

The parent agent does not receive the raw stream. It receives trigger-driven
updates derived from the fold:

| Trigger | Condition |
|---|---|
| `phase_changed` | first tool call, first assistant text, terminal event |
| `budget_threshold` | reported cost or elapsed time crosses a configured fraction |
| `no_progress` | no canonical event within a configured interval |
| `agent_asked` | assistant text classified as a question rather than work |
| `scope_drift` | tool call targets a path outside the dispatch's declared scope |

On any trigger the parent may inject a correcting message, kill the child, or
escalate to the operator. The operator's modal continues to render every event
regardless — rendering costs no tokens (D-10).

> **NOT IMPLEMENTED as of 0.4.0.** None of the five triggers exists in the
> codebase, and the folded view has no consumer: the parent agent currently
> receives an external child's result and nothing before it. The plumbing that
> would carry them does exist — the supervisor emits canonical events live
> through `onEvent`, and the operator surface already consumes that stream — so
> this is an unbuilt consumer rather than a missing seam. R15 is therefore
> **unmet**, and saying so here is the point: the rest of this section reads as
> shipped behaviour and is not.

### 7.7 Failure

`classifyFailure` returns a named cause; the runtime maps it to an existing
`SubagentCompletionStatus`. No fallback of any kind occurs (D-07).

| Cause | Status |
|---|---|
| binary absent, capability disabled, policy denied | `Denied` |
| credentials invalid or absent, quota or rate limit exhausted | `Denied` |
| argv rejected by this CLI version | `Error` |
| unparseable or terminal-event-free transcript | `Error` |
| wall-clock timeout, killed | `Timeout` |
| CLI-reported budget cap reached | `BudgetExhausted` |
| no canonical event past the no-progress interval | `NoProgress` |
| terminal event, schema-valid result | `Completed` |

Classifiers are per-codec and asymmetric by necessity. `codex exec` narrates
itself on stderr and prints the contents of files it reads, so its classifier
subtracts the prompt and considers only lines beginning `error`/`usage:`. Its
`error-word` fixture pins the trap: a **successful** run whose `agent_message` is
`error: nothing is actually wrong`, exit 0, terminal `turn.completed` present.

**Correction from T5 on the claude side.** 0.1.0 asserted, borrowed from a
reference implementation, that `claude -p` prints `Not logged in · Please run
/login` to stdout with exit code 0. **That did not reproduce on 2.1.220.** With a
bogus `ANTHROPIC_API_KEY` present, the captured transcript shows a normal
`system/init`, eight `system/api_retry` events, and then
`result.subtype = error_during_execution`. The practical position is worse than
the borrowed anecdote suggested — the failure is slow rather than immediate —
and the classifier keys on `result.subtype` plus the retry count, not on a
stdout string. The environment rule in
[security-policy.md](security-policy.md) §2.1 is unchanged and now rests on this
fixture rather than on the anecdote.

## 8. Surfaces

### 8.1 CLI

```text
keryx agents external list [--json]     registry entries, detection and version state
keryx agents external probe <id> [--json]   version probe only; spends no quota
```

`keryx agents monitor <events-file>` is unchanged and now folds external
children alongside native ones.

### 8.2 TUI

- External children appear in the subagent sidebar rendered by
  `paintSubagentSidebar`, visually marked with their runtime.
- Selecting one opens the shared `openModal` host with tabs **Work** (live
  structured transcript), **Meta** (agent, model, sandbox, session id, cost,
  turns, worktree path) and **Command** (the exact launch argv, plus the detach
  instruction for continuing by hand).
- `/delegate <agent> <task>` starts an operator-initiated run.
- Queue actions (`remove`, `edit`, `force`) apply to the focused addressee.

### 8.3 Skill and dispatch

`spawn_subagent` accepts the `runtime` block. A dispatch authored by a skill
carries it exactly as specified in §6.1; no separate authoring format exists.

## 9. Integration points

| Integration | Contract |
|---|---|
| `spawnChild` | unchanged; still the sole authorisation and contract builder (it executes nothing — see §1) |
| `SpawnSubagentToolDeps` | gains an optional `runChild` strategy; default is today's direct `runAgentTurn` call, so existing call sites are untouched |
| `RemainingBudgetLedger` | one shared ledger; cost dimension used where reported |
| `needsWorktree` / `WorktreePort` | existing predicate and port; real adapter already shipped |
| `quarantineChildSummary` | applied to all external free text before parent context |
| `keryx security check-output` | applied alongside quarantine |
| `reduceAgents` / `reduceState` | consume canonical events unchanged |
| `SubagentCompletionStatus` | reused verbatim; no new status values |
| `decide()` | gates every spawn, operator- or model-initiated |
| `src/capability/` | opt-in gate, deterministic refusal when unavailable |
| `src/tui/main-queue.ts` | pure helpers generalised to per-addressee queues |
| `src/tui/modal-host.ts`, `subagent-inspector.ts` | operator surface |

## 10. Acceptance criteria

- **AC1.** A dispatch with `runtime.kind = "external"` and `agent = "codex-cli"`
  validates against the extended schema; one with an unknown `agent` is
  rejected; and a `sandbox` absent from an entry's `sandboxModes` is rejected
  with the *agent-cannot* reason, exercised against a synthetic registry entry
  since both shipped entries declare both modes (§4). Pure, offline.
- **AC2.** `sandbox: "read-only"` combined with `allowed_actions` containing
  `write` is rejected with a named reason. Pure, offline.
- **AC3.** `sandbox: "worktree-write"` against a shipped entry passes both the
  schema and the `sandboxModes` check, and is then refused by the runtime with
  the *keryx-does-not-yet* reason — a different, distinguishable reason from
  AC1's. Pure, offline.
- **AC4.** Each codec's `buildArgv` output is asserted element-by-element,
  including that no prompt follows a variadic flag. No CLI required.
- **AC5.** Each codec parses its recorded fixtures into the canonical event
  sequence, and `reduceAgents` folds that sequence without modification.
- **AC6.** `classifyFailure` returns the correct cause for each recorded failure
  fixture: not-logged-in with exit 0, usage limit, rejected argv, empty output,
  and a successful exploration whose output happens to contain the word `error`.
- **AC7.** The environment builder removes every denied variable and every
  prefix-swept variable from a synthetic parent environment. Pure, offline.
- **AC8.** A run whose transcript contains write attempts leaves the repository
  working tree byte-identical, and the worktree is removed on every terminal
  path including thrown errors.
- **AC9.** With the capability disabled, or under a remote transport, every
  spawn entry point returns a named refusal and creates no process.
- **AC10.** An operator message emits a `user_message` canonical event and, for
  a `streamingInput: true` agent, is written to the child's stdin; for a
  `streamingInput: false` agent it is delivered through the resume argv.
- **AC11.** `force` produces the resume argv carrying the assigned session id
  and the operator's message.
- **AC12.** Supervision triggers fire on the fold, not on raw events: a fixture
  transcript of N events produces at most one update per trigger condition.
- **AC13.** A schema-invalid structured result yields `Error`, not prose.
- **AC14.** No failure path substitutes another runtime, another agent, or the
  parent's model, asserted by a test that fails every configured agent.
- **AC15.** `package.json` gains no runtime dependency.
