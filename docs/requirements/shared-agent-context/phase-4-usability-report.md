# SAC Phase 4 — Usability Evaluation

Date: 2026-08-12

## Method

Two contract-only walkthroughs were evaluated with an unfamiliar component:

1. Onboarding: create/show a workspace, then call `workspace collaboration`
   (or `sac.collaboration`) to find the linked worktree and safe activity.
2. Handoff: owner records a minimal handoff event through the collaboration
   facade; the recipient repeats the overview command and follows only the
   `artifactRef`/reference IDs.

## Results

- Both clients expose the same normalized overview shape; MCP remains
  local-stdio-only and denies HTTP.
- No walkthrough needs a client-supplied identity, role, or direct file write.
- Activity contains actor/reference/timestamp metadata only, not session text.

## Actionable gaps

- Add a trusted Harness-issued session-reference adapter before enabling a
  user-facing `session` reference writer.
- Add a fixture corpus for collaboration overview parity once stable owner
  operations are exposed through CLI and MCP.
- Consider a TUI/IDE panel only after those fixture contracts are stable; it
  must remain a read-only client of this facade.
