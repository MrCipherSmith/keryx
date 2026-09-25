# Flow Journal

- 2026-09-25T14:52:23.218Z - flow created
- 2026-09-25T14:52:39.058Z - renumbered: 326 -> 334: ids 326-333 are taken by the parallel Jev programme session (flow packages not pushed yet); allocation is per working copy
- 2026-09-25T14:55:30.646Z - task-added: T5: Survey exclusion-clause conventions in bundled SKILL.md files
- 2026-09-25T14:55:30.909Z - task-added: T6: Implement negation-aware token extraction in scout.ts (entry side)
- 2026-09-25T14:55:31.165Z - task-added: T7: Unit + regression tests for negation-aware scoring
- 2026-09-25T14:55:31.421Z - task-added: T8: Before/after trigger-accuracy measurement + stable pack gate re-check
- 2026-09-25T14:55:31.681Z - task-added: T9: Docs: exclusion clauses are safe to write
- 2026-09-25T14:55:31.934Z - task-added: T10: PR, review/fix loop, CI, merge sequencing
- 2026-09-25T14:55:45.620Z - task-done: T1: Collect remaining context
- 2026-09-25T14:55:45.888Z - task-done: T2: Implement per plan
- 2026-09-25T14:55:46.144Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T14:55:46.396Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T14:55:48.498Z - frozen: 7 criteria; checksum recorded
- 2026-09-25T14:55:48.754Z - started

## 2026-09-25 — T5 survey (exclusion-clause conventions)

Surveyed `src/gdskills/bundled/**/SKILL.md` with `keryx ctx rg`:

- The convention lives almost entirely in the YAML frontmatter `description:`
  field, as `... NOT for <clause>(, and NOT for <clause>)*.` or
  `... NOT for: <clause>.`, frequently followed by a parenthetical
  `(use \`<other-skill>\` instead)`. 37+ bundled skills use this exact
  pattern (e.g. `quality/push`, `quality/db-migrate`,
  `orchestration/job-documenter`, `quality/pr`, `orchestration/issue-analyzer`,
  `platform/hookify`, `quality/deploy`, `orchestration/feature-dev`).
- `triggers:` array entries are, in every sampled case, clean positive
  phrases ("push branch", "git push", ...) — no negation observed inside
  `triggers:` in the bundled catalog. Handling is still written generically
  (any entry text) so a future skill author who puts a negation inside a
  trigger phrase (unusual, but not forbidden) is still covered.
- `NEVER ...` bullets are overwhelmingly in the SKILL.md BODY (workflow /
  guardrail bullets like "NEVER use --force"), which `entryLexicalTokens`
  never reads (`field: "full"` is `name + description + triggers` only) —
  irrelevant to the scorer, out of scope for this token-extraction change.
- Decision (conservative, per flow parameters): exclusion-clause tokens are
  REMOVED from an entry's positive coverage set only. They do NOT get mild
  negative evidence in this change — a negative-weight scheme risks
  penalizing a skill for a topic it explicitly disclaims (e.g. `push`'s
  "NOT for creating the commits" clause mentioning "commit" should not make
  `push` score WORSE against an unrelated query that happens to say
  "commit" in passing); that would trade one silent bias (over-counting) for
  a different one (under-counting) without the calibration data to justify
  it. Recorded as the AC1 conservative choice.
