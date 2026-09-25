# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every filesystem write/mkdir/copy/remove in src/commands/init.ts and src/testing/service.ts goes through src/lib/contained-write.ts; regression tests with an in-project symlink escaping the project (a .metaproject manifest file and a rules directory for init; a testing data path for the service) show nothing is written outside the project, and fail on the pre-fix code.
- AC2: src/lib/metaproject-gitignore.ts writes .gitignore via writeContained; a regression test with a symlinked .gitignore pointing outside the project shows the outside file is unchanged, and fails on the pre-fix code.
- AC3: src/commands/init.ts, src/testing/service.ts and src/lib/metaproject-gitignore.ts are listed in src/lib/contained-write.ratchet.test.ts and the ratchet passes.
- AC4: The audit-harness restricted-agent test uses a UTF-16 BOM body with an auto-run directive and asserts bundle-auto-run-directive; it fails on the pre-fix decode code.
- AC5: R8-F2 (UTF-32 BOM) and R8-F3 (direct-path UTF-16 agent false positive) are each either fixed with a regression test or recorded as a documented limitation in a code comment and the flow journal.
- AC6: Graduation proposals already on disk are re-gated through gateReviewerText on rerun and at graduate apply, and the printed next-step command is recomputed or gated; a regression test with a login configured after the proposal was written fails on the pre-fix code.
- AC7: The model-backed draft's extractor label and evidence sourceRef pass through gateReviewerText (or are replaced by a fixed value) before persisting; a regression test fails on the pre-fix code.
- AC8: The PR into feat/agent-platform-expansion has green CI and a final adversarial review round with 0 blocker and 0 major findings; remaining minors are recorded as deferred with the owner decision.
