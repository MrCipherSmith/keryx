# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: One canonical severity rubric exists in `review-orchestrator/SKILL.md`, and the per-reviewer severity tables are deleted rather than left alongside it. `blocker` means merge-blocking only: crash, data loss, an exploitable vulnerability, or an unimplemented acceptance criterion.
- AC2: The `@ts-ignore` contradiction is resolved — one severity, stated once, with the reasoning recorded. No two reviewers assign different severities to the same condition; verified by a search over the reviewer set, not by assertion.
- AC3: Iron Laws 2-4 from `review-security-code` (no reproducible path → INFO; never flag the theoretical; group repeats into one finding) appear in every reviewer, phrased generically. Law 1 (attack vector mandatory) stays security-specific because it does not generalise.
- AC4: A test asserts the Iron Laws are present in every reviewer skill, so a new reviewer added later cannot ship without them.
- AC5: `budget.max_findings` has a stated default of 10 per reviewer, blockers exempt. The default is in code, not only in prose.
- AC6: A spend ceiling exists that **stops and asks** rather than proceeding silently when exceeded. Whether it counts tokens or currency is the implementer's call, argued in the journal.
- AC7: A concurrency cap exists on parallel reviewer dispatch, chosen with the nesting in mind — `review-orchestrator` runs under `flow-orchestrator` and `job-orchestrator`, so the cap must hold across that nesting or state plainly that it does not.
- AC8: The round bound is **3** and is the same number in all four places that currently disagree: `task-implementer`, `job-orchestrator`, `flow-orchestrator`, and `/goal --auto`. Where a different number is deliberate, it is justified in the file that carries it rather than left as drift.
- AC9: Loop detection fires on repetition, not only on count: the same finding identifier recurring twice, or two consecutive attempts producing identical review output, escalates regardless of remaining budget.
- AC10: **Every cap records what it dropped.** A findings cap that truncates, a concurrency cap that queues, a spend cap that stops — each says so in the review record with a count. A silent cap reads as "there was nothing more", which is the failure this programme exists to end.
- AC11: The skill format's accidental divergences from the published Agent Skills spec are removed: `version` is carried in `metadata` only, and `compatibility` is returned to its specified meaning with the harness list moved to a `metadata` key. Applied across every skill, not only the ones this flow touches.
- AC12: The deliberate divergences — `triggers` and per-skill input/output JSON-schema contracts — are documented as deliberate, with the reason, so a later reader does not "fix" them.
- AC13: Reviewers whose checklists target a stack the repository does not use are scoped by detected stack rather than run unconditionally. The detection is deterministic and its failure mode is to include the reviewer, never to skip it.
- AC14: Every skill, rule and schema edit lands in BOTH `src/gdskills/bundled/` and `.metaproject/`, verified by diff. The bundled-rule guard test still passes.
- AC15: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
