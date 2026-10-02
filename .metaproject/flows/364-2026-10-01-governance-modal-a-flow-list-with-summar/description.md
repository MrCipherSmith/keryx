# Governance modal: a flow list with summary, stated effect, a check button and a close button

Status: formalized
Source: user description (2026-10-01)

## Problem

The `/governance` modal in `keryx shell` (`src/tui/governance-inspector.ts`) shows one tab: the stored
`latest.md`, wrapped and scrolled. Per flow it prints status, owner, spend, confirmations, gate attempts
and dispatch runs. It does not say:

- what the flow is about: what was done, or what is still to do;
- the effect the user stated when the flow was created (the `## Outcome criteria` section of
  `description.md`, which `flow init` scaffolds since 0.3.31);
- whether an open flow can be closed now: whether its PR is merged and whether the completion gates
  would pass.

To find out, the user leaves the report and runs `keryx flow status`, `gh pr view` and
`keryx flow complete`, which is a mutating attempt that records a failed attempt and drops the flow back
to `in-progress` when a gate fails. Nothing in the report lets them act on a flow.

## Expected Outcome

The governance modal is an operational surface for flows, not only a reading surface.

- It opens on a list of flows. Each entry shows id, status, title, a short summary (what was done, or
  what is still to do) and the stated effect, or `effect: not stated` when the description has none.
- An open flow (any status but `done`) has a **check** action. Check reports whether the PR is merged
  and how every completion gate would decide, without changing the flow: no status transition, no
  `completionAttempts` entry, no signature, no spent token.
- When the check shows the flow can be closed, a **close** action appears. Close runs the real
  `flow complete` after an explicit confirmation in the modal, and the list repaints with the result.
- The existing full report stays available in its own tab.

## Outcome criteria

- Эффект (MrCipherSmith): я хочу получить прозрачные и простые механизмы управления фло в данном случае оперативно из отчета.
- Observation, proposed by the agent: MrCipherSmith closes an open, merged flow from the governance modal
  (check, then close) without running `keryx flow status`, `gh pr view` or `keryx flow complete` by hand.

## Out of Scope

- Creating, starting, freezing or editing flows from the modal; confirming ACs from the modal.
- Weakening any completion gate. Close is a front end to `flow complete`; it bypasses nothing.
- Minting a confirmation token from the modal. A flow created with `--require-confirmation` still needs
  `keryx flow confirm` in a terminal; the modal says so instead of offering close.
- A model-written summary. The governance report never calls a model; the summary is derived from
  `description.md` and the task list.
- The bookkeeping PR that commits a closed flow's `flow.json` on a push-gated `main`.
- `--all-projects` reports: check and close act on flows of the current project only.
