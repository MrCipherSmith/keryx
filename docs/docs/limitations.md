# Limitations

Keryx is pre-1.0. The deterministic core (graph, wiki, memory, testing, health,
review, tasks and security) runs offline with no model provider, and that is
the part the product is built around. This page lists what is not there yet,
what each gap costs you, and what to use instead.

## Summary

| Limitation | Impact | Alternative |
|------------|--------|-------------|
| Linux sandbox has no domain allowlist | Domain-level egress rules, credential masking and TLS termination refuse to run on Linux | Filesystem containment and network on/off work on both platforms |
| Windows is unverified | The CLI is not exercised on Windows in CI, and there is no OS sandbox | Use macOS, Linux or WSL |
| Model commands need a credential | Four commands exit 1 without a provider; `wiki enrich` skips pages | Every other command is deterministic and offline |
| ripgrep is external | `keryx ctx rg` and the agent's code search exit non-zero without `rg` | Install ripgrep |
| No bundled embedding runtime | No semantic ranking in memory search | Lexical memory search is fully available |
| No bundled ML security classifiers | Detection is rules plus entropy | The deterministic detectors are evaluated in CI |
| No tools in the non-interactive harness | `keryx harness run` and `keryx serve` complete single text turns | `keryx shell` is where tools run |
| Remote approvals need a tool registry | The stock `keryx serve` registers no tools, so it raises no approvals | Run tool-using turns locally |
| Replay validates a log, it does not re-execute | A fixture check cannot tell you whether a run would behave the same today | Record and compare fixtures for integrity |
| Session branches never merge | A fork diverges permanently | Fork again from a shared ancestor |
| Shared Agent Context is experimental | Every call needs an explicit workspace id; its MCP tools work over stdio only; source reads need POSIX `openat` | `keryx workspace list`, then pass the id; use `keryx serve-mcp` over stdio |

## Commands that need a model credential

These commands add model-written text on top of deterministic data. Without a
configured provider credential they behave as follows (checked on 0.3.46 with
no keys in the environment):

| Command | Without a credential |
|---|---|
| `keryx test suggest <file>` | exits 1 |
| `keryx flow plan <id>` | exits 1 |
| `keryx memory reflect --narrate` | prints the deterministic part, then exits 1 |
| `keryx health explain <target> --narrate` | prints the deterministic part, then exits 1 |
| `keryx wiki enrich` | exits 0 and marks each page skipped |

```text
No credential for provider "anthropic" (set ANTHROPIC_API_KEY, or pass --provider <name>).
```

Nothing else in the CLI needs a provider. `--provider <name>` selects another
configured provider; see [Connect a model provider](guides/connect-a-provider.md).

## Optional AI features are not bundled

Two model-backed features ship without a runtime: semantic memory search and
the ML security detectors. Their runtime identifiers are empty in the release,
so enabling them is a code change, not a download. Both run on their
deterministic floor, which is the shipped and tested behaviour:

- **Memory:** lexical retrieval with indexing, deduplication, validity dates and
  module, entity and class filters.
- **Security:** rules plus entropy analysis, measured against a committed
  evaluation corpus (`keryx security eval --corpus all`).

## Code search needs ripgrep

`keryx ctx rg` and the shell's `search_code` tool run ripgrep. Without `rg` on
`PATH` they exit non-zero instead of falling back to a slower scan, so the
failure is visible.

```bash
brew install ripgrep      # macOS
apt install ripgrep       # Debian/Ubuntu
```

## Tree-sitter grammars are optional

The symbol and call graph needs tree-sitter grammars, which are not bundled.
Without them the file graph, affected sets, cycles, orphans and the repository
map all work; symbol extraction does not. `keryx gdgraph assets pull <id>`
downloads a pinned grammar.

## Platform support

| Platform | Status |
|----------|--------|
| macOS | Full support, including the complete OS sandbox: filesystem containment, network off, domain allowlist, credential masking and TLS termination. |
| Linux | Full core support. OS sandbox through `bubblewrap` (`bwrap` on `PATH`): filesystem containment and network on/off. The domain allowlist, credential masking and TLS termination **refuse to run** rather than fall back to full network. |
| Alpine, musl, BusyBox | No standalone binary; the npm launcher's shebang needs a full `env`. |
| Windows | The CLI is not exercised on Windows in CI, and there is no OS sandbox, so contained runs fail closed. |

