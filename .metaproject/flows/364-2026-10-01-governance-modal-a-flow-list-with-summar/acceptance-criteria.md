# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Each `FlowGovernance` entry carries `effect` and `summary`, derived without a model. `effect` is the first usable statement of `description.md`'s `## Outcome criteria` section (the untouched `OUTCOME_HINT` counts as none), or `{ stated: false }` when there is none or the file is unreadable. `summary` names the flow's problem or expected-outcome statement plus done/total tasks and, for a flow not `done`, the titles of its open tasks. A report stored before these fields existed still loads, and its flows render `effect: not recorded`.
- AC2: `renderGovernanceMarkdown` prints an `effect:` line and a `summary:` line under every flow, so `keryx governance report` and `show` carry the same facts the modal shows.
- AC3: The `/governance` modal opens on a Flows tab: one entry per flow with id, status, title, summary and effect; ↑/↓ moves the selection and the selected entry is kept visible. The existing markdown view stays as a second tab, and `r` still re-runs the report.
- AC4: A read-only completion check exists in the flow service and as `keryx flow check-complete <id> [--json]`. It evaluates the same gates `flow complete` evaluates, through one shared gate-evaluation function rather than a copy, and reports the PR's merge state (`merged`, `open`, `closed`, `not found`, `no PR`, `unknown`) read from the tracker. A test shows that after a check — passing or failing — `flow.json` is byte-identical: no status change, no `completionAttempts` entry, no signature, no consumed confirmation token.
- AC5: In the modal, `c` (and a clickable label) runs that check for the selected flow when its status is not `done`; it is not offered for a `done` flow. The result shows the merge state and every gate with pass/fail/skipped and its detail, and for each failing gate the command that would fix it where one is known (for example `keryx flow ac confirm <id> AC2`).
- AC6: The close action appears only when the latest check for the selected flow passed every gate and the PR is merged (or the flow records a merged commit), and the check is no older than the flow's `updatedAt`. It asks for an explicit confirmation in the modal (typing the flow id) before calling the real `flow complete`; any other key cancels. A flow with confirmation required shows `needs \`keryx flow confirm <id>\` in a terminal` instead of close.
- AC7: Close reports the real `flow complete` result in the modal: on success the entry shows `done`; on failure each failed gate is listed and the flow stays openable. The report is re-run afterwards so the list reflects the new state.
- AC8: Tests cover: effect/summary extraction (stated, hint-only, missing section, unreadable file); the stored-report backward compatibility; the check's no-write guarantee; the merge-state mapping; the close button's visibility rules (not done, check passed, merged, stale check, confirmation required); and that a keypress while `inputBlocked()` is true neither checks nor closes.
