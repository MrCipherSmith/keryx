# Brainstorm: External Agent CLI as a Child Runtime
Version: 0.1.0

## Status

Decision history from the 2026-08-19 brainstorm + interview. Nine forks were
put to the operator with options and a recommendation; all nine were resolved.
This file records the reference designs studied, the options considered, and
why each fork went the way it did — so a later reader gets the reasoning rather
than an unexplained shape. README, PRD and specification are built from this.

## Problem

Let keryx delegate work to the vendors' own coding CLIs — `codex exec` and
`claude -p` — as child agents, so the operator's existing subscription does the
heavy lifting while keryx's own model supervises, corrects, and keeps its
fail-closed invariants. The operator's framing: *"он сам всё может делать, но по
нашим политикам"*.

## Compliance boundary (why this is not `provider-auth` D-01)

`docs/requirements/keryx-provider-auth/decisions.md` D-01 refuses subscription
OAuth: Anthropic's Consumer Terms forbid using Free/Pro/Max OAuth tokens in any
other product, and OpenAI directs third-party tools to platform API keys.

This package is a different class and the distinction must be stated narrowly:

> keryx executes the vendor's own official client, which authenticates itself
> from its own config. The token is never obtained, read, stored, or
> transmitted by keryx.

Enforced consequences:

- keryx **never** reads `~/.codex/auth.json` or Claude's credential store —
  not even to check whether a login exists. Reading the token would put us
  inside D-01's prohibition. Detection is `--version` and exit codes only.
- keryx never injects or proxies a credential into the subprocess.
- The residual question — whether a vendor considers third-party headless
  orchestration of its official client acceptable — is **unresolved by the
  vendors** and is recorded as a risk, not as a settled fact.
- Mitigation: opt-in capability, off by default, local-only. Hard-disabled when
  the transport is remote (`keryx-remote-entry`, `keryx-telegram-transport`) or
  CI is detected.

## Reference designs studied

### helyx (`/home/altsay/bots/helyx`) — two distinct patterns

**Pattern 1 — inverted MCP channel (`channel/`).** A human (or a tmux
supervisor) starts Claude Code; helyx attaches as a stdio MCP server
(`helyx-channel`). Inbound work queues in Postgres `message_queue`; delivery
uses MCP notifications `notifications/claude/channel`; the return path is MCP
tools (`reply`, `react`, `edit_message`). Permission requests are forwarded
outward via the experimental `notifications/claude/channel/permission_request`
so a human approves from Telegram. The server's `instructions` capability lands
in the client's system prompt — behaviour rules arrive before the session has
read any `CLAUDE.md`. Sessions are long-lived: `pg_advisory_lock`, heartbeat,
lease, hard exit on lease loss.

**Pattern 2 — one-shot headless reviewer (`services/reviewer-service.ts`).**
`ReviewerKind = "codex" | "provider" | "claude"`. Concurrent `Bun.spawn` of
`claude -p` and `npx @openai/codex exec`, 600s timeout, kill;
`mode: "external" | "self"` where a total external failure falls back to
self-review.

### keryx's own precedent

`scripts/benchmark/run-ablation-codex.ts` already spawns
`codex exec -s read-only --json -C <root> <prompt>`, parses the JSONL event
stream (`item.completed` / `command_execution` / `turn.completed.usage`), and
runs each variant in an isolated worktree via
`src/harness/child/git-worktree-port.ts` — against an already-authenticated
`codex` CLI with no API key. The mechanism exists; it lives in a benchmark
script rather than in the harness.

## Grounded CLI capability surface

Probed on 2026-08-19: `codex-cli 0.147.0`, `claude 2.1.220`.

| Need | codex exec | claude -p |
|---|---|---|
| machine-readable stream | `--json` (JSONL) | `--output-format stream-json` / `json` |
| structured final result | `--output-schema <file>`, `-o <file>` | `--json-schema <schema>` |
| sandbox / permissions | `-s read-only\|workspace-write\|danger-full-access` | `--permission-mode`, `--tools`, `--allowed-tools`, `--disallowed-tools` |
| working root | `-C <dir>`, `--add-dir` | `--add-dir`, `-w/--worktree` |
| budget | `usage.{input,output}_tokens` on `turn.completed` | `--max-budget-usd <amount>` (native cap) |
| session correlation | `exec resume <id>` | `--session-id <uuid>` (keryx *assigns* it), `--resume` |
| suppressing own config | `--ignore-user-config`, `--ephemeral` | `--safe-mode`, `--setting-sources`, `--strict-mcp-config` |
| **streaming input** | (via `exec resume`) | **`--input-format stream-json`** + `--replay-user-messages` |

