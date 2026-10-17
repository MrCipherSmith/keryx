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

- AC1: For a PR package (target.ref a PR URL, target.base recorded) with a light dispatch of a 2-file diff, the coverage gate computes the diff at the repository top level against target.base (fallback resolveBase) and accepts the light set; this holds for a package nested under a subdirectory's `.metaproject/reviews`; when git cannot resolve the diff the message names cwd, base and head; readiness runs the same coverage gate and fails exactly when complete would refuse on coverage. Tests per case. · sensitive: failure-scenario [verify: exec `bun test src/review/coverage.test.ts src/review/readiness.test.ts src/review/complete-coverage-gate.test.ts`]
- AC2: A confirmed `reviewer-override` operator decision for the package's head and missing reviewers lets complete pass without any dispatch `override` field; a decision for another head or a different reviewer set does not. Tests. [verify: exec `bun test src/review/complete-coverage-gate.test.ts`]
- AC3: The shell's review-gate nudge names the package this session is reviewing: it prefers the active-review pointer and packages started in this session (including under a subdirectory project root), and never names an open package whose manifest predates the session. Tests. [verify: exec `bun test src/review/completion-gate.test.ts`]
- AC4: A child subagent that ends with no text returns an error outcome (not Completed/ok); in the ledger, a DONE reply without `slices` under a slice manifest is not scope-complete, and a reply that declares a mandatory input unreadable is incomplete. Tests. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts src/review/ledger.test.ts`]
- AC5: research.json lists "Not run: mutation (light round)" only when the package holds no mutation record; an ingest with research but no --reviewers lists the reviewers that actually ran in coverage.md and the manifest. Tests. [verify: exec `bun test src/review/ledger.test.ts src/review/managed.test.ts`]
- AC6: An ingest whose report has findings with unplaceable quotes (absent, or matching several places) records the round: those findings are kept unanchored and flagged `quote_unlocated` (never relocated by similarity), listed in scope.md and by readiness; the round is recorded so the next `review plan` after a fix commit detects it and plans a delta round with the fix roster. Tests including the plan → ingest → fix → plan sequence. · sensitive: failure-scenario [verify: exec `bun test src/review/managed.test.ts src/commands/review-plan.test.ts src/commands/review-plan.e2e.test.ts`]
- AC7: Each dispatch's token use (tokens in/out, model) is recorded in the package when the result envelope carries it — keryx shell spawn_subagent writes it automatically — and research.json and report.md state the round's total; missing usage is stated as unknown, never zero. Tests. [verify: exec `bun test src/review/ledger.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC8: Flows 458 and 459 are closed through the flow CLI (AC confirmations with evidence, implemented, complete). [verify: invariant `keryx flow status 459`]
- AC9: The repository stays green (CI) and a patch release containing this flow is published to npm. [verify: exec `npm view @mrciphersmith/keryx version`]
