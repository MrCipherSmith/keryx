# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every mechanism `job-orchestrator/SKILL.md` claims — each step, gate, cap, bound, artifact and hand-off — is **enumerated** in a written inventory, with its section number and the sentence that makes the claim. The inventory is the deliverable; a conclusion without it is a skim.
- AC2: Each enumerated mechanism is classified as `wired` (a production code path reaches it), `prose-only` (nothing does), or `advisory` (it is guidance to the model and makes no claim of enforcement). The classification carries the search that established it, not an opinion.
- AC3: `wired` requires naming the caller: file:line of the production call site, and the entry point that reaches it. A call site found only in a test file is `prose-only`, not `wired` — that distinction is the entire finding class this audit exists for.
- AC4: Every `prose-only` mechanism is resolved one of two ways: the mechanism is **wired**, or the claim is **deleted**. Softening the verb — turning "is enforced" into "should be done" — is explicitly not a resolution and fails this criterion.
- AC5: Every fix that wires a mechanism is proved load-bearing by a mutation: break the wire, watch a named test go red, restore it. A wire with no test that notices its absence is the defect being fixed, reintroduced.
- AC6: The duplicate section number `2.8.1` (`VERIFY-POST-FIX` and `PERF-CHECK`) is resolved, and a guard prevents a duplicate heading number from returning.
- AC7: The five per-harness builds (`SKILL.md`, `SKILL.codex.md`, `SKILL.cursor.md`, `SKILL.opencode.md`, `SKILL.zed.md`) are compared. Every difference between them is either explained as deliberate harness-specific content, or removed. The 1.7K size gap between `SKILL.md` and the other four is accounted for specifically.
- AC8: A guard enforces whatever invariant the builds are found to hold, so a future edit to one build that should have touched all five fails the suite rather than drifting silently.
- AC9: `input-contract.schema.json` and `output-contract.schema.json` are checked against what the skill says it consumes and emits. Every required field has a producer; every field the skill writes exists in the schema.
- AC10: Both trees are updated for every skill and contract edit — `src/gdskills/bundled/` is the source of truth and `.metaproject/` is a generated install target overwritten with force on every `keryx update`. Verified by diff, and the existing mirror guards still pass.
- AC11: The audit's findings are recorded as a managed review round with real dispositions, not as a prose summary — the same standard flow 204 was held to. A finding marked fixed carries a commit SHA and a verifier verdict against it.
- AC12: Any mechanism that is genuinely unimplementable or not worth wiring is recorded with an explicit reason and an operator decision, never dismissed on the orchestrator's own authority.
- AC13: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