The last row is load-bearing: headless is **not** fire-and-forget. `claude -p`
with `--input-format stream-json` is a bidirectional channel, so keryx can
delegate a task, watch the event stream, and inject a correcting message
mid-run — without falling back to interactive mode and thereby losing
`--max-budget-usd`, `--json-schema` and the structured result.

## Lessons taken from helyx's Pattern 2 (each prevents a measured failure)

1. **`--allowed-tools` does not restrict.** A CLI started with
   `--allowed-tools Read Grep Glob`, asked directly, reports Bash, Write, Task,
   Workflow and Skill still available. Only `--disallowed-tools` denies — and it
   must name the *delegation routes*, not just the direct ones: with only
   Edit/Write/NotebookEdit denied, the reviewer reported it could still reach a
   shell through `Monitor` and a subagent through `TaskCreate`.
2. **`--permission-mode plan` is a trap.** It injects Claude Code's own plan
   workflow into the system prompt; the agent answers with a plan-approval
   request, exits 0 with non-empty stdout, and is filed as a successful run.
3. **Repository settings undermine read-only.** The subprocess inherits cwd, so
   the project's `.claude/settings.local.json` applies — in helyx's repo that is
   379 allowed `Bash(...)` patterns. An allowlisted tool does not prompt, and
   under `-p` there is nobody to prompt.
4. **`--settings` adds a layer, it does not replace one**, and there is no
   `--strict-settings`. Only `--bare` fully isolates, and `--bare` forces
   API-key auth — which defeats the entire point of running on the
   subscription. This conflict is real and is stated in the spec rather than
   papered over.
5. **An `ANTHROPIC_API_KEY` in the environment breaks the subscription path.**
   Measured: with it present the CLI answers `Not logged in · Please run
   /login`; with all four `ANTHROPIC_*` variables cleared it answers on the
   subscription. Counter-intuitive, and the reason env is stripped rather than
   inherited.
6. **`CLAUDECODE` / `CLAUDE_CODE_*` / `CLAUDE_CONFIG_DIR` must be stripped.**
   A config pointer can carry its own `ANTHROPIC_BASE_URL` (this is how
   `claude-code-router` once hijacked every session on the machine). Related
   incident: an inherited `CHANNEL_SOURCE` made a nested `claude -p` register as
   the *same session* as its parent — the parent's next tool call never
   returned and three operator messages sat queued for 22 minutes.
7. **A directive in the prompt is mandatory.** An external CLI reads the
   operator's own `AGENTS.md`/`CLAUDE.md` and routes to their orchestrator:
   codex answered a review request with a *menu* of review modes — exit 0,
   non-empty, recorded as a successful review. keryx's case is sharper, since
   `.metaproject/index.md` explicitly orders routing through metaproject-router.
8. **argv is a pure function with its own test.** helyx passed
   `--no-interactive` for months after the CLI stopped accepting it — every
   review failed on the command line, before codex was asked anything. Separate
   scar: `--disallowed-tools` and `--mcp-config` are variadic, so the prompt
   must never sit directly behind one; `--model` is last precisely as a
   separator.
9. **Failure classifiers are per-CLI and asymmetric.** `codex exec` narrates
   itself on stderr and prints the contents of files it reads, so its classifier
   must subtract the prompt and read only lines starting `error`/`usage:` —
   otherwise a *successful* exploration is classified as an error because the
   agent quoted the classifier's own patterns back at it. `claude -p` prints
   `Not logged in · Please run /login` **to stdout with exit 0**, so the rule
   "exit 0 + non-empty output = success" is false.
10. **`probed` is a third availability state.** There is no cheap liveness probe
    for the subscription path: `--version` proves the binary and nothing about
    the login, and a real probe spends the operator's quota. "Available" is not
    "checked".
