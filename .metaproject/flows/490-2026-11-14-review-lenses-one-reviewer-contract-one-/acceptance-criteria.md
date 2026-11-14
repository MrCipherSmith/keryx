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

- AC1: `reviewer-input.schema.json` declares `known_findings` once, and `reviewer-finding.schema.json` accepts an empty `class_scope.sites` only together with a non-empty `enumeration_method`, matching the orchestrator's negative-enumeration example; every consumer of that schema handles the empty list. [verify: exec `bun test src/gdskills/review-lens-contract.test.ts src/review/chunk-findings.test.ts`]
- AC2: The orchestrator states the full list of commands a reviewer may run (the read-only history commands and the read-only layer commands of the layers block) and that a reviewer never runs tests, health checks, servers or any command that writes in the reviewed tree; no lens instructs otherwise. [verify: exec `bun test src/gdskills/review-lens-contract.test.ts`]
- AC3: review-testing-practices, review-verifier and review-degradation route every mutation or written test through a scratch copy (`keryx review mutate`, `keryx review verify-run`) or hand it to the orchestrator as a mutant candidate; review-ui-ux runs a server only when the payload supplies its URL. [verify: exec `bun test src/gdskills/review-lens-contract.test.ts`]
- AC4: No lens assigns a severity to a condition that the canonical rubric (`review-orchestrator/SKILL.md` "Severity (canonical)" and the shared laws) places at a different level; highload's inline Flags and the listed backend/security-code/architecture/clean-code/style/performance/frontend contradictions are resolved. [verify: judged]
- AC5: The stale references are gone from every lens: `keryx wiki query`, hand-offs to `code-style-review` and `code-mobx-store-review`, and the dangling "AC9" in review-verifier. [verify: exec `bun test src/gdskills/review-lens-contract.test.ts`]
- AC6: highload without a load profile, regression/degradation without frozen acceptance criteria, regression on a FIX slice, and ui-ux without a URL each have a stated fallback that names what the reviewer does instead. [verify: judged]
- AC7: review-performance and review-highload each carry a section for CLI/TUI work (per-keystroke/per-file/startup hot paths; concurrent sessions, shared `.metaproject` writes, process fan-out, file locks) that a finding can cite without a request handler or a load profile. [verify: judged]
- AC8: Bench recall (match + 0.5 × partial against historically fixed blocker/major) of review-logic, review-security-code, review-regression and review-testing-practices with the edited lenses is not lower than the pre-change baseline on the same diffs, minus one item of tolerance. [verify: judged]
- AC9: Every edited bundled skill is mirrored byte-for-byte under `.metaproject/skills/gdskills/`, its version is bumped, its length ceiling is respected, and the gdskills and review test suites pass. [verify: exec `bun test src/gdskills src/review/chunk-findings.test.ts`]
