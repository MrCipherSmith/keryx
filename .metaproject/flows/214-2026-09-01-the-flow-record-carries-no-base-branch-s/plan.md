# Plan

## Approach: an additive field on the record, written by the CLI, read by the gate

Three parts, in this order, because each is useless without the one before it.

1. **Record it.** Add an optional `baseBranch` to the flow record. Optional and
   additive on the TM-01 precedent: every package written before this exists must
   keep loading, and a flow that never named a base is a real state, not a
   corruption. Written at `flow init` when the caller names one, and by
   `flow implemented --pr <url>` from the pull request's own `baseRefName`, which
   is authoritative and costs one API call the command already has the token for.

2. **Refuse on it.** A sixth completion condition: when the record names a base
   and the merge landed elsewhere, `violated`. Follow the three-state discipline
   conditions 3 and 4 already use — `pass`, `violated`, and `unobserved` when the
   base could not be resolved at all. `unobserved` FAILS, per the module's rule
   that a condition nobody could observe does not pass; it fails with a message
   naming the tracker rather than the flow.

3. **Say it where the promise is made.** `flow-orchestrator`'s Phase 4 currently
   tells the agent to "confirm the merge landed on <headRefName>" with its own
   eyes. Once the gate asks, that sentence should point at the gate instead of
   asking a human to be the check.

## Rejected

**Derive the base from the PR at completion time and skip the stored field.**
One less field, and it answers a different question: it would compare the merge
to wherever the PR happens to point NOW, not to what the dispatch asked for. A
retargeted PR would pass. The stored intent is the whole value.

**Make `baseBranch` required.** Breaks every existing package and mislabels a
real state — plenty of flows legitimately never name a base.

**Put the check in `flow-orchestrator`'s prose only.** That is the current state,
and this flow exists because prose is not a gate.

## Risk

The condition must not fail flows that are fine. Bound it: it fires only when the
record NAMES a base. Silence for the packages that predate the field is correct
behaviour, not a hole — and AC5 pins that distinction so a later change cannot
quietly turn "not recorded" into "passed".
