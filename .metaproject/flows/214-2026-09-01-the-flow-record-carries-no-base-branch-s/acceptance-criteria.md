# Acceptance criteria

- AC1: The flow record carries an optional `baseBranch`, written by `keryx flow init`
  when a base is named and by `flow implemented --pr <url>` from the pull request's
  `baseRefName`. Verified by reading `flow.json` after each, not by reading the code.
- AC2: A flow package written before this field exists still loads, and `flow status`
  and `flow complete` behave as they did. Verified against a real pre-existing package
  copied into a fixture, not a hand-built one.
- AC3: `keryx flow complete` refuses when the record names a base and the merge landed
  on a different branch. Demonstrated by driving the real command to a non-zero exit
  with a message naming both branches — not by a unit test over the predicate.
- AC4: The same condition reports `unobserved` — and still fails — when the base cannot
  be resolved, with a message naming the tracker as what failed and the remedy for the
  specific way it failed. Verified by running it with the tracker unreachable.
- AC5: A record with no `baseBranch` produces neither a pass on this condition nor a
  failure: it reports `not recorded`, distinct from both. Pinned by a test asserting the
  three states are three, so "not recorded" cannot later collapse into "passed".
- AC6: `flow-orchestrator`'s Phase 4 no longer asks the agent to confirm the merge target
  by eye where the gate now asks it, and no skill claims a check the gate does not make.
- AC7: `bun test`, `tsc --noEmit` and `keryx skills verify --bundled` clean; conditions
  1-5 of the existing gate still refuse what they refused before, pinned by one failing
  case each.
