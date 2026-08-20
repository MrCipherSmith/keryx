# PRD: Keryx External Agent Runtime
Version: 0.4.0

## Problem

The operator holds paid subscriptions to Claude Code and Codex. Those
subscriptions drive capable agents that keryx cannot use: keryx's own harness
talks to providers over API keys, and the vendors forbid third-party products
from consuming subscription OAuth tokens (`provider-auth` D-01). The capability
sits on the machine, already authenticated, and keryx cannot reach it.

Meanwhile keryx already has everything needed to *govern* a child agent —
budget ledger, depth caps, worktree isolation, policy engine, quarantine,
monitoring folds, structured completion status — and exactly one thing it
cannot govern: an agent it did not build.

The gap is not authentication. It is that a vendor CLI is a whole agent with
its own tool loop, and keryx has no seam for hosting one.

## Goal

Make an external agent CLI a first-class **child runtime** of the keryx
harness: the parent delegates a bounded task, the external agent performs it on
the operator's own subscription, and keryx retains ownership of isolation,
budget, supervision, result handling and completion.

Success is the operator being able to say "let codex investigate this" and get
a governed, observable, interruptible run — not a shell-out.

## Users

- **The operator at the keryx TUI.** Wants to delegate work to a subscription
  they already pay for, watch it happen, steer it mid-flight, and stop it.
- **The parent keryx agent.** Wants to spawn an external investigator the same
  way it spawns a native subagent, and receive a result it can act on.
- **A later reviewer of this repository.** Needs the compliance boundary and
  the isolation guarantees stated explicitly rather than inferred.

## Requirements

### Runtime and contract

- **R1.** `subagent-dispatch` gains a `runtime` block declaring the runtime kind
  (`keryx` or `external`), the external agent id when applicable, and the
  sandbox level (`read-only` or `worktree-write`). The block is optional and
  absent means `keryx`, so every existing dispatch stays valid.
- **R2.** `runtime.sandbox` must be consistent with `allowed_actions`:
  `read-only` is rejected fail-closed if `allowed_actions` contains `write`,
  `network`, or `spawn-subagent`. `run-command` is **not** rejected, because an
  external CLI necessarily runs commands inside its own sandbox; that axis is
  governed by the sandbox flag and the worktree, not by this check. Validation
  is pure and testable without a CLI present.
- **R3.** Only `read-only` is accepted by the implementation in this release.
  `worktree-write` is a valid contract value that the runtime refuses with a
  named reason, so the mutating mode later needs no schema change.
- **R4.** An external child is created through the existing `spawnChild` path
  and inherits, unchanged: the shared budget ledger, `maxTreeDepth`,
  `maxChildrenPerRun`, worktree assignment, `quarantineChildSummary`, and the
  `agent-event` stream consumed by `reduceAgents` / `reduceState`.
- **R5.** External children report the existing `SubagentCompletionStatus`
  values. No new status vocabulary is introduced.

### Registry and codecs

- **R6.** A registry declares each supported CLI as **data**: id, binary name,
  detection method, supported sandbox modes, known-good version range, and
  whether it accepts streaming input. Adding an agent is a registry entry plus
  one codec module.
- **R7.** Each CLI has a codec module owning three pure functions — argv
  construction, event parsing, failure classification — each unit-tested
  against recorded transcript fixtures with no CLI on the machine.
- **R8.** `codex-cli` and `claude-cli` ship in this release.
- **R9.** A version probe runs before the first spawn of a session and compares
  against the registry's known-good range. Outside the range the run proceeds
  with a recorded warning; a failure to parse the probe is not fatal.

### Isolation and safety

- **R10.** Every external child runs in a disposable worktree created by
  `createGitWorktreePort` and removed afterwards, regardless of outcome.
- **R11.** The child process environment is built by allow-then-strip: the
  parent environment minus a named deny list, minus every variable matching the
  vendor-prefix sweeps. The list and its rationale live in
  [security-policy.md](security-policy.md).
- **R12.** Read-only is held by three independent mechanisms — the CLI's own
  sandbox flag, a restricted tool roster, and the disposable worktree — such
  that no single failure exposes the operator's working tree. The roster is
  expressed as an **allow-list** (`--tools`) rather than a deny-list, so tools
  added by a future CLI version are excluded by default; the worktree remains
  the load-bearing layer regardless.
- **R13.** keryx never reads, writes, stores, forwards or proxies a vendor
  credential. Availability is determined from `--version` and exit codes only.
- **R14.** The feature is an opt-in capability, disabled by default, and hard
  disabled when the active transport is remote or CI is detected.

### Supervision and operator surface

- **R15.** The parent agent receives a folded, trigger-driven view of the
  external run — phase change, budget threshold, no-progress, the agent asking a
  question, scope drift — not the raw event stream.
- **R16.** The operator sees the complete event stream, rendered as a structured
  transcript in the shared modal, with no token cost to any model.
- **R17.** External children appear in the TUI subagent sidebar and open in the
  shared modal host, alongside native children.
- **R18.** The operator can send messages to a running external agent. Messages
  use the existing main-queue semantics (`remove`, `edit`, `force`) via the pure
  helpers in `src/tui/main-queue.ts`, generalised from one queue to a queue per
  addressee.
