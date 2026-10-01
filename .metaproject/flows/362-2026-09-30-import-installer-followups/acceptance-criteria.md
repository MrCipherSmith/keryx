# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The `reviewer-skill-creator` frontmatter no longer carries a trigger naming one overlay ("import vantage reviewers"); a neutral trigger ("import overlay reviewers") routes the same intent, and the trigger-collision and catalog checks pass.
- AC2: When the security gate changes or refuses imported content, the import says so: a rule or SKILL.md whose content the gate rewrote (for example a redacted secret) is reported on its row as rewritten by the gate, in text and in `--json`; content the gate's prompt-injection detection flags is not written and the row gives the reason. Covered by tests with a rule carrying a secret and a rule carrying instruction-override text.
- AC3: `keryx skills install --with <id>` (and `--without <id>`) naming an id that is not a known component, or that cannot change the plan for the chosen profile, exits non-zero with a message listing the valid ids instead of succeeding silently; the dry-run `Apply this plan` hint reproduces every plan-shaping flag that was passed. Covered by tests.
- AC4: `keryx skills update` prints its own heading and wording (not the import renderer's `# skills import` / `would import`), and a refreshed review package gets the same `paths: none`, `flagWarnings` and family-flag warnings an import of it would print. `keryx review --help` and `keryx review comments --help` list the same flags for `comments reply`, pinned by a test. Covered by tests.
- AC6: `keryx skills remove` has tests that fail when the name half of the segment check in `resolveTarget` is removed (a registry entry named `..` or `.` must be refused — flow 360 finding F-010, mutant R02) and when trailing-slash normalisation of a registry path is removed (flow 360 round-2 mutant R06).
- AC5: `bun run lint`, `bun run typecheck`, the focused test files for the touched modules and the bundled-skill checks pass, and `keryx health run` reports no new failure against `main`.
