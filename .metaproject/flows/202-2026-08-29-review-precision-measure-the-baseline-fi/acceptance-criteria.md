# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The current pipeline's precision is measured BEFORE any pipeline change lands, from the review packages already on disk, and the result is recorded with its sample size, its classification method, and what it cannot tell us. **The measurement returned a figure that is pinned at 100% by construction — 53 acted-on, 0 dismissed-incorrect, 30 unknown across 83 findings — because nothing in the corpus can record a finding as wrong.** AC1 is satisfied by that recorded refusal and its four demonstrated reasons, not by a usable number. No later claim in this package may cite the figure as a precision baseline.
- AC2: The baseline is reproducible: a command in the repository recomputes it from the same inputs and returns the same number, so the after-figure is comparable rather than re-estimated.
- AC3: A deterministic pre-filter runs before reviewer dispatch and requires no model call. It drops generated, lockfile, snapshot and vendored paths; drops whitespace-only and comment-only hunks; and scopes each reviewer to changed hunks plus a bounded context window.
- AC4: The pre-filter is implemented in the code that builds the review scope, not as an instruction in `SKILL.md`. Proven by a test that runs it over a diff containing a lockfile, a whitespace-only hunk and a real change, and asserts only the real change survives.
- AC5: Everything the pre-filter dropped is recorded in the review record, with a reason per drop. A silent truncation reads as "we reviewed everything" when we did not.
- AC6: `review-strict` is removed from Wave C and replaced by `review-verifier`. The removal is justified in the skill itself: intrinsic self-correction without new evidence is measured to degrade accuracy, and the pass re-read findings and adjusted severity with no new evidence.
- AC7: `review-verifier` emits, per finding, `verification: {verdict, method, evidence}` where verdict is one of `confirmed`, `refuted`, `unverifiable`. A verdict produced by reasoning alone is capped at `unverifiable` and can never be `confirmed`.
- AC8: The verifier can only delete. It cannot raise a severity, cannot add a finding, and cannot change a finding's text. Enforced in the code that merges its output, not by instruction, and proven by a test that feeds it an attempted escalation and asserts the escalation is discarded.
- AC9: The verifier never verifies a finding produced by the same reviewer that raised it. Enforced, with a test.
- AC10: `verification_mode` is `off | annotate | filter` and defaults to `annotate`, so the drop rate is measured for one release before it removes anything. The default is asserted by a test.
- AC11: The review record carries counts of what each stage removed: dropped by pre-filter, refuted by the verifier, retained. Without them no claim in this flow can be checked afterwards.
- AC12: Every skill or rule edit lands in BOTH `src/gdskills/bundled/` and `.metaproject/`, verified by a diff. The bundled-rule guard test still passes.
- AC13: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
- AC14: Because precision cannot be measured today, the pipeline gains the instrumentation that would let it be measured later: a `disposition` on the finding record defaulting to `unknown`, written when a fix round closes and carrying an evidence ref; globally unique finding ids; and a record of what a round REFUTED, not only what it reported. Without the third, the corpus keeps only the survivors of an unlogged triage, which is what pins the figure at 100%.
- AC15: The claims this flow makes about AC3–AC11 are stated as **stage counts** — dropped by pre-filter, refuted by the verifier, retained — and never as a precision improvement, since no precision figure exists to improve on.
