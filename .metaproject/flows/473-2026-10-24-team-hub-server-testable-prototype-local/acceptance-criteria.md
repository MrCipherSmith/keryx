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

- AC1: Hub authentication, persistent import and role separation reject unauthorized and agent-only review/acceptance; restart retains project data. · sensitive: failure-scenario [verify: exec `bun test src/hub/server.test.ts`]
- AC2: OpenSpec references, frozen criteria, exact-revision wiki review and human Flow acceptance work with stale-base/digest/subject rejection. · sensitive: failure-scenario [verify: exec `bun test src/hub/server.test.ts`]
- AC3: Code revision add/change/delete and context sharing across distinct clone/worktree bindings work; pull refuses unsafe local changes and preserves user files. · sensitive: failure-scenario [verify: exec `bun test src/hub/connector.test.ts`]
- AC4: Git delivery publishes selected content onto a managed branch of a temporary bare remote, retries are idempotent and conflicts do not move the base branch. · sensitive: failure-scenario [verify: exec `bun test src/hub/git-delivery.test.ts`]
- AC5: Browser login, projects, documents, Flow board and exact wiki review are exercised against a live Hub with visible error states and no observed console errors. [verify: judged]
- AC6: Focused prototype tests and project typecheck/lint/build verification are recorded with actual outcomes; any baseline failures are separated from introduced failures. [verify: judged]
- AC7: Docker/direct Linux runbook, environment example, persistent storage/backup instructions, smoke check and release archive/checksum are delivered for the user's server test. [verify: judged]
- AC8: Prototype limitations, storage/auth deviations and lack of unsolicited deployment/PR/merge are documented; application and Docker development environment remain local. [verify: judged]
