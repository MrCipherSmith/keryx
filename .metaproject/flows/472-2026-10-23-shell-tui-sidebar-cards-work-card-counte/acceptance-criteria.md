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

- AC1: Work counters derive active/successful totals from store statuses without counting failures as successful completion. [verify: exec `bun test src/tui/sidebar-work.test.ts`]
- AC2: Clicking a structured entity row opens its inspector in a temporary tab of the same card modal. [verify: exec `bun test --timeout 30000 src/tui/sidebar-cards.test.ts`]
- AC3: Returning to a source tab removes the temporary tab and runs cleanup; Escape from a temporary tab returns to its source. [verify: exec `bun test --timeout 30000 src/tui/modal-host.test.ts src/tui/sidebar-cards.test.ts`]
- AC4: Embedded inspectors reuse existing presenters, update live, and release subscriptions when disposed. [verify: exec `bun test src/tui/sidebar-work.test.ts`]
- AC5: TypeScript reports no errors after integration. [verify: exec `bun run typecheck`]
