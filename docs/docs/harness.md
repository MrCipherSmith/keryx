# The agent harness

The harness is keryx's own agent runtime: the loop that lets a model operate on a
project through controlled tools, with a policy engine above it, an OS sandbox
below it, and an append-only record of what happened beside it.

This page is the feature-level tour. [Architecture](./architecture.md#the-agent-harness-and-the-two-tool-systems)
has the internals and the seam-by-seam citations; [CLI reference](./cli-reference.md#harness)
has every flag.

## Four doors, one set of rules

| Door | Command | Shape |
|---|---|---|
| CLI | `keryx harness run\|exec\|extension\|wave\|replay` | Scriptable, CI-facing, one prompt or one contained command per invocation |
| JSONL / RPC | `runViaRpc` (`src/harness/rpc.ts`) | The same assembly framed as JSON envelopes, for embedding rather than a CLI verb |
| Loopback HTTP | `keryx serve` | Authenticated, loopback-bound; a bot or another product drives turns |
| Interactive | `keryx shell` | A TUI on the same tool registry and the same policy profile |

CLI and RPC delegate to the same `runOffline`, so a transport cannot upgrade a
decision — framing carries data, the policy engine decides policy. The
interactive shell runs its own turn loop over the same registry and profile; it
is a different loop, not a different rulebook.

## Providers

`anthropic`, `ollama`, a deterministic offline `fake`, and the
OpenAI-compatible gateways: `openrouter`, `deepseek`, `zai`, `zai-coding`,
`cerebras`, `groq`, `moonshot`, `grok`. `keryx shell` offers the same set through
its picker, listing each with the environment variable it reads.

Swapping the model changes neither the loop, the tool registry, nor the policy.
The `fake` provider replays a recorded transcript, which is what makes the loop
testable with no network at all.

## Sessions

Sessions are **per project** — isolated by git root, or by absolute cwd outside a
repository — and durable on disk as JSONL:

- `context.jsonl` — the model window a resume loads
- `archive.jsonl` — the full audit log, which survives `/compact`

User messages and tool results are checkpointed immediately; streamed assistant
text is journaled at most every 300 ms and is flushed when a turn ends or is
interrupted. An interrupted turn therefore remains resumable with its latest
partial answer.

```bash
keryx shell -c                 # continue the last session in this project
keryx shell -r <id>            # resume by id, short id, or title
keryx sessions list            # newest first; forks are marked ↳
keryx sessions fork <id>       # branch a conversation
keryx sessions export <id>     # Markdown transcript
keryx sessions path            # where they live on disk
```

**Forking** creates a new session that starts from the source's context *and*
archive, with `parentSessionId` recording where it came from. The copy is a copy:
writing to the fork never touches its source, so you can take a conversation in a
second direction without losing the first. Merging branches is deliberately out of
scope.

Compaction (`/compact`) shortens the model window and keeps the archive intact —
an entry never disappears; the compactor raises `EvidenceDeletionError` if one
would.

## The policy engine — three answers, not two

`allow`, `ask`, `deny` over seven risk classes: read, write, shell, network,
credential, delegate, destructive. Path and command rules sit underneath. Shell
and destructive actions are default-deny.

Four properties are worth knowing before you rely on it:

1. **A hard deny is terminal.** No approval, role, or interactivity flips it.
2. **An approval authorizes exactly one action**, bound to that action's
   fingerprint, and a single-use grant is spent once consumed.
3. **Headless never silently allows.** An `ask` with no live approver becomes a
   `deny`, which is why a remote turn's recorded denial is correct rather than
   incidental.
4. **Structural safety runs before policy.** `guardAction` refuses malformed or
   unsafe shapes ahead of any allow/ask/deny question.

## Interactive session: ask / trust / auto

The properties above are unconditional — they hold for `keryx harness run`,
`keryx harness exec`, and `keryx serve` no matter what. `keryx shell` sits on
top of that same approval gate and adds a **session-level convenience layer**
with three modes: `ask` (default, unchanged), `trust` (safe calls run without
asking; a destructive one still asks), and `auto` (nothing asks except a
credentials-touching command, which no mode ever auto-approves). Set it with
`keryx shell --trust`/`--auto`, or the `/mode` command once inside a session.
Full reference, including exactly where the per-project default is stored:
[Choose an approval mode](guides/permission-modes.md).

This layer never reaches `harness run`/`harness exec`/`keryx serve` or the
MCP server — property 3 above (**headless never silently allows**) is
untouched by it.

## Containment underneath

The OS sandbox sits *below* the policy engine — Seatbelt on macOS, bubblewrap on
Linux — and is reached through `keryx harness exec`:

```bash
keryx harness exec --allow-env HOME --max-runtime-ms 30000 \
  --allowed-domains api.example.com --mask-env TOKEN@api.example.com \
  --tls-terminate -- ./script.sh
```

| Capability | macOS | Linux |
|---|---|---|
| Filesystem containment | yes | yes (`bwrap` on `PATH`) |
| Network off/on | yes | yes |
| Domain allowlist, credential masking, TLS termination | yes | **refuses to run** |

The Linux refusal is the point. A domain allowlist that quietly became "all
network" would be worse than one that says it cannot run, so a
`network: "restricted"` profile fails closed there — and it does so at the spawn
point, which means `KERYX_SANDBOX_ALLOW_UNSANDBOXED` cannot reach it. That escape
hatch still covers the case it was written for: a missing launcher, where running
uncontained is a degradation an operator knowingly accepts.

See [Limitations](./limitations.md#platform-support) for the full platform matrix.

## Evidence, redaction, and the completion gate

Every recorded tool result is scanned and redacted **before** it is persisted. A
failed scan blocks persistence entirely and emits only a reason — no preview, no
hash, no category. The scanner is the same deterministic floor `keryx security
scan` reports from: rules plus entropy, over the committed evaluation corpus.

Session history is append-only and content-addressed; entries are deep-frozen.

The completion gate is the single authority on whether a run passed. It reaches
`pass` only when **all** of these hold:

- every required gate reports `pass`
- every required evidence ref is present
- no undisposed blocker remains
- a final message was emitted

A final message alone never passes. The caller supplies the first two — a run
driven by a flow with frozen acceptance criteria states what it must show — and a
run with no requirements stated evaluates the last two, which is the right default
for an ad-hoc run with no flow behind it.

The gate **reports**; it never advances flow state itself. The single route from a
gate verdict into Task Manager is `ManagedFlowPort.completeFromGate`, and the
harness never writes `flow.json` — the policy engine denies that target even with
a matching approval.

## Child agents with budgets

Dispatch runs over the canonical `subagent-dispatch` / `subagent-result`
contracts, with a token budget per child and bounded parallel scheduling. The
child path accepts no `FlowService` and no filesystem handle, so nothing in it can
reach flow state structurally.

```bash
keryx agents monitor <events-file>    # offline fleet report over a recorded log
```

## External children: a vendor CLI as a child agent

keryx can hand a bounded, **read-only** piece of work to a coding CLI you already
have installed — `codex exec` or `claude -p` — as a child of this same harness.
The vendor's own client authenticates itself from its own configuration and does
the work on your subscription; keryx supplies the isolation, the budget, the
supervision and the completion. Two agents ship, described as data in one
registry, with a pure codec each owning that CLI's argv, its event vocabulary and
its failure classification.

**Nothing here has ever been run against a real vendor process.** The whole layer
is verified offline against recorded transcripts in `fixtures/external/`, on a
machine with neither CLI installed.

### Off by default, hard disabled where it matters

The switch that always applies is `externalAgents.enabled: true` in the user
config (`~/.local/share/keryx/auth.json`) — user-global, because a subscription
belongs to a person rather than to a checkout. Inside a `.metaproject/`
workspace the project must also have opted in, with `keryx init
--external-agents`; outside one — and `keryx shell` runs anywhere — the
user-global switch is the whole story, because a workspace that does not exist
cannot hold an opinion.

Above both sits a **hard disable** no configuration can flip: the capability
refuses outright on a remote transport, or when a CI marker is set. A
subscription reachable over a channel that reaches other people is the one thing
the vendors' terms unambiguously forbid, so that check runs before the config is
even read. Every refusal, on every layer, carries its own sentence — a silent
no-op would leave you believing an agent ran.

### keryx does not know whether you are logged in

It never opens a vendor credential store — not `~/.codex/auth.json`, not
Claude's, **not even to test whether a login exists**. Availability comes from
`--version` and exit codes and nothing else, so it has three states — installed,
not installed, and *not probed* — and the third is a real answer rather than a
placeholder. There is no tick and no "ready": `keryx agents external list` reads
*"installed, 0.147.0 (within the recorded range); login not verified — keryx
cannot know"*, and that last clause is the load-bearing half of the line.

A version outside the range the fixtures were recorded against is a **recorded
warning, never a refusal** — neither CLI publishes a stable event schema, so
hard-failing would break the feature on the vendor's next release. The count of
transcript lines the codec did not recognise is the real drift signal, and it is
reported per run.

**No vendor sanction is claimed.** keryx starts a client you installed and
already logged into, in the same relationship a terminal multiplexer has with it;
it obtains, stores, forwards and proxies no token, and consumes no subscription
tokens of its own. Whether a vendor considers headless third-party orchestration
of its own CLI acceptable is **not addressed by either vendor's published
terms**, and it is carried as an open risk rather than a settled question — see
the package's decisions (`docs/requirements/keryx-external-agent-runtime/decisions.md`
D-01) and security policy (`docs/requirements/keryx-external-agent-runtime/security-policy.md`
§7).

### What the child gets, and how it is asked for

The child runs in a **disposable git worktree** checked out at `HEAD`, removed on
every terminal path including a thrown error. Your uncommitted work travels in
the prompt as a diff, since that worktree does not contain it; on overflow the
diff is what gets cut — never the directive, never the task — and the cut is
stated inside the prompt. The environment is copied from the parent and then
stripped: `ANTHROPIC_*`, `CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and the
whole `CLAUDE_CODE_*` and `KERYX_*` namespaces, plus a nesting-depth marker added
afterwards and honoured **on entry**, so a keryx started from inside an external
child refuses to start another. The tool roster is restricted: `claude` runs with
`--tools Read Grep Glob`, an allow-list over the built-in roster rather than a
permission rule, and an empty strict MCP config.

`ANTHROPIC_API_KEY` is stripped to make the subscription *work*, not for secrecy:
with a key present the CLI initialises normally, retries, and then fails in a way
that looks like a network problem rather than a configuration one.

Execution is requested through an optional `runtime` block on the canonical
`subagent-dispatch` contract, which `spawn_subagent` also accepts as an optional
`runtime` parameter. An absent block means the native runtime, so every dispatch
authored before this existed stays valid.

```json
{ "kind": "external", "agent": "claude-cli", "sandbox": "read-only" }
```

A fail-closed validator enforces the three constraints the JSON Schema cannot —
the agent resolves in the registry, the sandbox is one that agent's own CLI
supports, and `read-only` does not contradict the dispatch's `allowed_actions` —
with distinct refusal codes, because *"this agent cannot"* and *"keryx does not
do this yet"* are different facts about the world. The hook runs **after**
admission: the budget ledger and the depth and child caps have already applied,
so there is no second spawn path and no second ledger.

### From the shell

```
/delegate <agent> <task>
keryx agents external list [--json] [--no-probe]
keryx agents external probe <id> [--json]
```

Both `agents external` subcommands are read-only and spend no quota — the only
process either starts is `--version`. Full reference:
[CLI reference](./cli-reference.md#agents-external).

External children appear in the subagent sidebar with a `⤳` marker and open a
modal with three tabs: **Work** (the live structured transcript, folded from the
vendor's own event stream), **Meta** (agent, model, sandbox, session handle,
cost, turns, tokens, worktree path, parse skips, warnings) and **Command** (the
exact launch argv, a copy-pasteable shell form, and how to detach). Missing
figures render as missing and never as zero; a run that announced no session
handle says so rather than offering a command that cannot work.

Messages to a running child use the existing queue semantics — `remove`, `edit`,
`force` — per addressee, and every delivery reports which route it actually took.
`claude` accepts messages on an open stdin channel, and `keryx shell` launches
its runs steerable so that channel exists; `codex` has no mid-run input channel
at all, so its messages can only travel by resume. Steerability is a spawn-time
decision and cannot be revisited: the flag that accepts a later message also
forbids the positional prompt a one-shot run starts with, so there is no
conversion afterwards.

`force` is **kill-plus-resume**, not an abort. Writing to a live stdin would
queue the message behind the turn already in flight, which is the opposite of
what `force` asks for, so the run is terminated instead and the resume command is
recorded. It costs a restart, not the accumulated work — and where no resume
handle was ever announced it degrades to a plain kill and says plainly that the
message was not delivered.

**keryx never spawns a resume itself.** It builds the exact resume argv through
the agent's own codec and shows it in the Command tab; running it in a real
terminal is yours to do. The worktree is gone by then, and the tab says so.

### What this deliberately does not do

- **No mutating external agents.** Read-only only. `worktree-write` is a valid
  contract value the runtime refuses with its own named reason — distinguishable
  from an agent that cannot do it — because its prerequisite is a credible audit
  boundary for writes, not more spawn machinery.
- **No supervision triggers.** The specification describes a folded,
  trigger-driven view of a *running* child for the parent agent. None of it is
  implemented: the parent receives the child's result and nothing before it.
- **`/delegate` does not pass the policy engine or the subagent admission
  ledger.** A recorded, reasoned amendment rather than an oversight; the model's
  own `spawn_subagent` path passes both.
- **No resume is ever spawned.** The argv is built and displayed for detaching by
  hand.
- **Nothing has been run against a real vendor process.** Every test drives a
  fake process port against recorded transcripts, so "works" here means "works
  offline against what the CLIs actually printed", not "proven end to end".

## Record and replay

```bash
keryx harness run --provider anthropic --model <m> --record run.json "<prompt>"
keryx harness replay --record run.json --write-fixture fixture.json
keryx harness replay --record run.json --fixture fixture.json
```

`--record` writes a run's replayable surface: five recomputable hashes — session
manifest, event log, tool registry, provider transcript, expected terminal state —
plus the run id, status and time. `replay` builds a fixture from a record and
validates it, or compares against a fixture you kept. A divergence prints a typed
mismatch naming the field and exits non-zero.

**This is `validate-log`, and the distinction matters.** It answers "does this
fixture still describe the run it was built from" — an integrity check. It does
**not** re-execute anything and cannot tell you whether the same prompt would
behave the same way today. Nothing is contacted: no provider, no tool, no network.
Re-execution against recorded results (`simulate-recorded-results`) is not
implemented.

## Extensions and waves

```bash
keryx harness extension --spec <path>    # one declared extension
keryx harness wave --spec <path>         # a declared multi-agent wave
```

Extension dispatch is the one path that reaches `checkApproval`, so a mutating
extension needs a grant bound to its action fingerprint.

## What the harness does not do yet

Stated here rather than left to be discovered:

- **No shipped path registers a tool.** Both production executors are refusals, so
  `keryx harness run` and `keryx serve` are single text turns today. The
  interactive shell is where tools actually run.
- **No remote approvals.** A `keryx serve` turn whose decision is `ask` ends in a
  recorded denial. Run approval-requiring work locally through `keryx shell`.
- **No real replay.** See above — `validate-log` only.
- **No branch merge.** Reconcile by forking again from a shared ancestor.
- **No mutating external children, and no supervision of a running one.** The
  external runtime is read-only, off by default, and has never been run against a
  real vendor process — see
  [what this deliberately does not do](#what-this-deliberately-does-not-do).
