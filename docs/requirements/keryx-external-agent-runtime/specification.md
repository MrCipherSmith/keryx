# Specification: Keryx External Agent Runtime
Version: 0.1.0

## 1. Identity

| Field | Value |
|---|---|
| Package | `keryx-external-agent-runtime` |
| Capability id | `external-agent-runtime` |
| Runtime ids | `codex-cli`, `claude-cli` |
| Source root | `src/harness/external/` |
| Contract owner | `.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json` |
| Status | specification ready (future) — nothing below is implemented |

The runtime is a second implementation behind `spawnChild`. It does not
introduce a parallel spawn path, a parallel budget, or a parallel event stream.

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
| `codex-cli` | `codex` | `read-only`, `worktree-write` | no (resume only) | yes |
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

  /** Pure. Argv for delivering a message to a running or killed session. */
  buildResumeArgv(sessionId: string, message: string): readonly string[];
}
```

Every function is total, side-effect free and testable without a subprocess.
`buildArgv` in particular is a named export with its own test, because the
reference implementation shipped a wrong flag for months and every run failed on
the command line before the agent was asked anything.

### 5.1 `codex-cli` argv

```text
codex exec --json --color never -s read-only -C <worktree>
           --ignore-user-config --ephemeral
           --output-schema <result-schema-path>
           [-m <model>]
           <prompt>
```

`--ignore-user-config` and `--ephemeral` keep the operator's own codex profile
and session history out of the run. `--output-schema` requests the structured
result. The prompt is last and is a single element.

### 5.2 `claude-cli` argv

```text
claude -p --output-format stream-json --input-format stream-json --verbose
       --disallowed-tools <DENIED...>
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       --session-id <uuid>
       --max-budget-usd <n>
       --json-schema <result-schema>
       --add-dir <worktree>
       --model <model>
       <prompt>
```

Two constraints the argv test must pin, both learned from measured failures:

- `--disallowed-tools`, `--mcp-config` and `--tools` are **variadic**. The
  prompt must never sit directly behind one, or it is consumed as another value.
  A single-valued flag (`--model`) is placed last as the separator.
- `--verbose` accompanies `stream-json` under `-p`. The exact accepted
  combination is pinned by the argv test against the known-good version range
  rather than assumed stable.

`--permission-mode plan` is **not** used. It injects the vendor's own plan
workflow into the system prompt, causing the agent to answer with a
plan-approval request — exit 0, non-empty output, and therefore indistinguishable
from a successful run. Read-only is enforced by §7.2 instead.

### 5.3 Denied tools (`claude-cli`)

The deny-list must name **delegation routes**, not only direct effects, because
an agent denied `Edit` can still reach a shell through a monitoring tool and a
subagent through a task tool:

```text
Bash, Edit, Write, NotebookEdit,
Task, Agent, Workflow, Skill, Monitor,
WebFetch, WebSearch,
EnterWorktree, ExitWorktree, RemoteTrigger,
CronCreate, CronDelete, PushNotification, SendMessage,
TaskCreate, TaskUpdate, TaskStop, Artifact
```

`--allowed-tools` is not used as a restriction: it does not act as one. Anything
the CLI gains in a later version is permitted by default; that is the standing
cost of a deny-list and the reason §7.2's worktree, not this list, is the
guarantee.

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

| Canonical | `codex-cli` | `claude-cli` |
|---|---|---|
| `child_started` | first event on the stream | `system` (`subtype: init`) |
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

Delivery depends on registry data:

- `streamingInput: true` — the message is written to the child's stdin as a
  user message at the next turn boundary.
- `streamingInput: false` — the message is held until the run completes, then
  delivered by resuming the session.

`force` is kill plus resume: the process is terminated and restarted with
`buildResumeArgv(sessionId, message)`. Because keryx assigns the session id, the
restart retains prior context, so intervention costs a process restart rather
than the accumulated work.

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

### 7.7 Failure

`classifyFailure` returns a named cause; the runtime maps it to an existing
`SubagentCompletionStatus`. No fallback of any kind occurs (D-07).

| Cause | Status |
|---|---|
| binary absent, capability disabled, policy denied | `Denied` |
| not logged in, quota or rate limit exhausted | `Denied` |
| argv rejected by this CLI version | `Error` |
| unparseable or terminal-event-free transcript | `Error` |
| wall-clock timeout, killed | `Timeout` |
| CLI-reported budget cap reached | `BudgetExhausted` |
| no canonical event past the no-progress interval | `NoProgress` |
| terminal event, schema-valid result | `Completed` |

Classifiers are per-codec and asymmetric by necessity: `codex exec` narrates
itself on stderr and prints the contents of files it reads, so its classifier
subtracts the prompt and considers only lines beginning `error`/`usage:`;
`claude -p` prints its login refusal to stdout with exit code 0, so "exit 0 and
non-empty output means success" must be checked *after* that refusal, not before.

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
| `spawnChild` | external runtime is a second implementation, not a new path |
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
