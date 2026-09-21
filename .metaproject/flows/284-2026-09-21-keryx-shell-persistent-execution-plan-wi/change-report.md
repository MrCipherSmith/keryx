# Change Report: Persistent Shell Execution Plans

## Outcome

Keryx Shell can now persist an optional, structured execution plan with the
session and show it in the sidebar above Background Jobs. The main agent can
create, inspect, and update the plan through typed tools, so progress is tied
to actual agent actions rather than inferred from assistant prose.

## Behavior

- `plan_set` creates or replaces a plan with stable item IDs.
- `plan_update` changes item titles or statuses with revision checks.
- `plan_get` returns the current plan to the main agent.
- A valid plan has at most one `in_progress` item and supports `pending`,
  `in_progress`, `completed`, `blocked`, and `skipped` states.
- Plans survive session resume through the Slate session record.
- The model receives a bounded plan snapshot and one follow-through reminder;
  if work remains afterward, the remaining items are surfaced explicitly.
- The sidebar panel is hidden without a plan, shows at most seven rows, keeps
  the active item centered when possible, and truncates by terminal cell width.

## Main Areas Changed

- Session execution-plan schema, validation, persistence, and revision control.
- Main-agent tool registration and turn follow-through behavior.
- TUI plan projection and conditional sidebar mounting.
- Focused behavioral and integration contract tests.
- Shell source-audit inventory for the layout-order integration assertion.

## Review

The static implementation review found four major and two minor issues. The
follow-up fixed initial-mount ordering, listener isolation after persistence,
remaining-work notices, stale async refreshes after session changes, weak order
coverage, and Unicode-safe terminal truncation. The final review verdict was
`APPROVE` with no remaining blocker, major, or minor findings.

## Verification

- The complete GitHub Actions run for the implementation commit passed.
- Core gate: all tests passed; the documented environment-only skips remained intentional.
- Typecheck, lint, documentation links, security gate, dependency audit,
  client matrices, native OpenTUI matrices, Linux sandbox smoke, macOS real-host
  smoke, VS Code extension, wiki validation, and strict MkDocs build passed.
- Local checks were intentionally not rerun after the final changes per the
  operator instruction to rely on GitHub CI.

## Operator Notes

No command or configuration change is required. Ask the agent to make a plan;
when it uses the plan tools, the Plan section appears automatically. Existing
sessions without a structured plan continue to render without the section.

## Delivery

- Branch: `codex/session-execution-plan`
- Pull request: <https://github.com/MrCipherSmith/keryx/pull/641>
