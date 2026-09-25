# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/gdskills/bundled/stacks/django/`, `.../fastapi/`, `.../rust/`,
  `.../java-kotlin-spring/` each exist with `pack.json`, `agent-refs.json`,
  `rules/*.mdc` (every rule `extends: common` with a `paths:` glob scoped to
  that stack's file types), and `skills/<name>/SKILL.md` + `evals.json` for
  every skill category the pack ships.
- AC2: Every shipped skill's `evals.json` uses judge-format expectations
  (rubric + pass/fail criteria) with `known_right`, `known_wrong`, `vague`,
  and `subtle_wrong` calibration answers, per
  `docs/docs/guides/write-a-rubric-scenario.md`.
- AC3: `src/gdskills/bundled/install-manifest.json` is wired with modules,
  components, and profiles for all four new packs, valid JSON, and the
  `full` profile includes them.
- AC4: Offline integrity/lint checks (bundled-eval.test.ts and sibling
  guard tests covering frontmatter shape, `metadata.origin`, `paths:`
  glob scoping) pass for the four new packs without editing unrelated
  existing packs.
- AC5: The branch is pushed to `origin/flow/335-w4b3` with the pack content
  committed per pack, and the flow returns `STATUS: READY_FOR_GATE` without
  having run the calibration or honest gate.
