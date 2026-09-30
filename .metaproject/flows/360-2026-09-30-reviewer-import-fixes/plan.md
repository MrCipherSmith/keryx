# Implementation Plan

Status: ready

## Approach

One flow, one PR against `main`, one commit per task. Code items are test-first: the
failing test is written and seen failing before the fix. Bundled skill text is the source
of truth (`src/gdskills/bundled/`); the `.metaproject/skills/gdskills` tree in this
repository is a projection and is not edited by hand.

Design decisions (made here so workers do not re-decide them):

**D1 — tree import selection (`--only`).** `keryx skills import` and `keryx review import`
both take `--only <glob>` (repeatable, matched against the package directory name). When
`--from` resolves to a directory holding more than one package and the module is `review`,
a missing `--only` is a refusal that lists the candidate package names and shows an
example. The hardcoded `review-vantage-` prefix (`OVERLAY_REVIEWER_PREFIX`) is removed:
it is one overlay's naming, not a Keryx concept. `keryx review import` stays as the
review-shaped spelling (`--module review` implied) and is documented as that, not as an
"alias with an extra filter". A single package directory or a SKILL.md file needs no
`--only`. Rejected: a built-in `review-*` name filter — it admits deprecated aliases and
third-party reviewers nobody selected.

**D2 — deprecated packages.** A package whose frontmatter carries `deprecated: true` is
skipped in a tree import with reason `deprecated`. Named directly (single package path)
it is imported with a warning row.

**D3 — `skills remove`.** `keryx skills remove <module>/<name> [--dry-run] [--json]`
removes the package directory, its `projectSkillRegistry` entry, its row between the
`gdskills:project-skills` markers in `catalog.md`, and its verification report under
`.metaproject/data/gdskills/reports/`. It refuses a bundled skill and an unknown name,
and prints what it removed. Not in the command descriptor registry: the `skills` verb is
deliberately excluded there (see AC3's update in the journal); it answers its own `--help`.

**D4 — rule collisions.** On import an existing cited rule is compared by content:
identical → `present`, different → `differs` (new status). A `differs` rule, and a rule
whose name keryx ships under `rules/core/`, is written to `.metaproject/rules/project/<basename>`
(new status `imported-project` / `would-import-project`), never into `rules/core/`.
Resolution order for a project reviewer citing `core/<name>.mdc`:
`.metaproject/rules/project/<name>.mdc` first, then `.metaproject/rules/core/<name>.mdc`.
`keryx review reviewers --json` gains `shadowedRules: [{ ref, resolved }]` per project
reviewer; `unresolvedRules` honours the same order. Non-colliding rules keep today's
destination. Workers must confirm in source that `keryx update` / `keryx install` does
not write `rules/project/`.

**D5 — other references.** `keryx review reviewers --json` gains `unresolvedReferences`
per project reviewer: backticked `skills/...` or `rules/...` paths ending `.md` / `.json`
that do not exist under `.metaproject/`, and rule references given as an absolute or `~`
path (non-portable: true on one machine). Both are rendered in the markdown output.

**D6 — path gate.** `metadata.flags` (same list syntax as `metadata.paths`) takes
precedence over flags parsed from the description. The description extractor accepts a
literal file path: a token containing `/` with a file extension other than `.md` / `.mdc`
(those are documents a description cites, not triggers). Import prints, per imported
review package, `paths: none — dispatched on every round` when that is the outcome, with
a pointer to `metadata.paths`.

**D7 — family flags.** A flag carried by more than one project reviewer is a family
selector: it selects those reviewers but they stay path-gated. A flag carried by exactly
one project reviewer is explicit and ungated, as today. The inventory computes it:
each project reviewer gets `familyFlags` (subset of `flags` shared with another project
reviewer). `review-orchestrator` text follows.

**D8 — dispatch by package.** For every entry in the `project` half, the dispatch prompt
carries the absolute path of `<path>/SKILL.md` and states that it overrides the agent
type's built-in definition, whichever runtime branch is taken. A missing file makes the
reviewer `BLOCKED` (unavailable), never silently substituted. Text-only change in
`review-orchestrator`, plus `reviewer-input.schema.json` if it needs a field for it.

**D9 — lifecycle bridge.** `useEffect(() => { store.onMount(); return () => store.onUnmount(); }, [store])`
is the documented bridge and is not flagged. What is flagged is a data fetch or business
logic in an effect (`store.loadX()`, `store.init()` doing work the parent store owns).
`review-frontend` lines and `rules/core/mobx-store-template.mdc` "Lifecycle
Initialization" are reconciled to that.

**D10 — packaging and help.** `bundledManifestPath()` resolves from the flat published
`dist/` layout (`<pkg>/dist/cli.js` → `<pkg>/src/gdskills/bundled/install-manifest.json`),
with a test that exercises that layout rather than the source layout. `--help` on a
`review` or `skills` subcommand reaches that subcommand's own help; `keryx review --help`
lists every subcommand the router handles. Profiles are not changed: the orchestrator
text names the skills that may be absent in a non-`full` profile and points at the
manifest installer (`--with`) as the way to add one.

## Steps

1. T5 import selection (D1, D2, import-time `paths: none` warning from D6, prominent dry-run list).
2. T6 `skills remove` (D3). After T5: both touch the command registry.
3. T7 rule collisions and references (D4, D5). After T5: same file.
4. T8 path gate and family flags in the inventory (D6 extractor, `metadata.flags`, D7 `familyFlags`). After T7: same file.
5. T9 manifest path and subcommand help (D10 code). Independent.
6. T10 bundled skill text (D7, D8, D9, D10 text). Independent of code files.
7. T11 worked import example in `reviewer-skill-creator` (item 9), matching the final CLI output. After T5–T8.
8. T12 end-to-end verification on a fixture overlay in a temp project, run from this checkout's source CLI.
9. T13 verification from the built package layout (`dist/`): manifest dry-run and subcommand help.
10. T14 repository gates: lint, typecheck, focused + bundled-skill tests, `keryx health run`.
11. T4 review-orchestrator round, fixes if needed.

## Risks

- `keryx review import --from <tree>` without `--only` becomes a refusal. It is a
  behaviour change for existing users; called out in the PR and the doc.
- The literal-path extractor can turn a cited file into a trigger. Bounded by the
  extension exclusion and covered by tests over real bundled descriptions.
- `rules/project/` resolution is enforced by the inventory and the dispatch text, not by
  a loader: a reviewer run outside the orchestrator still reads what its text names.
  Stated in the doc.
- Never run this checkout's CLI with mutating commands (`init`, `update`, `modules`,
  `mcp install`, `skills import`) against this repository's own `.metaproject/`; all
  end-to-end runs use a temp project directory.
- Full `bun test` has load-induced timeout flakes; use `--timeout 30000` and focused runs.
