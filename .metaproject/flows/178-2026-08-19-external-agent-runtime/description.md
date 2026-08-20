# External Agent Runtime read-only release: registry + codex/claude codecs, worktree containment, folded supervision, TUI modal
Status: formalized
Source: user description (2026-08-19 brainstorm + interview)

## Problem

The operator holds paid Claude Code and Codex subscriptions. Those subscriptions
drive capable agents keryx cannot reach: the harness talks to providers over API
keys, and `keryx-provider-auth` D-01 correctly refuses to consume subscription
OAuth tokens because the vendors forbid it and the cost of ignoring that falls
on the operator's own account.

The capability is sitting on the machine, installed and already authenticated,
and keryx has no way to use it.

The gap is not authentication. keryx already governs child agents well — budget
ledger, depth and child caps, worktree isolation, policy engine, quarantine,
monitoring folds, structured completion status. What it has no seam for is
hosting an agent it did not build: a vendor CLI is a whole agent with its own
tool loop, not a completion endpoint.

## Expected Outcome

An external agent CLI is a first-class **child runtime** of the harness.

- A dispatch carrying `runtime.kind = "external"` spawns `codex exec` or
  `claude -p` through the existing `spawnChild`, and the run inherits the shared
  budget ledger, depth caps, worktree assignment, quarantine and `agent-event`
  stream without any of them being duplicated.
- Execution is read-only, contained by a disposable detached worktree — so a
  hole in the tool deny-list cannot reach the operator's working tree.
- keryx never reads, stores, forwards or proxies a vendor credential, not even
  for a liveness check.
- The parent agent receives a folded, trigger-driven view; the operator sees the
  full event stream rendered in the shared TUI modal and can steer the running
  agent using the existing main-queue semantics.
- Failure returns a named `SubagentCompletionStatus` with a human-readable
  cause, and never substitutes another agent, runtime, or the parent's model.
- The whole adapter layer is testable offline against recorded transcripts, on a
  machine with neither CLI installed.
- The feature is opt-in, off by default, and hard disabled under remote
  transports and CI.

Full requirements: `docs/requirements/keryx-external-agent-runtime/`
(README, prd, specification, agent-protocol, security-policy, decisions
D-01..D-11, brainstorm, two schemas). Committed on this branch as `64054c55`.

## Out of Scope

- **Mutating external agents.** The permission axis is in the contract from the
  first version (`sandbox: read-only | worktree-write`), but `worktree-write` is
  refused at runtime with a named reason. Its prerequisite is a credible audit
  boundary for writes, not more spawn machinery — see decisions D-04 and the
  permission-forwarding route kept in D-03.
- **A third codec.** `opencode` is installed on this machine; a third adapter
  teaches nothing new in this release. The seam is validated by confirming a
  third agent would need exactly one module plus one registry row.
- **Any `ProviderPort` adapter** for these CLIs (decisions D-02).
- **PTY or tmux-attached views** of the external agent (decisions D-11).
- **Treating external output as completion evidence** (decisions D-05).
- **The main-queue dock UI.** `keryx-tui-queue-dock` owns that redesign. This
  flow generalises the pure helpers in `src/tui/main-queue.ts` from one queue to
  a queue per addressee; it does not rework `paintMainQueue`. The two packages
  touch the same code and the ordering is called out in plan.md.
