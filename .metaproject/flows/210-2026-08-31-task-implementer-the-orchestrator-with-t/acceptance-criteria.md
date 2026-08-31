# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every mechanism `task-implementer` documents is enumerated with its section, the sentence that makes the claim, and the search that classified it — the same method Phase 7 used on `job-orchestrator`. The measurement recorded **2 wired of 88**; this flow must produce the inventory that number came from, not trust it.
- AC2: Each mechanism is classified `wired` / `prose-only` / `advisory`. `wired` names a production `file:line` **and** the entry point reaching it. A call site found only in a `*.test.ts` is `prose-only` — that rule is why the number is 2 and it does not get relaxed here.
- AC3: Every `prose-only` mechanism is resolved by being **wired** or by having its **claim deleted**. Softening the verb is explicitly not a resolution. Carried unchanged from flows 205, 206, 207 and 209 because it is the rule that made those flows produce anything.
- AC4: The two mechanisms that ARE wired are both the `STATUS:` first line. Whatever else this flow changes, that contract stays enforced and stays present in all five builds — it is the only thing standing between a child's output and a thrown parse.
- AC5: Where `task-implementer` duplicates a mechanism that already exists in code, it calls the code instead of restating it. The same rule that moved `keryx review tier`, `keryx review loop` and `keryx job` out of prose applies here; name each instance found.
- AC6: Every fix is proved by a mutation — break it, watch a named test go red, restore it. A claim wired without a test that notices its unwiring is the defect this flow exists to remove, reintroduced.
- AC7: All five builds and both trees carry every edit, byte-identical where parity requires it. The build-parity guard now enrols every skill with harness builds, so this is enforced rather than promised.
- AC8: The before/after is recorded as a number against the measurement's baseline of 2 of 88, in the flow journal. A flow that improves an orchestrator without saying by how much cannot be compared to the next one.
- AC9: What this flow does NOT fix is stated explicitly with the reason. `task-implementer`'s scope touches the harness contract, and anything left unaddressed there must be named rather than left for a later measurement to rediscover.
- AC10: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
