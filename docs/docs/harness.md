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

### Unattended runs

`keryx shell --unattended[=<profile>] [--unattended-allow "<pattern>"]…` declares
at launch that no operator is present. It does not add an authority; it changes
**who answers**. Two gates stand between the model's proposal and execution, and
a command has to pass **both**:

1. **The policy engine**, resolved as a non-interactive session — the fail-closed
   path property 3 above describes.
2. **An argv allowlist you supply.** Nothing runs unless a `--unattended-allow`
   pattern recognises it.

| Under the flag | Result |
|---|---|
| Read-only tool | Runs with no prompt (it never reaches an approver) |
| Command matching an `--unattended-allow` pattern, under a profile that allows its risk class | Runs, recorded as unattended |
| Command matching nothing on the allowlist | **Refused**, whatever the profile allows |
| Any command when no allowlist was supplied | **Refused** — the flag alone runs nothing |
| Risk class the profile marks `ask` | Refused — no approver means `deny` |
| Risk class the profile marks `deny` | Refused, terminally, exactly as without the flag |
| Command containing an unquoted shell metacharacter (`;` `&&` `\|` `` ` `` `$(` `<` `>` `&`) | Refused — a pattern match would say nothing about what `/bin/sh -c` then runs |
| Destructive or credential-touching action | Refused, and allowlisting it does not change that |
| `ask_user` | Refused — it fails rather than blocking on an answer nobody will give |

Allowlist patterns go through the same validator that refuses over-broad **saved**
permissions, and they are checked at launch rather than at run time. So
`--unattended-allow "git *"` does not start a run: its first token does not
constrain what would run, which is the property that makes it not a rule.
`bun test*` and `git status*` do.

**Why an allowlist and not a blocklist.** The destructive classifier
(`isDestructiveCommand`) is a heuristic, and its own module says it must never be
used to decide a command is safe. Left as the only barrier it allowed
`git clean -fdx` — benchmark case C1, the case keryx is otherwise praised for
refusing — along with `rm -rf <subdir>`, `find . -delete` and `cat .env`, because
a blocklist permits everything it has not thought of. The question is inverted
here: only what a pattern recognises may run, and the classifier is a second
refusal on top rather than the thing holding the line.

**What it does not do:** it does not approve everything, it cannot turn a `deny`
into an `allow`, an allowlist entry cannot unlock a destructive command, and it
does not touch the supervised default. Without the flag, a mutating call still
goes to a prompt and an absent approver is still a refusal.

An unattended launch also never opens a picker: it takes `--provider`/`--model`,
or the selection a previous interactive run saved, and refuses to start if it has
neither. `--unattended` with `--chat` is refused too — chat mode runs no tools, so
there is nothing for a posture to bound.

The posture is shown in the shell header for the whole run and written into the
session's `summary.json` (`posture: "unattended:<profile>"`, or `"supervised"`),
so evidence from an unattended run is distinguishable from a supervised one after
the fact.

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
