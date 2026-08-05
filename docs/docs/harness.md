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
