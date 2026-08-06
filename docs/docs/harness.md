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

## Tools are as capable as the CLI verbs they wrap

A metaproject tool exposes the arguments of the `keryx` verb behind it. This is a
rule and not an accident: a tool that can ask less than its own CLI teaches the
model to reach for `shell_exec` instead, and `shell_exec` is default-deny — so a
narrow tool turns into a stalled run rather than a slower one.

`graph_affected` therefore takes `depth` and `ranked` like `keryx gdgraph
affected`, `graph_symbol` takes `impact` and `depth`, `memory_search` takes the
verb's filters, `repomap` takes `budget` and `seed`, `wiki_ask` takes `k` and
`rerank`, and `search_code` takes a `flags` array carrying every ripgrep option
`keryx ctx rg` forwards — `-g`, `-t`, `-A/-B/-C`, `-i`, `-m`, `--max-depth`,
`--hidden`, `--no-ignore`, `--sort`, `-l`, `-c` and the rest — read from the one
table the CLI itself uses, so the two cannot drift apart.

One exception, and it is a deliberate one: `-e`/`--regexp` is expressed through
`search_code`'s `pattern` field rather than through `flags`. Supplying the pattern
by flag turns every positional operand into a path, and a review used exactly
that to read `~/.aws/credentials` through a `risk: "read"` tool that never
reaches an approver. `search_code` now passes the pattern as `--regexp=<pattern>`
itself and hands ripgrep exactly one operand: a root-confined path. There is no
operand left whose meaning a flag could change.

Each descriptor declares the verb it wraps and where that verb reads its options,
and a test extracts that verb's handler from the command source, follows it into
any module-level option table, and compares. Short flags count; an ambiguous
anchor is an error rather than a guess. Widening the CLI without widening the tool
fails the build.

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

## Tools without a terminal

`keryx harness run --tools` registers the read-only metaproject tools —
`search_code`, `graph_affected`, `memory_search`, `read_wiki` and the rest — on
the non-interactive door, so a scripted run can inspect a project instead of
answering from the prompt alone. Every one of them is `risk: "read"` and needs no
approval, so nothing about the flag reintroduces the stall it exists beside.

Two things it deliberately does not do. It is **off by default**: without
`--tools` the run registers nothing and behaves byte-for-byte as it did before.
And the tool results are **not fed back to the model** — the run records what was
called and what came back, for the script to read. `--tools` is for a caller that
wants the tool output; the agentic loop that reasons over it is `keryx shell`.
See [CLI reference](./cli-reference.md#harness-run-tools-opt-in-with---tools).

## The unattended posture

`keryx shell --unattended` runs to completion with nobody at the keyboard. It
exists because `keryx shell` could not: the shell benchmark of 2026-08-05
finished zero of five cases, so every number recorded against keryx measured a
stall rather than a capability.

The obvious implementation — a flag that approves everything — would have traded
away the one property that benchmark demonstrated. On case C1 keryx and opencode
ran the *same model*; opencode deleted the graph index and the health history,
keryx stopped.

### What it actually is

A **tool set**, not an approval policy:

```bash
keryx shell --unattended --provider anthropic --model <m> <<< "<prompt>"
```

Under it the shell registers only tools that declare `risk: "read"` *and* declare
that they need no approver. `shell_exec` is `risk: "shell"`, `spawn_subagent` is
`risk: "delegate"`, and `ask_user` is `risk: "read"` but blocks until a person
answers — so none of the three is built. A tool that declares no risk at all is
excluded too: the check is an equality against `read`, so a new tool is out until
someone says what it is.

The consequence is the design. When the model asks for `shell_exec`, the name
resolves to nothing in the registry, and no part of the pipeline has looked at the
command it wanted to run. There is no wrapper to miss, because there is nothing to
wrap.

That matters because three review rounds tried the other approach and three
review rounds were defeated. A destructive-command classifier let sixteen
dangerous commands through. An operator argv allowlist accepted `*`. A rule
requiring a literal command word and banning wildcards after wrapper words was
defeated by `timeout`, `setsid`, `stdbuf`, `flock`, `busybox` and eleven more, plus
shell escapes through `psql -c '\! …'`, `sqlite3 '.shell …'` and
`tar --to-command`. Each round's rule was better than the last; each round's
vocabulary was behind. The constraint that came out of it — **containment may not
be a list of forbidden command words** — is settled, and the corpus of everything
those rounds found ships as a permanent regression suite
(`src/harness/posture/unattended-corpus.ts`).

### Evidence

The posture is in the header and in the run record:

```
◆ keryx  anthropic/claude-x · agent · unattended:read-only · ~/proj
```

and the session summary gains `posture: "unattended:read-only"` and
`humanInterventions`. A supervised run writes neither field, and its header is
byte-for-byte what it always was — a test pins both, because the cheap way to make
an unattended posture look safe is to loosen the default it is measured against.

An unattended run never starts the full-screen renderer, even on a TTY: OpenTUI
drives its own input loop and would consume the piped stdin a scripted run feeds.

### Where the boundary is soft

Three honest limits, none of which the sections above should be read as covering.

**1. It is not a secrecy boundary.** `read_file` and `search_code` can read
anything *inside the project root*, `.env` included. The posture removes the
ability to change things and to reach outside the root. It does not classify what
is inside as sensitive, and it keeps no list of sensitive filenames on purpose —
that list is exactly the kind that is always one name behind.

**2. Two lists survive in `search_code`, and they are lists.**

- The forwarded ripgrep options (`src/lib/rg-options.ts`) are a *permit* list.
  An option it does not name is refused, so it fails closed: it can only ever be
  too narrow — a ripgrep option keryx has not reviewed is unavailable rather than
  inherited. It will be behind ripgrep, and that is the safe direction.
- The rejected options (`-e`, `--regexp`, `--follow`) are a *deny* list, and a
  deny list **will be incomplete**. Do not read "`--follow` is refused" as "the
  search cannot follow a symlink". The property that actually holds is
  positional: the tool appends `--no-follow` after everything the caller supplied,
  and ripgrep resolves the last occurrence of a boolean, so an alias nobody has
  thought of is still neutralised. The rejection is a courtesy that explains
  itself; the ordering is the guarantee.

**3. It is not the OS sandbox.** Nothing in the posture constrains the kernel.
That is the stronger option and it is already built (see
[Containment underneath](#containment-underneath)) — but its domain allowlist and
credential masking refuse to run on Linux, so a posture requiring it would fail
closed on the platform CI runs on. Right answer, wrong release.

### The widening path

Both alternatives were considered and deferred with reasons, rather than dropped:

| Mechanism | Why not this release |
|---|---|
| OS sandbox as the boundary | Strongest available, and it moves the guarantee to the kernel — but it fails closed on Linux today. |
| A literal, wildcard-free argv allowlist | Round 3 reached it and the wildcard-free case held. What defeated it was permitting wildcards at all. Gated on the corpus. |

Widening happens with the corpus as the gate, and only toward a mechanism that is
not a list.

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

- **`keryx serve` registers no tool.** Its production executor is a refusal, so a
  served turn is a single text turn. `keryx harness run` is no longer in this
  list — see below — and the interactive shell is where the full tool set runs.
- **No remote approvals.** A `keryx serve` turn whose decision is `ask` ends in a
  recorded denial. Run approval-requiring work locally through `keryx shell`.
- **No real replay.** See above — `validate-log` only.
- **No branch merge.** Reconcile by forking again from a shared ancestor.