The Linux refusal is deliberate: an allowlist that quietly became full network
access would be worse than one that says it cannot run. The refusal happens
where the process is spawned, so `KERYX_SANDBOX_ALLOW_UNSANDBOXED` cannot reach
it. That variable only lets a run proceed when no launcher is installed, as a
choice the operator makes knowingly. See the
[security model](concepts/security-model.md#os-sandbox) and the
[Linux verification runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/verification/linux-sandbox-verification.md).

## Scheduled agent tasks need the machine on

`keryx schedule` hands a confirmed task to the operating system's scheduler
(systemd user timers, launchd or cron). Keryx runs no daemon.

- **Missed runs.** A machine that is off or asleep misses runs. systemd and
  launchd run one catch-up run at the next boot or wake; cron runs none.
- **Logged out.** Without lingering enabled, a systemd user timer does not run
  while you are logged out. Keryx shows the linger state when you confirm the
  schedule and never enables it for you.
- **Platform.** The hardened unattended sandbox is Linux-only. A macOS schedule
  runs in `ask` mode with only the tools you granted.
- **Network.** A schedule's network is `off`, `full` or `allowlist`. `allowlist`
  is Linux-only; elsewhere it is refused with a reason, never replaced by `off`
  or `full`. It governs only the agent's own shell commands; the model call and
  granted tools run outside the sandbox on your network. Its limits:
    - A tool that ignores `HTTP_PROXY`/`HTTPS_PROXY` gets no network at all,
      which can look like `off`.
    - HTTPS passes through a blind `CONNECT` relay, so only the requested host
      is checked, not the TLS server name inside the tunnel.
    - DNS is resolved once, outside the sandbox, and the proxy connects to the
      address it checked. A domain that changes address is resolved fresh on
      each run.
    - HTTP/2 and WebSockets over the relay are not specially handled; most
      command-line tools use HTTP/1.1 and work.
- **The signing key.** Each confirmed schedule is signed with a per-machine key
  kept owner-only in your user config directory. A committed or forged schedule
  never runs, and a scheduled run cannot see the key because its sandbox hides
  your home directory. An interactive agent running as you in `trust` mode with
  an unrestricted shell could in principle read the key by spelling its path in
  a way the command check does not recognise. Every command that names the key,
  the schedule store or the scheduler unit directories asks first, so reading
  the key is an ask, not an impossibility.
- **The command check is text analysis.** It parses quoting, escapes, wrappers
  (`env -u`, `sudo`, `nohup`, `bash -c '…'`) and `cd` into a unit directory.
  A same-user shell in `trust` mode can still spell a command so no text check
  sees it. The gates behind it:
    - `keryx schedule add`, `resume` and `run` need an interactive terminal on
      stdin and stdout, even with `--yes`, so a pipe or an MCP or ACP client
      cannot create, re-enable or fire a schedule.
    - A Keryx started from an agent's shell inherits `KERYX_TOOL_CALL=1`, and
      its schedule commands refuse. Starting an interactive Keryx or a terminal
      driver around one, or typing into a running session through a terminal
      multiplexer, always asks and is never remembered.
    - Every stored schedule must carry this machine's signature, and resume
      re-checks it and every pinned binary. The timer runs the `keryx` binary
      recorded when you confirmed, and a `keryx` running from inside the project
      is refused when the schedule is drafted.

    An agent running as you in `trust` mode can still unset `KERYX_TOOL_CALL`
    in a way the check does not see. The check makes that an ask, and your
    answer is the boundary.
- **Script wrappers.** A pinned script wrapper and its interpreter cannot change
  without the schedule being refused, and it runs from an empty directory. What
  the wrapper reads from its own configuration in your home directory is
  outside what Keryx pins.
- **Binaries between checks.** A granted program is hashed at the start of a
  run, and its inode, size and modification time are checked again before every
  exec. The remaining window is the milliseconds between that check and the
  exec.

See [schedule](cli-reference.md#schedule) in the CLI reference.

## Remote approvals apply only where tools are registered

`keryx serve` accepts turns over an authenticated HTTP listener that binds to loopback by default.
A turn whose policy decision is `ask` becomes a durable pending approval that a
person answers once over `GET /v1/approvals` and `POST /v1/approvals/{id}`, or
locally with `keryx approvals`. Unanswered approvals deny at expiry. The stock
listener registers no tools, so it raises no approvals today; they become
reachable when a tool registry is supplied to the turn. Approval cards in chat
or web clients for these approvals, session-wide grants from a remote answer,
and approvals for unattended trigger runs are not built. See
[Answer a remote approval](guides/answer-remote-approvals.md).

A `keryx shell` session driven from a Telegram topic with `/remote-control` has
its own Allow and Deny buttons in the topic. That path has been exercised only
against a fake Bot API, not real Telegram. A topic holds at most 500
undelivered lines, and a batch whose update ids all collide with ones already
seen after Telegram renumbers its updates cannot be told from a redelivery and
is dropped.

What does hold:

- The remote policy profile is compared with the local one on every turn, and a
  weaker remote profile is refused.
- Authentication happens before routing, so an unauthenticated caller cannot
  tell a real path from a missing one.

## Harness gaps

Each is described on [the harness page](harness.md#what-the-harness-does-not-do-yet):

- **No non-interactive path registers a tool.** `keryx harness run` and
  `keryx serve` complete a single text turn. Tools run in `keryx shell`.
- **Replay validates a log.** `keryx harness replay` checks that a fixture still
  describes the run it came from. It re-executes nothing and contacts nothing.
- **Branches do not merge.** `keryx sessions fork` branches a conversation and
  records its ancestry; there is no merge back.
- **External agents mostly read.** Delegated agent CLIs are read-only, except
  the two with a reviewed write mode, and a running external agent is not
  supervised; the parent sees only its result.

## Format stability

The `.metaproject/` layout, artifact formats and CLI surface still change
before 1.0. `keryx update` refreshes managed files without touching your data,
and the [changelog](project/changelog.md) records what changed in each release.
