# ADR-0009: A destructive-command classifier escalates confirmation, it does not block

- **Status:** Accepted (flow 115)
- **Date:** 2026-07-21
- **Relates to:** ADR-0006 (OS sandbox for `shell_exec`) — this sits ABOVE the
  containment layer, in the approval gate. ADR-0003 (security profiles) — this
  supplies the per-command dimension the profile risk classes lack.

## Context

`shell_exec` carries exactly one static risk: `shell`. The policy engine
(`harness/policy/engine.ts`) already understands a `destructive` class and never
lets it auto-allow, but **no tool ever set it and no classifier existed**, so
`ls` and `rm -rf /` were the same decision to every layer above the shell.

A stress run of the interactive agent (flow 115, `scripts/stress/keryx-shell-stress.ts`,
reports under `.metaproject/data/stress/`) showed what that costs in practice:

- the saved allowlist on one host contained the exact pattern `rm -rf /`, so the
  command auto-approved with no prompt at all;
- `suggestShellPatterns("rm -rf ./dist")` yields the prefix `rm *`, which matches
  `rm -rf /` — one "always allow" click on a benign cleanup grants the worst case;
- with `KERYX_SANDBOX_SHELL=off` (the default, per ADR-0006) the approval gate is
  the **only** barrier, and on a host without `bubblewrap` it is the only barrier
  available at all.

So the gate needs to distinguish commands. The open question is what a classifier
is allowed to *do* with that distinction.

## Decision

Add `lib/command-risk.ts`: a pure, deterministic `classifyCommand(cmd) →
"shell" | "destructive"`, and wire `destructive` through `executeCall` as an
**escalation**, never as a denial.

Concretely:

- `executeCall` accepts `destructive` as an approvable class instead of rejecting
  it as "not permitted" (it previously fell into the `risk !== "read"` catch-all,
  which made the declared class unusable from both ends).
- The approver receives `ApprovalMeta { destructive }` and must respond by:
  always prompting, never auto-approving from a saved allowlist, never offering
  "always" for that command.
- The classifier **never returns a decision that stops execution on its own.**

## Why escalation and not a block

A blocklist of dangerous commands is incomplete by construction. A shell has
unbounded ways to express the same destruction (`rm -rf /` vs `find / -delete` vs
a script that does it three levels down vs base64-encoded input to `sh`). Two
failure modes follow, and only one of them is survivable:

- **Escalation that misses a case** ⇒ the user is asked the normal question
  instead of the loud one. The default-deny gate still stands.
- **Blocking that misses a case** ⇒ the command runs, and the fact that it
  "passed the safety check" reads as a grant. The check becomes a source of false
  confidence, which is worse than having no check.

The real boundaries stay where they were, in this order: the human approval gate
(default-deny), the metacharacter restriction on allowlist patterns
(`lib/shell-permissions.ts`, flow 115), and OS containment when enabled
(ADR-0006). The classifier only decides how loudly to ask.

This is recorded explicitly because the shape invites the opposite reading: a
list named "destructive commands" looks like a deny-list, and a future change
that turns it into one would trade a survivable failure mode for an unsurvivable
one.

## Consequences

- Positive: a destructive command can no longer be silently auto-approved from a
  remembered pattern, and "always" is never offered for one — the exact path that
  put `rm -rf /` into a live allowlist.
- Positive: the `destructive` risk class becomes usable by any future tool that
  wants to declare it statically.
- Negative: false positives cost an extra confirmation (`sudo` is always
  escalated, `git push --force` with no named target is escalated because the
  target is ambiguous). Accepted deliberately: the fail-closed direction here is
  "ask again", which is cheap.
- Negative: the classifier reasons about command *text*, not about what the
  command will actually do. It is a heuristic and is documented as one in the
  module header, so no caller mistakes a `shell` verdict for a safety guarantee.

## Alternatives considered

- **Block destructive commands outright.** Rejected above: false confidence from
  an inevitably incomplete list.
- **Parse the command with a real shell grammar.** Rejected for v1: a parser is a
  new and subtle failure surface in a security-critical path, and it does not
  change the incompleteness argument — a correctly parsed `find / -delete` is
  still only caught if the rule for it exists.
- **Rely on OS containment instead.** Insufficient: containment is opt-in and
  off by default (ADR-0006), and is unavailable entirely on a host without a
  launcher — measured on the Linux host in the flow-115 run.
