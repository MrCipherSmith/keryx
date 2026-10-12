# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The `reviewer-skill-creator` frontmatter no longer carries a trigger naming one overlay ("import vantage reviewers"); a neutral trigger ("import overlay reviewers") routes the same intent, and the trigger-collision and catalog checks pass.
- AC2: `keryx skills install --with <id>` (and `--without <id>`) naming an id that is not a known component, or that cannot change the plan for the chosen profile, exits non-zero with a message listing the valid ids instead of succeeding silently; the dry-run `Apply this plan` hint reproduces every plan-shaping flag that was passed. Covered by tests.
- AC3: `keryx skills update` prints its own heading and wording (not the import renderer's `# skills import` / `would import`), and a refreshed review package gets the same `paths: none`, `flagWarnings` and family-flag warnings an import of it would print. `keryx review --help` and `keryx review comments --help` list the same flags for `comments reply`, pinned by a test. Covered by tests.
- AC4: The import and `keryx review reviewers` text that says `keryx skills install` overwrites `rules/core` is qualified the way the docs already are (true of the legacy profile route, not of the manifest form with `--target`); `model-tier.ts` `parseSkillModelTier` and `bundled-eval.ts` `frontmatterKeys` read frontmatter through `src/gdskills/skill-frontmatter.ts`, and the reader's header no longer lists them as exceptions.
- AC5: CI on the flow's pull request is green, and `keryx health run` reports no new failure against `main`.
