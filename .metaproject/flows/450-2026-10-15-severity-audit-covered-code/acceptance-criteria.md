# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `auditSeverity` raises a minor/nit/info finding to major on a surviving behaviour mutant only when no mutant in the same file has status `killed` or `timeout` in any recorded pass; when at least one does, the severity is held and `severity_audit.held` carries `kind: "covered"`, the mutant id, the evidence id and a reason that names the kill count (`k of n mutants in <file> killed`). [verify: exec `bun test src/review/severity-audit.test.ts`]
- AC2: Unchanged behaviour is pinned by tests: a presentation-only survivor is still held with `kind: "presentation"`; a cited mutant no run executed still caps a major at minor with the label `unproven`; a blocker is never touched; an `invalid` mutant counts as neither killed nor survived. [verify: exec `bun test src/review/severity-audit.test.ts`]
- AC3: A replay on a synthetic package shaped like PR 7643 (three minor test-quality findings citing survivors in files that also have killed mutants, one finding citing a survivor in a file with no killed mutant) ends, through `auditPackage`, with the first three at minor with held notes and the fourth at major, and `readReviewParity` lists the three held notes. [verify: exec `bun test src/review/severity-audit.test.ts src/review/parity.test.ts`]
- AC4: The held line printed by `keryx review severity-audit`, `keryx review report-parity` and `keryx review status` says why a covered survivor did not move the severity, and no surface prints a held note as a raise. [verify: exec `bun test src/review/parity.test.ts src/commands/automatic-review.test.ts`]
- AC5: The rule is stated in `review-orchestrator/SKILL.md` (Severity (canonical): a survivor shows a missing assertion, not wrong behaviour), in `SKILL.detail.md` (Severity audit), in `docs/docs/guides/review-with-a-record.md` and in `docs/docs/cli-reference.md`, and the old sentence "raises a minor finding to major" is gone from `src/gdskills` and `docs/docs`. [verify: invariant `! grep -rn "raises a minor finding to major" src/gdskills docs/docs`]
- AC6: `bun run check` is green and the CHANGELOG records the behaviour change. [verify: exec `bun run check`]
