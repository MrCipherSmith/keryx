# ADR-0010: `write` risk joins the interactive-shell approval gate

- **Status:** Accepted
- **Relates to:** ADR-0008 (interactive shell delegate risk gate) — the
  precedent for adding a new gated risk class to `executeCall`. ADR-0009
  (destructive-command escalation) — this decision reuses that ADR's
  "escalation, never a block" posture for a new domain (file patches instead
  of shell commands).
- **Update:** the "shape problem" this Context section names —
  `DEFAULT_MAX_NON_READ_TOOL_CALLS` counting unique tool-call signatures
  conflated task volume with actual runaway repetition — was never revisited
  by this ADR's own resolution (it only added a `write` branch to the risk
  gate). A later change replaced that whole counting axis: `src/commands/
  agent.ts` now bounds model round-trips (`DEFAULT_MAX_ROUNDS`) instead of
  unique tool-call signatures, keeping only the per-signature repeat cap
  (`MAX_ATTEMPTS_PER_HASH`) as the actual repetition guard. The three
  `DEFAULT_MAX_*_TOOL_CALLS` pools this Context section describes no longer
  exist.

## Context

`shell_exec` was, until this change, the interactive agent's only way to
mutate a project file. Every edit — however small — was classified
`risk: "shell"`, one of six non-`"read"` risk classes sharing a single small
per-turn tool-call budget (`DEFAULT_MAX_NON_READ_TOOL_CALLS`,
`src/commands/agent.ts`). A task touching several files, or the same file
more than a couple of times, routinely ran out of budget mid-task — a shape
problem ("one edit costs one call, and one call is one budget slot"), not
merely a small-number problem.

`ToolRisk` (`src/harness/tool/types.ts`) had always declared a `write` value
alongside `read`/`shell`/`destructive`/`network`/`credential`/`delegate`, but
`executeCall`'s risk gate never had a branch for it: its final
`else if (risk !== "read")` branch rejected `write` outright, unconditionally,
regardless of approver or permission mode. `permission-mode.ts`'s own
`GatedToolRisk` type documented this explicitly — `write` was declared but
dead. The only existing mutating tools, `workspace_create`/`workspace_propose`
(SAC bookkeeping), sidestepped the gap by being declared `risk: "read"`
**deliberately** (`workspace-lifecycle-tool.ts`'s own comment), because their
write is narrowly scoped and never touches real project files.

A new tool, `apply_patch` (takes a standard multi-file unified diff, applies
it via a constrained `git apply` subprocess call — see
`docs/requirements/structured-file-edit-tools/`), needed a real `write` path:
it mutates arbitrary project files and could not take the `workspace_*`
shortcut without becoming an unreviewed, unconditional auto-approve for any
file mutation the model proposes.

## Decision

Add `"write"` to `GatedToolRisk` and to `executeCall`'s risk-gate `if`/`else
if` chain, structurally identical to the existing `shell`/`destructive`
branch:

- Same default-deny-with-no-approver posture.
- Same `ask`/`trust`/`auto` permission-mode semantics via the existing,
  unmodified `resolveApprovalDecision` (its branches already key off
  `destructive`/`credentials`/`mode`, not off `risk` directly, so `write`
  falls through the same logic `shell`/`destructive` already use — no change
  to that function beyond a doc-comment update).
- A new escalation classifier, `src/lib/patch-risk.ts`
  (`classifyPatchRisk`), supplies `destructive`/`credentials` from the
  patch's **target paths** instead of `isDestructiveCommand`/
  `touchesAgentCredentials`'s command text: any deletion, any `.git/` touch,
  or more than `MAX_FILES_BEFORE_ESCALATION` (8) files in one call escalates
  `destructive`; a target path matching the existing credential markers
  (`touchesAgentCredentials`, reused as-is against the joined path list) is
  the same hard floor `credentials` already is for `shell`.
- The classifier is escalation-only, exactly like ADR-0009's classifier —
  it never denies on its own. The real boundaries stay the human approval
  gate (default-deny) and `confineToRoot` (path escape rejects the whole
  patch before `git` ever runs, enforced by the tool itself, not this
  classifier).

## Why this is safe to add now

The mechanism this decision extends was already proven for `shell` and
`destructive` (ADR-0009) and for `delegate` (ADR-0008) — this is the third
risk class to join the same gate, not a new gate. The specific things that
make a gate extension risky are each addressed the same way the prior two
were:

- **"A new class of auto-approvable action" is not new** — `trust`/`auto`
  modes already auto-approve `shell`/`destructive`/`delegate` today; `write`
  gains the identical shape, with its own escalation classifier deciding
  when `trust` should still ask, exactly mirroring `shell`'s
  `isDestructiveCommand`.
- **The credential hard floor is reused, not reinvented** — same markers
  (`CREDENTIAL_MARKERS`/`touchesAgentCredentials`), applied to a different
  input (joined patch target paths instead of a command string), never lifted
  by any mode including `auto`.
- **No new subprocess-execution surface** — `apply_patch` runs a single fixed
  argv, `git apply` (`--check` then real apply), with the patch delivered
  over **stdin**, never interpolated into a shell string. There is no
  metacharacter-injection analog to `shell_exec`'s.

## Consequences

- Positive: `apply_patch` (and any future `write`-risk tool) has a real,
  reviewable approval path instead of either being permanently unusable or
  taking the `workspace_*` "declare it `read`" shortcut, which would have
  been the wrong precedent for a tool that touches arbitrary project files.
- Positive: the escalation classifier is a pure function
  (`src/lib/patch-risk.ts`), independent of the `git apply` subprocess,
  unit-tested the same way `command-risk.ts` is.
- Negative: false positives cost an extra confirmation (e.g. a patch that
  legitimately touches 9+ generated files in one pass escalates). Accepted
  deliberately, same as ADR-0009: the fail-closed direction is "ask again."
- Negative: `classifyPatchRisk` reasons about parsed diff headers, not about
  what `git apply` will actually do to the file's real content — same
  heuristic-not-guarantee posture `command-risk.ts` already documents for
  shell text.

## Alternatives considered

- **Declare `apply_patch` `risk: "read"`, like `workspace_*`.** Rejected:
  `workspace_*`'s write is narrowly scoped to SAC bookkeeping and reviewed
  separately by a human before acceptance; `apply_patch` mutates arbitrary
  project files directly. Auto-approving that unconditionally would be a
  real security regression, not a labeling convenience.
- **Reuse `risk: "shell"` for `apply_patch`.** Rejected: `shell`'s
  destructive/credential checks are shell-syntax classifiers
  (`isDestructiveCommand`, `touchesAgentCredentials` against `input.command`)
  that have no meaningful signal for a patch's `input.patch` field —
  `input.command` would simply be `undefined`, so every patch would
  (incorrectly) read as non-destructive regardless of what it deletes.
- **A custom hunk-application algorithm instead of shelling out to `git
  apply`.** Rejected: reinventing context-matching/fuzzy-offset hunk
  application is a new and subtle failure surface in a security-critical
  path (the same reasoning ADR-0009 gives for not writing a shell-grammar
  parser); `git apply`'s own strictness (fails closed on ambiguous context)
  is the correctness boundary instead.
