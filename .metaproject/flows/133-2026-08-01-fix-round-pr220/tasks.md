# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T2–T4 are the ids `flow init` creates. They are used for the first three pieces
of work rather than left as placeholders beside a second set — two numbering
schemes for one flow is how a "done" task stops meaning anything. Their titles
in `flow.json` stay generic; what each one actually is, is here.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Confirm the eleven sites against the review |
| T2 | implement | F-002: the turn store's own bound and typed reads |
| T3 | test | F-001: assemble the turn runner in startServeListener |
| T4 | review | Self-review the fix round against the eleven findings |
| T5 | test | AC1/AC2: the real-socket route test |
| T6 | implement | F-005/F-006/F-007: claim order, distinct ids, terminal event |
| T7 | implement | F-003: an injection finding blocks, at both sites of the class |
| T8 | implement | F-004: one profile ranking, trustMode included, guarded |
| T9 | implement | F-008: the error boundary on the listener |
| T10 | test | F-009/F-010/F-011: the three test defects |
| T11 | review | Verify: full suite, typecheck, health |
| T12 | review | Fix-round review, recorded as a managed package |
| T13 | docs | Update PR #220 and ready it |
</content>
