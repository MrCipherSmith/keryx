# The agent harness

The harness is Keryx's own agent runtime: the loop that lets a model work on a
project through controlled tools, with a policy engine above it, an OS sandbox
below it, and an append-only record of what happened beside it. `keryx shell`
is the interactive way in; this page covers the runtime under it.

[Architecture](architecture.md#the-shell-turn-loop) shows where the harness sits
in the code; the [CLI reference](cli-reference.md#harness) has every flag; the
[security model](concepts/security-model.md) puts its controls in context.

## Four doors, one set of rules

| Door | Command | Shape |
|---|---|---|
| Interactive | `keryx shell` | A terminal UI (or readline) with tools, sessions and approval prompts |
| CLI | `keryx harness run\|exec\|extension\|wave\|replay` | Scriptable and CI-facing: one prompt or one contained command per invocation |
| JSON lines | `runViaRpc` in `src/harness/rpc.ts` | The same run framed as JSON envelopes, for embedding rather than a CLI verb |
| HTTP | `keryx serve` | Authenticated; binds to loopback by default; a bot or a browser drives turns |

The CLI and JSON-lines doors share one run function, so a transport cannot
upgrade a decision: framing carries data, and the policy engine decides. The
interactive shell runs its own turn loop over the same tool registry and policy
profile; it is a different loop, not a different rulebook.

## Providers

| Provider id | Kind | Credential |
|---|---|---|
| `anthropic` | native | `ANTHROPIC_API_KEY` |
| `openai` | native | `OPENAI_API_KEY` |
| `gemini` | native | `GEMINI_API_KEY`, or `GOOGLE_API_KEY` |
| `openai-codex` | native | subscription login: `keryx auth login openai-codex` |
| `ollama` | native, local | none; loopback endpoint |
| `fake` | offline | none; replays recorded test transcripts only |
| `openrouter` | OpenAI-compatible | `OPENROUTER_API_KEY` |
| `deepseek` | OpenAI-compatible | `DEEPSEEK_API_KEY` |
| `zai`, `zai-coding` | OpenAI-compatible | `ZAI_API_KEY` |
| `cerebras` | OpenAI-compatible | `CEREBRAS_API_KEY` |
| `groq` | OpenAI-compatible | `GROQ_API_KEY` |
| `moonshot` | OpenAI-compatible | `MOONSHOT_API_KEY` |
| `grok` | OpenAI-compatible | `XAI_API_KEY`, or subscription login: `keryx auth login grok` |
| `github-copilot` | OpenAI-compatible | `GITHUB_COPILOT_TOKEN`, or subscription login: `keryx auth login github-copilot` |
| `rapid-mlx` | OpenAI-compatible, local (macOS only) | none; loopback endpoint |
| custom | OpenAI-compatible | added through the shell's provider picker |

`keryx shell` offers the same set in its picker, with the variable each one
reads; keys entered there are stored owner-only in your per-user config
directory. [Connect a model provider](guides/connect-a-provider.md) covers each
path.

Choosing a provider never opens a connection. A hosted provider with no
credential resolves to the offline `fake` provider instead of attempting a call,
so a missing key fails closed:

```bash
keryx harness run --provider fake --model fake "hello"
```

```text
{"events":[],"text":"","completion":{"status":"failed","passed":false,"reason":"FakeProvider: no transcript matches request hash …"},"evidence":[]}
```

Swapping the model changes neither the loop, the tool registry nor the policy.
Every full adapter normalizes to the same event stream, and one shared contract
test pins three edge cases identically across them: a stream that ends in the
middle of a tool call (an error naming the pending call, never an invented
result), an error inside the stream (classified like an error before it), and a
tool call with no id (a synthetic id, unique within the response).

## Turn budgets

Each user turn in `keryx shell` is bounded so a confused model cannot loop:

| Limit | Default | Override |
|---|---|---|
| Model round trips per user turn (one request and response, possibly with several tool calls) | 40 | `KERYX_AGENT_MAX_ROUNDS`, capped at 200 |
| Attempts of an identical tool call (same tool, same normalized input) | 3 | `KERYX_AGENT_MAX_ATTEMPTS_PER_HASH`, capped at 10 |

Up to three subagents from one turn run at the same time.

The limit counts rounds, not distinct tool calls, so a large task that does many
different things in few rounds is not cut short. Once a turn has used 80% of a
limit, the model is told how much is left and asked to return its result.

## Sessions

Sessions are **per project**, keyed by the git root (or the absolute directory
outside a repository), and stored on disk as JSONL:

- `context.jsonl`: the model window a resume loads.
- `archive.jsonl`: the full log, which survives `/compact`.

User messages and tool results are written immediately; streamed assistant text
is written at least every 300 ms and when a turn ends or is interrupted, so an
interrupted turn can be resumed with its latest partial answer.

```bash
keryx shell -c                 # continue the last session in this project
keryx shell -r <id>            # resume by id, short id, or title
keryx sessions list            # newest first; forks are marked ↳
keryx sessions fork <id>       # branch a conversation
keryx sessions export <id>     # Markdown transcript
keryx sessions path            # where they live on disk
```

**Forking** creates a new session that starts from the source's context and
archive and records its parent. Writing to the fork never touches the source.
Merging branches back is out of scope.

`/compact` shortens the model window and keeps the archive intact; compaction
fails rather than drop an archived entry.

## The policy engine — three answers, not two

The policy engine answers `allow`, `ask` or `deny` for each action, by risk
class: read, write, shell, network, credential, delegate, destructive. Path and
command rules sit underneath. The defaults come from the run's policy
profile: `harness run` denies write, shell and network; `harness exec` allows
shell and asks for write and network; `keryx serve` asks for write and shell
and denies network. Credential and destructive actions are never allowed
outright by any profile.

Four properties hold everywhere:

1. **A deny is final.** No approval, role or interactivity overturns it.
2. **An approval covers one action**, bound to that action's fingerprint, and a
   single-use grant is spent once used.
3. **Headless never silently allows.** An `ask` with nobody to answer becomes a
   `deny`. That is why a remote turn's recorded denial is correct, not an
   accident.
4. **Structural checks run first.** Malformed or unsafe action shapes are
   refused before the allow, ask or deny question is asked.

The engine also denies any write to a flow's state file, even with a matching
approval. Flow state changes only through `keryx flow` commands.

## Interactive session: ask / trust / auto

The properties above hold for `keryx harness run`, `keryx harness exec` and
`keryx serve` unconditionally. `keryx shell` adds a session-level layer on top
with three modes: `ask` (the default: shell commands, subagents and destructive
calls ask first), `trust` (only destructive calls ask) and `auto` (nothing asks
except a command touching Keryx's own credential files, which no mode
auto-approves). Set it with `keryx shell --trust` or `--auto`, or with `/mode`
inside a session. The `--auto` launch flag starts the session in auto directly, without the confirmation `/mode auto` shows. [Choose an approval mode](guides/permission-modes.md) is the
full reference.

The modes never reach `harness run`, `harness exec`, `keryx serve` or the MCP
server, so "headless never silently allows" is untouched by them.

## Containment underneath

The OS sandbox sits below the policy engine: Seatbelt on macOS, `bubblewrap` on
Linux. `keryx harness exec` runs one command inside it, and refuses to start a
real process at all without `--allow-real-subprocess`:

```bash
keryx harness exec --allow-real-subprocess --allow-env HOME --max-runtime-ms 30000 \
  --allowed-domains api.example.com --mask-env TOKEN@api.example.com \
  --tls-terminate -- ./script.sh
```

Without the flag nothing starts:

```text
keryx harness exec refuses to spawn a real subprocess without --allow-real-subprocess (or KERYX_ALLOW_REAL_SUBPROCESS=1); no process was started.
```

| Capability | macOS | Linux |
|---|---|---|
| Filesystem containment | yes | yes (`bwrap` on `PATH`) |
| Network off/on | yes | yes |
| Domain allowlist, credential masking, TLS termination | yes | **refuses to run** |

A domain allowlist that quietly became "all network" would be worse than one
that says it cannot run, so a restricted-network run fails closed on Linux, at
the point where the process is spawned. `KERYX_SANDBOX_ALLOW_UNSANDBOXED` cannot
change that; it only covers a missing launcher. Shell commands in
`keryx shell` are not sandboxed unless `KERYX_SANDBOX_SHELL` is set; see the
[security model](concepts/security-model.md#os-sandbox) and
[Limitations](limitations.md#platform-support).

## Evidence, redaction, and the completion gate

Every recorded tool result is scanned and redacted **before** it is stored. A
result that fails the scan is not stored at all; only the reason is, with no
preview, hash or category. The scanner is the same deterministic one
`keryx security scan` uses. Session history is append-only and
content-addressed.

The completion gate decides whether a run passed. It passes only when all of
these hold:

- every required gate reports `pass`;
- every required piece of evidence is present;
- no undisposed blocker remains;
- a final message was produced.

A final message alone never passes. A run driven by a flow supplies its
required gates and evidence from the flow's frozen criteria; an ad-hoc run with
no requirements is judged on the last two.

The gate **reports**; it never advances flow state itself. One port carries a
gate verdict into the task manager, and it performs no file write of its own.

## Child agents with budgets

Subagents are dispatched over the `subagent-dispatch` and `subagent-result`
contracts, each with a token budget, under bounded parallel scheduling and a
narrower credential scope than the parent. The child path is given no handle to
flow state or the filesystem, so it cannot change flow state.

```bash
keryx agents monitor <events-file>    # offline fleet report over a recorded log
```

## External children: a vendor CLI as a child agent

Keryx can hand a bounded piece of work to an agent CLI you already have
installed and logged into, as a child of this harness. The CLI authenticates
itself from its own configuration and works on your subscription; Keryx
supplies the isolation, the budget, the supervision and the completion. Each
agent is one registry entry with its own command-line arguments, event parser
and failure classification.

| Agent id | Transport | Write mode | Live run recorded |
|---|---|---|---|
| `claude-cli` | line stream | yes, reviewed | completed with version 2.1.280 |
| `codex-cli` | line stream | yes, reviewed; needs ≥ 0.159.2 and < 0.160.0 | 0.159.0, failure path only (usage limit) |
| `antigravity-cli` | line stream | refused | completed with version 1.2.12 |
| `gemini-acp` | ACP, with Keryx as the client | through ACP file requests | none |

The default tests replay recorded transcripts offline. The live transcripts
are in `fixtures/external/live/`, each with its version.
`KERYX_LIVE_EXTERNAL=1` runs tests against real processes.

### Turning it on

External agents are off by default. `keryx agents external enable` turns them on
for your user; inside a project, the project must also opt in with
`keryx init --external-agents`. Above both sits a hard disable that no
configuration changes: the capability refuses on a remote transport or when a
CI marker is set. Every refusal names its reason.

`antigravity-cli` needs more before its first run. Its CLI sends prompts and
agent actions to its vendor by default, so the first dispatch at a real
terminal asks for your consent and records it; a non-interactive dispatch
without recorded consent is refused. It is also on the default
[`/external`](concepts/security-model.md#network-egress-and-external) block
list. In headless mode it denies any tool call it cannot ask about and still
reports success; Keryx reads those denials and reports the run as `Denied`.

### Keryx does not check your login

Keryx never opens an agent's credential store, not even to test whether a login
exists. Availability comes from `--version` and exit codes only, so it has
three states: installed, not installed and not probed.
`keryx agents external list` says "login not verified — keryx cannot know". A
version outside the recorded range is a warning, not a refusal; the count of
unrecognised output lines per run is the drift signal.

### What the child gets

The child runs in a **disposable git worktree** at `HEAD`, removed on every
exit path. Your uncommitted work travels in the prompt as a diff; if the prompt
is too long, the diff is cut, never the task, and the cut is stated.

The environment is copied from the parent and then stripped: `ANTHROPIC_*`,
`CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the `CLAUDE_CODE_*` and
`KERYX_*` namespaces, and every credential-shaped variable (`SSH_AUTH_SOCK`,
`GIT_ASKPASS`, cloud credential files, `GITHUB_TOKEN`, other providers' keys),
except the key the target CLI signs in with (`OPENAI_API_KEY`,
`GEMINI_API_KEY`, `GOOGLE_API_KEY`). A nesting marker stops a Keryx started
inside a child from starting another. A read-only `claude-cli` child gets only
the read, grep and glob tools and no MCP servers.

A dispatch asks for this runtime through an optional `runtime` block, which
`spawn_subagent` also accepts. A missing block means the native runtime.

```json
{ "kind": "external", "agent": "claude-cli", "sandbox": "read-only" }
```

The block is validated before anything starts: the agent must exist, the
sandbox must be one that agent supports, and `read-only` must not contradict
the dispatch's allowed actions. "This agent cannot" and "Keryx does not do this
yet" get different refusal codes. The external run starts after admission, so
the budget ledger and the depth and child caps already apply.

### From the shell

```text
/delegate <agent> <task>
keryx agents external list [--json] [--no-probe]
keryx agents external probe <id> [--json]
keryx agents external run <id> --task "<text>" [--unattended] [--write]
keryx agents external review <run-id>
keryx agents external apply <run-id> [--allow-flagged]
keryx agents external discard <run-id>
```

`list` and `probe` start only `--version` and spend no quota. `run` drives
either transport on the same worktree and gates. For an ACP agent, its
permission questions go through Keryx's approval gate in `ask` mode, and its
file requests are served inside the worktree; see the
[ACP client guide](guides/acp-client.md).

In the shell, external children appear in the subagent sidebar with a `⤳`
marker. Their modal has three tabs: the live transcript, the metadata (agent,
model, cost, tokens, worktree, warnings) and the exact launch command with how
to detach. A message to a running child is delivered on its open input channel
where the CLI has one, or by resume where it does not. `force` stops the run
and records the resume command; Keryx never spawns a resume itself.

### Write mode for `claude-cli` and `codex-cli`

`keryx agents external run claude-cli --task "<text>" --write` (or `codex-cli`)
runs the agent in a throwaway worktree cut from the current commit.

- `claude-cli` gets only read, grep, glob, edit and write tools: no shell, no
  network, no MCP server.
- `codex-cli` runs in its own operating-system sandbox with workspace writes
  only, `/tmp` excluded, network off and your own exec-policy rules ignored.
  Measured in a scratch repository: writes outside the worktree fail, DNS fails,
  and `.git` is read-only. It keeps a sandboxed shell that can read any file
  your account can read, so review the output as well as the diff. Keryx
  refuses a write run unless the installed version is at least 0.159.2 and
  older than 0.160.0, because a newer release may ignore an unknown setting
  silently.

The worktree's diff is captured, secret-redacted, hashed and stored as a
pending review; nothing reaches your checkout. `review <run-id>` shows it.
`apply <run-id>` needs a real terminal, shows the diff and asks you to type the
first 12 hex digits of the patch hash, then creates a new local branch
`external/<run-id>` with one commit. Your branch, index and working tree are not
touched, nothing is pushed and no pull request is opened. `discard <run-id>`
drops it. In the shell, `/external-diff` opens the review.

[Let an external agent write](guides/external-agent-write.md) has the full flow.

### What this deliberately does not do

- **Only two agents write, and a human is the only review.** `antigravity-cli`
  refuses write mode because its edit tool was seen writing outside the working
  directory. There is no model review of the diff and no auto-approve.
- **No supervision of a running child.** The parent receives the child's result
  and nothing before it.
- **`/delegate` bypasses the policy engine and the admission ledger.** That is a
  recorded decision; the model's own `spawn_subagent` path passes both.
- **No resume is ever spawned.** The command is shown for you to run.
- **A read-only `codex-cli` child honours your own exec-policy rules**, so a
  rule that allows a command can still run it outside the sandbox there.

## Record and replay

```bash
keryx harness run --provider anthropic --model <model> --record run.json "<prompt>"
keryx harness replay --record run.json --write-fixture fixture.json
keryx harness replay --record run.json --fixture fixture.json
```

`--record` writes a run's replayable surface: five hashes (session manifest,
event log, tool registry, provider transcript, expected end state) plus the run
id, status and time. `replay` builds a fixture from a record and validates it,
or compares it with a fixture you kept. A difference prints the mismatched field
and exits non-zero.

This is a **log integrity check**. It answers "does this fixture still describe
the run it came from". It does not re-execute anything, contacts no provider,
tool or network, and cannot tell you whether the same prompt would behave the
same way today.

## Extensions and waves

```bash
keryx harness extension --spec <path>    # one declared extension
keryx harness wave --spec <path>         # a declared multi-agent wave
```

Extension dispatch is the one path that checks stored approvals, so a mutating
extension needs a grant bound to its action fingerprint.

## What the harness does not do yet

- **No non-interactive path registers a tool.** `keryx harness run` and
  `keryx serve` complete single text turns. Tools run in `keryx shell`.
- **Remote approvals need a tool registry.** A `keryx serve` turn whose decision
  is `ask` becomes a durable approval answered once over HTTP or with
  `keryx approvals`, but the stock listener registers no tools, so it raises
  none. See [Answer a remote approval](guides/answer-remote-approvals.md).
- **No real replay.** Replay checks a log; it does not re-execute.
- **No branch merge.** Fork again from a shared ancestor instead.
- **Limited external writes and no supervision.** External agents are read-only
  except the two reviewed write modes, are off by default, and have little live
  history; see [what this deliberately does not do](#what-this-deliberately-does-not-do).
