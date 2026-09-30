# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Importing a directory that holds more than one package into module `review` without `--only` is refused by both `keryx skills import` and `keryx review import`, with a message listing the candidate package names; with `--only <glob>` only matching packages are imported; the `review-vantage-` prefix no longer appears in `src/` outside tests and fixtures. Covered by a test over a fixture tree containing a real reviewer, a deprecated alias, a non-reviewer and a bundled-name collision.
- AC2: In a tree import a package with frontmatter `deprecated: true` is skipped with reason `deprecated`; imported by its own path it is imported with a warning. Covered by tests.
- AC3: `keryx skills remove <module>/<name>` removes the package directory, the `projectSkillRegistry` entry, the catalog row and the verification report, supports `--dry-run` and `--json`, refuses a bundled skill and an unknown name, and answers its own `--help`. Covered by tests.
- AC4: When a cited rule already exists with different content, import reports `differs` (never `present`) and writes the overlay's version to `.metaproject/rules/project/`; identical content reports `present`. `keryx review reviewers --json` exposes `shadowedRules` for it and does not list it in `unresolvedRules`. Covered by a test with a fixture rule colliding by filename.
- AC5: `keryx review reviewers --json` reports, per project reviewer, `unresolvedReferences` for a missing backticked `skills/...` or `rules/...` `.md` / `.json` path and for a rule cited by absolute or `~` path. Covered by tests.
- AC6: `metadata.flags` takes precedence over description-parsed flags; a description listing `src/utils/column-zone.ts` beside globs yields that path as a trigger while a cited `.md` file does not; import prints a `paths: none — dispatched on every round` warning for each imported review package that has no path gate. Covered by tests.
- AC7: The inventory marks a flag shared by more than one project reviewer in `familyFlags`, and `review-orchestrator` (SKILL.md and SKILL.detail.md) states that a family flag selects but stays path-gated while a flag unique to one reviewer is explicit and ungated. Inventory behaviour covered by a test.
- AC8: `review-orchestrator` states that every `project` reviewer is dispatched with the absolute path of its registered `SKILL.md`, that the path overrides a same-named agent type's built-in definition, and that a missing file makes the reviewer BLOCKED.
- AC9: Bundled `review-frontend/SKILL.md` and `rules/core/mobx-store-template.mdc` no longer forbid `store.onMount()` / `store.onUnmount()` in a component `useEffect`; both name a data fetch or business logic in the effect as the thing to flag.
- AC10: `bundledManifestPath()` resolves the manifest from a flat `dist/` layout, proven by a test that fails on the previous implementation, and `keryx skills install --profile full --dry-run` run from the built package layout exits 0.
- AC11: `keryx review --help` lists every subcommand its router handles, and `--help` on `skills import`, `skills update`, `skills remove`, `review import`, `review comments` and `review learn` prints that subcommand's own usage. Covered by tests.
- AC12: `review-orchestrator` text marks `review-pr-feedback` and the legacy profile reviewers as present only when installed and names the command that adds a bundled skill to an installed profile; that command is verified to work after AC10.
- AC13: The `reviewer-skill-creator` bundled skill (its `SKILL.md` plus the `SKILL.detail.md` it points at) contains an end-to-end import example consistent with the implemented CLI: dry-run first with real output, what each run writes, how `flags` / `paths` / `pathsSource` / `stackRequires` / `unresolvedRules` / `drift` are derived, what is not a reviewer, how to undo with `skills remove`, the refresh path, the per-clone note, and the `review-learning.config.json` shape. It no longer calls `keryx review import` an alias.
- AC14: `bun run lint`, `bun run typecheck`, the focused test files for the touched modules, and the bundled-skill checks (catalog single-source, bundled-eval, trigger-collision) pass, and `keryx health run` reports no new failure against `main`.
