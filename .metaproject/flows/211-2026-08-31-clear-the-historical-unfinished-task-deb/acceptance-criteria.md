# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The real figure is recorded, not the quoted one. The programme repeated "34 unfinished tasks across 24 flows" for a month; the count is **59 across 26**. The correction is written down with the query that produced it, because this is the third of our own measurements to need correcting in two days.
- AC2: The 59 are categorised by what they actually are, and the categories are counted: scaffold rows superseded by an explicit task list that completed; scaffold rows in a flow where nothing completed; and genuinely named work left open. A single number that mixes bookkeeping with dropped work is what made the original claim overstate.
- AC3: Every disposition is written through `keryx flow task done --disposition ... --reason ...`. No `flow.json` is edited by hand, and no `acceptance-criteria.md` is touched.
- AC4: A scaffold row is closed as `skipped` **with a reason naming why** — that the flow's explicit task list superseded it and completed. `skipped` with no reason is exactly what the task gate refuses, and this flow does not get to do what the gate forbids.
- AC5: Flows 001 and 002 carry named work, not scaffold. Each open task there is read and dispositioned on its own facts. They are **not** bulk-skipped, and if the honest answer is that work was dropped, that is what gets recorded.
- AC6: Flow 116 has only scaffold and nothing completed. It is investigated rather than assumed: either the work was done and never recorded, or it was abandoned. Whichever it is goes in the reason.
- AC7: `keryx flow check` reports no dependency or disposition issue introduced by this flow. Flow 002's pre-existing checksum mismatch is a separate defect and is reported, not silently repaired.
- AC8: The generator is addressed. `flow init` creates four scaffold tasks that most flows ignore, which is what produced 30 of the 59. Either it stops creating them, or it keeps them and the choice is documented with its reason. A cleanup that leaves the source running is a cleanup that will be repeated.
- AC9: Whatever AC8 decides is enforced by a test, not by intention.
- AC10: `bun run typecheck` clean; `bun test` no new failures against the baseline in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