- **R19.** A message is delivered verbatim to the external agent, and a
  corresponding event is written to the stream the parent's folded view reads.
- **R20.** `force` on an external child is implemented as process kill followed
  by resumption against the keryx-assigned session id, so intervention costs a
  process restart and not the accumulated work.
- **R21.** The modal displays the exact launch command and offers a detach path
  so the operator can continue the session by hand in their own terminal.

### Result handling

- **R22.** The result is requested as structured output through the CLI's own
  schema flag and validated against `subagent-result`. Free text outside the
  schema passes `quarantineChildSummary` and `keryx security check-output`
  before reaching the parent's context.
- **R23.** An external agent's output is never an evidence record. Flow
  completion continues to require artefacts keryx produces and can re-check.
- **R24.** On failure the runtime returns a structured status and a
  human-readable cause. It never substitutes another runtime, another agent, or
  the parent's own model.

### Spawn authorisation

- **R25.** Both the operator and the parent agent can initiate an external
  spawn. A spawn decided by the **model** passes the policy engine and defaults
  to `ask`; the default is configurable to `allow`.
  **Amended 0.4.0 after implementation:** the **operator** path (`/delegate`)
  does *not* pass `decide()`. Routing it there would ask the operator to approve
  their own explicit command, and the machinery to do so does not exist — the
  TUI has no tool-invocation path. The operator path is instead gated by the
  capability, the per-agent enable, the depth ceiling and the worktree
  containment, which is every control except the one whose purpose is to ask the
  operator. Stated here rather than left as an undocumented divergence.
  Consequence to accept: `/delegate` also bypasses `spawn_subagent`'s
  `risk: "delegate"` approval and the MAE admission ledger, so an operator-
  initiated run is not counted against the per-turn child budget.
- **R26.** Per-run cost and turn count are surfaced in the TUI, using the CLI's
  own reported usage where available.

## Success criteria

1. A dispatch carrying `runtime.kind = "external"` spawns a vendor CLI, folds
   its events into `reduceAgents`, and returns a schema-valid `subagent-result`
   — verified offline against recorded transcripts, with no process spawned.
2. Every codec's argv, parser and classifier are covered by fixtures that run in
   CI on a machine with neither CLI installed.
3. A read-only external run leaves the operator's working tree byte-identical,
   proven by a test that asserts worktree containment after a run whose
   transcript contains write attempts.
4. The environment handed to the child contains none of the denied variables,
   asserted by a pure test over the env-builder.
5. An operator message sent mid-run reaches the agent and appears in the
   parent's folded view, verified by a fixture-driven supervision test.
6. `force` produces a resumed session that retains prior context, verified
   against a recorded resume transcript.
7. With the capability disabled, every external spawn path fails closed with a
   named reason and no process is created.
8. A run whose CLI is missing, logged out, or rate-limited returns a distinct,
   human-readable cause and no fallback occurs.
9. `keryx health run` and the existing gate are unaffected; no new runtime
   dependency appears in `package.json`.

## Risks

- **R-1 — Vendor terms are silent on headless third-party orchestration.**
  Driving the vendor's own authenticated client is materially different from
  consuming its token, but no vendor states a position on it. Mitigated by
  keeping the feature opt-in, local-only, off by default, and by never touching
  a credential. Recorded as an open risk, not a settled question, in
  [decisions.md](decisions.md) D-01.
- **R-2 — Deny-lists leak.** Tool deny-lists cannot be proven complete and lose
  ground on every CLI update, and the reference implementation found escape
  routes only by interrogating the agent directly. Mitigated by R10/R12: the
  worktree, not the deny-list, is the load-bearing guarantee.
- **R-3 — Event schema drift.** Neither CLI publishes a stable event schema.
  Mitigated by R7 and R9: parsing is fixture-pinned and version-probed, and a
  parse failure degrades to an `Error` status rather than a crash.
- **R-4 — Supervision cost inversion.** A parent reading a verbose external run
  event-by-event could spend more of the operator's own model budget than the
  subscription saves. Mitigated by R15.
- **R-5 — Recursion.** The external CLI will discover `AGENTS.md` and
  `.metaproject/index.md` and may reach keryx spawn paths, producing a
  grandchild that knows nothing of `maxTreeDepth`. Mitigated by a depth marker
  in the environment that keryx honours on entry, specified in
  [agent-protocol.md](agent-protocol.md).
- **R-6 — Prompt size.** The prompt is a single argv element and must carry the
  working diff, because a detached worktree does not include uncommitted
  changes. A measured ceiling and defined truncation behaviour are required.
- **R-7 — Quota spent invisibly.** An agent the operator is not watching spends
  real subscription quota. Mitigated by R25 and R26.

## Recommendation

Implement the read-only release as specified: registry plus two codecs, the
`runtime` block, disposable-worktree execution, the folded supervision view and
the TUI modal, all behind an opt-in capability.

Defer the mutating worker. The prerequisite is not more spawn machinery but a
credible audit boundary for writes, and there is a promising route to one — the
external agent's permission requests routed into keryx's own `decide()` — that
currently rests on an experimental, undocumented vendor capability. Ship the
read-only runtime, use it, and revisit the mutating mode when that route can be
evaluated against a stable interface rather than a discovered one.
