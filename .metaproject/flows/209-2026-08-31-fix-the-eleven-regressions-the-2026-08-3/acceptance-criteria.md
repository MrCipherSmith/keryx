# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx skills verify --bundled` evaluates the shipped skills **from an installed copy**, not only from the repository checkout. Proved by running it against the installed package, or against a fixture laid out the way the package is, and asserting a non-zero denominator. The existing guard asserts 65 from the repo tree and is structurally unable to catch this — a second assertion is required, not a stronger version of the first.
- AC2: `cross_family_review` either has a consumer that reads it back, or the field is removed. It shipped with none, in the commit whose own AC3 forbids exactly that. No third option: a field nothing reads is the defect this programme exists to remove.
- AC3: Build parity is enforced across every skill that ships harness builds, not one. A census found 37 such skills and 36 diverging. Where a divergence is deliberate it goes on a named allow-list with the harness-specific reason; where it is drift it is reconciled.
- AC4: `task-implementer`'s non-Claude builds carry the reporting contract. Production code (`harness/child/contract.ts`) throws unless a child's first line is `STATUS: <TOKEN>`, and four of five shipped builds never ask for it. A test asserts every build of every skill that production parses a status from contains that instruction.
- AC5: The 65-skill sweep reads harness builds, not only `SKILL.md`. It currently walks one file per skill, which is why AC3's divergence was invisible to it.
- AC6: The attempt counter and `dependsOn` are either used by the code that should use them, or removed. Both are written and read by nothing — the `attempts.count` shape this programme has now found four times.
- AC7: The reintroduced dangling references are removed — `agent: "code-review"` and `wave-executor` — and a guard fails the build on a skill naming an agent or skill that is not in the catalogue. The class has recurred three times; a third manual fix without a guard is a fourth recurrence waiting.
- AC8: Loop detection works. It shipped broken and could never fire; a test drives the real path and asserts it fires, and asserts it does NOT fire when it should not.
- AC9: `review-orchestrator`'s remaining false sentence is deleted or made true. It survived the audit that removed its siblings.
- AC10: `README.md`'s status block states what is actually delivered. It still reads that phases 0 and 1 are delivered; all seven are.
- AC11: Every fix is proved by a mutation — break it, watch a named test go red, restore it. A regression found by measurement and fixed without a test that notices its return is the same defect deferred.
- AC12: What this flow does NOT fix is stated explicitly in the flow's journal, with the reason. The measurement listed five things it does not establish, and at least two of them — the 34 historical unfinished tasks, and whether the non-Claude harnesses work at all — are not addressed by fixing these eleven.
- AC13: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
