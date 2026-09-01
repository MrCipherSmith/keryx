# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The review covers the whole release, not the parts that were easy to look at. The denominator is stated — 43 non-test source files and 36 test files between v0.2.73 and v0.2.74 — and every area is assigned to a reviewer with a named lens, including the ten small scattered files that a review focused on large diffs stops reading.
- AC2: A mutation pass runs over every gate the release added: delete each one, run the suite, record red/green, restore. The method is proved non-vacuous FIRST on a gate known to be covered, because a sweep that can only return green proves nothing.
- AC3: Reviewers run read-only. They name mutation candidates rather than running mutations, because they share one worktree and parallel agents editing the same files is the exact defect this programme fixed in `task-implementer` — an agent destroying a wave-mate's uncommitted work it cannot observe.
- AC4: Every finding carries a concrete failure scenario. A finding with no scenario is dropped rather than reported, and each reviewer also returns what it checked and cleared, with reasons.
- AC5: Every finding is verified independently before it is acted on. Convergence of two reviewers on the same defect is recorded as such, and a claim that does not survive checking is dropped even if it reads well.
- AC6: Every fix is proved by restoring the shipped line and watching a NAMED test go red, three runs in isolation, then restoring. A fix whose test cannot see the original defect is not a fix, and the check is run against the actual shipped line rather than a paraphrase of it.
- AC7: Where a defect recurs as a class, the fix is structural rather than another instance repaired by hand. A guard that only fixes the third occurrence guarantees a fourth.
- AC8: A guard added by this flow must not produce false positives. A guard that cries wolf earns an allow-list entry and is then deleted, so a false positive is treated as the same class of error as a miss.
- AC9: What is NOT fixed is named with its reason, in the pull request and in the flow record. A gate left unpinned because it is genuinely redundant is stated as such, and any earlier disposition that claimed more than the evidence supported is corrected rather than left standing.
- AC10: `bun run typecheck` clean; `bun test` no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