11. **Timeout and kill must be raced.** `proc.kill()` reaches the `npx` wrapper
    while the real process outlives it holding the pipes; helyx races the reads
    against a separate deadline. `stdin: "ignore"` too, or the CLI waits on
    stdin.
12. **The prompt is one argv element**, so it hits `ARG_MAX`; helyx caps the
    carried diff at a measured 66 KB.

## Resolved forks

**F1 — What v1 may write.** → **Read-only, with the permission level in the
contract from day one.** Investigation, review, second opinion. The dispatch
contract carries `read-only | worktree-write` so the mutating mode later needs
no breaking schema change. Rejected: read-only forever (would need a contract
and ADR rewrite within a month); mutating worker in v1 (three times the work,
and every error in the audit boundary is a hole in keryx's invariants).
helyx's Pattern 2 removed the main argument against this: a read-only external
reviewer is not a hypothesis, it is production, and its argv, env hygiene,
classifiers and directives transfer nearly verbatim.

**F2 — Who launches whom.** → **Push: keryx spawns the CLI.** Pull (keryx as an
MCP server that a live session drives, helyx Pattern 1) has no env or auth
problems at all, but keryx stops being the orchestrator — no on-demand fan-out,
no fail-closed, and the "parent owns completion" invariant breaks. The useful
part of Pull is already covered by `src/mcp/`.

**F3 — Integration layer.** → **A second runtime for `spawnChild`**, surfaced as
a `runtime` parameter on `spawn_subagent`. Rejected: `ProviderPort` (these are
whole agents with their own tool loops, not completion endpoints — the contract
would break or their loop would be wasted); a standalone builtin tool (honest
but bypasses ledger, depth caps, quarantine and `agent-event`).
The dispatch contract already carries a `model` block from flow 089; `runtime`
sits beside it.

**F4 — How the modal shows the work.** → **Structured render from the event
stream**, fed into the existing subagent store, drawn by `openModal` /
`subagent-inspector`. Rejected: PTY + terminal emulator, and a tmux backend —
both buy fidelity by forcing interactive mode, which costs the structured
result, the budget cap, policy enforcement and evidence, i.e. everything that
makes this keryx rather than a terminal multiplexer. Compensation: the modal
shows the exact launch command and offers a detach path
(`claude --resume <session-id>`) for taking over by hand.

**F5 — Addressing of operator messages.** → **Delivered straight to the agent,
with a copy into the supervisor's context.** Delivery and awareness are two
different things; routing through the supervisor couples them and costs direct
control, while bypassing it desynchronises the parent's picture from reality.
The main-queue pure helpers in `src/tui/main-queue.ts` are reused as-is,
generalised from "the main queue" to "a queue per addressee". `force` has no
abort controller for a subprocess, so it becomes **kill + `--resume
<session-id>`** — lossless because keryx assigns the session id.

**F6 — How read-only is actually held.** → **Disposable worktree + deny-list +
env strip.** Defence in depth: even with a hole in the deny-list — and helyx
proved deny-lists have holes, found only by interrogating the agent — the write
lands in a throwaway directory. Note `git worktree add --detach <path> HEAD`
does **not** carry uncommitted changes, so the working diff must be passed in
the prompt; that is a treatment, not the absence of the disease. Rejected:
neutralising settings files in the live tree (races with the operator's own
session); deny-list only (the single v1 invariant would rest on a list whose
completeness nobody can prove, and which leaks on every CLI update).

**F7 — Adapter shape and v1 scope.** → **A metadata registry plus one codec
module per CLI; codex and claude in v1.** Parsing differs *structurally*, not
parametrically (see lesson 9), so a purely declarative table would either grow
fields like "subtract the prompt from stderr" and become code in YAML, or lie.
Metadata — id, binary, detection, supported sandbox modes, known version range,
streaming-input support — is genuine data and belongs in a table, by the same
argument as `provider-auth` D-03. `opencode` is installed on the operator's
machine but a third codec teaches nothing new in v1; the seam is proven by the
third adapter needing exactly one module plus one registry row.

**F8 — What the parent sees during the run.** → **A folded view plus triggers.**
The parent receives compact updates (phase change, budget threshold,
`no-progress`, the agent asking a question instead of working, drifting out of
scope) and may inject a correction, kill, or escalate. `reduceAgents` /
`reduceState` already do the folding and `SubagentCompletionStatus` already
carries stop reasons. The operator sees the **full** stream in the modal at all
times — that is rendering and costs no tokens. Rejected: final result only
(makes "steer and correct" impossible); full stream into the parent's context
(spends more of our own model than the subscription saves — exactly backwards).

**F9 — Who decides to call an external agent.** → **Both paths, through the
policy engine.** The operator can ask explicitly; the parent agent can decide
via `spawn_subagent`. Both reach the same `spawnChild`, and both pass
`decide()` → allow/ask/deny, defaulting to `ask` for the model's own decision.
Spending subscription quota is spending real money and must be visible, but
keryx already has the machinery for "confirm before an expensive action", and
autonomy stays reachable by configuration rather than forbidden.

**F10 — Behaviour on external failure.** → **Fail-closed with a structured
status; no substitution.** `SubagentCompletionStatus` already distinguishes
`Denied | Error | Timeout | BudgetExhausted | NoProgress`, and the per-CLI
classifiers supply a human-readable cause ("limit until Aug 11th", "not logged
in", "argv not understood by this CLI version"). Fallback is a *policy*, not a
mechanism: the parent holding the status can implement any of them as a visible
decision. Rejected: helyx's `mode: "self"` auto-fallback (justified for a review
bot where degraded output beats none; here the parent owns completion and a
silent substitution corrupts its account of what happened) and auto-failover to
another CLI (same silent substitution, and it doubles spend at the worst
moment).

**Also settled, unopposed.** The feature ships as an opt-in capability via
`src/capability/`, off by default, configured in the user-global store, hard
disabled under remote transports and CI.

**F11 — Is external output evidence?** → **No: it is input to the parent, never
evidence.** The result reaches the parent through `quarantineChildSummary` and
`keryx security check-output`; a flow still closes only on artefacts keryx can
verify itself. keryx's evidence model is about reproducible artefacts, not
opinions — a third-party model's "looks correct" cannot be re-checked, and the
same CLI version will answer differently tomorrow. Rejected: evidence with
provenance, and two-source corroboration (agreement between two language models
is correlated, not independent — it looks like a quorum and is not one).

## Critical questions carried into the PRD

1. **Recursion.** The external CLI will discover `AGENTS.md` → `.metaproject/index.md`
   and start calling `keryx ctx rg` — desirable. But it can also reach `keryx`
   spawn paths and produce a grandchild that knows nothing of `maxTreeDepth`. A
   depth marker must be passed in the environment and honoured by keryx *on
   entry*, not only on exit.
2. **Version drift.** `codex exec --json` has no stable schema; the ablation
   script already carries a scar about a rejected `-m terra`. A version probe
   with a known-good range and graceful degradation, not a crash.
3. **Cost visibility.** The operator is spending subscription quota through an
   agent they are not watching. Per-run cost and turn count must surface in the
   TUI; `--max-budget-usd` helps directly.
4. **Determinism.** keryx's culture is deterministic replay; a live external CLI
   is neither deterministic nor offline. Adapters are tested offline against
   recorded JSONL transcripts (the `fake-provider.ts` pattern); the live path is
   a fenced optional capability.
5. **Permission forwarding as a route to F1's mutating mode.** helyx forwards
   `permission_request` outward so a human approves remotely. The same shape
   could route an external agent's write requests into keryx's own `decide()` in
   real time — which would resolve the audit-boundary objection to the mutating
   worker. It rests on an **experimental** MCP capability
   (`claude/channel/permission`) with no corresponding flag in `claude --help`
   2.1.220, so it enters the spec as a flagged option, not a foundation.
6. **ARG_MAX.** The prompt is one argv element and must carry the working diff
   (see F6). A measured ceiling and a defined behaviour above it are required.

## Related packages

- `keryx-multi-agent-engine` — the child spawn, model resolution, ledger, caps,
  worktree and monitoring machinery this reuses (phases A–D, flows 088–101, 171).
- `keryx-project-agent-harness` — the provider protocol, session, budget, policy
  and child contract underneath.
- `keryx-provider-auth` — D-01, the compliance boundary this package sits beside.
- `keryx-opentui-modal-tabs`, `keryx-tui-queue-dock` — the modal host and the
  main-queue dock the operator surface builds on.
- `keryx-execution-observability` — provenance and retry taxonomy.
