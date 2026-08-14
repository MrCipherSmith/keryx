# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: One document states that SAC does not replace wiki or graph and shows the complementary FWK split with owners.
- AC2: The same document has a write-map: what each command writes, which owner file is created, and which version or receipt id updates.
- AC3: A fallback run is recorded where the model-backed path refuses without a credential and graph/wiki/memory/SAC reads still succeed.
- AC4: A 3-5 step reproducible scenario block records command, expected, and actual for workspace create → resource bind → overview/explain → propose → review.
- AC5: Residual gaps (no auto model chain, no src/sac wiki component page originally, policy experiment off, no session↔workspace binding) are listed as explicit blockers or deferrals.
- AC6: Every architecture claim in the proof document is backed by a cited file, CLI output, or test name.
