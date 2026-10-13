# Review round 1 — flow 360

Range `838e5263..43e803be`. Reviewers: review-logic, review-security-code, review-architecture
(with clean-code), review-testing-practices (mutation pass: 103 run, 28 survived),
review-regression, spec/doc gate, review-verifier. Counts: blocker 0, major 6, minor 21, info 4.
All six majors reproduced by the raising reviewer and confirmed by review-verifier
(probes `f001.ts`–`f006.ts` in the session scratchpad `r360/`). Line numbers are as of `43e803be`.

Not ingested by the reviewer (its harness refused the report write). Orchestrator decisions are
under each finding as **Decision**.

## Major

**F-001 — `skills remove` deletes outside the project through a symlinked `project-skills` component, then fails half-way.**
`src/gdskills/remove-skill.ts:130` (lexical `isPathInside`), `:148` (unregistered branch), `:210`/`:221` (raw `rm` / `rmdir`).
`.metaproject/project-skills/review` is a symlink to a directory outside the project, registry entry `review/victim`.
Dry run prints only in-project paths; the real run deletes `<link target>/victim`, then throws `ENOTDIR` on `rmdir`
of the link. Registry entry and catalog row are gone, the report stays, a second run says "not found". Same with
`project-skills` itself a symlink and with an unregistered `<module>/<name>`.
**Decision:** fix. Realpath the package parent and the `project-skills` root and require containment before touching
anything; use the existing `removeContained` / `rmdirIfEmptyContained` layer (`src/gdskills/guarded-fs-ops.ts`) and add
the file to the contained-write ratchet. Validate everything before the first mutation so a refusal leaves no partial state.

**F-002 — a registry `path` is not bound to its own `<module>/<name>`.** `remove-skill.ts:125-136`, `:242` (`isTargetEntry`).
A: entry `review/alpha` with path `.metaproject/project-skills/review` → removing it deletes every skill in the module.
B: path `.metaproject/project-skills/quality/gamma` → deletes gamma and gamma's entry while alpha stays on disk.
**Decision:** fix. A registered path is accepted only when it equals `.metaproject/project-skills/<entry.module>/<entry.name>`;
otherwise refuse, naming the entry.

**F-003 — import guards test the raw package name; the writer uses the slug.** `src/gdskills/import-skills.ts:621-624` (`importOne`), also `:176`, `:435`, `:568`.
Tree with `review_logic` and `review_house_api`, `--only 'review*'`, no `--force`: overwrites an existing
`review/review-house-api` and registers a project reviewer named `review-logic`; dry run says `would-import`.
Newly reachable through `review import` because the prefix filter was removed.
**Decision:** fix. Slugify once when the source is built; guards, destination and reported row all use that value.

**F-004 — `rules/project/` is keyed on the basename.** `src/gdskills/rule-references.ts:36` (`projectRulePath`), `:61`; `import-skills.ts:904`, `:950`.
One import cites `core/x.mdc` and `house/x.mdc` with different contents: the first lands in `rules/project/x.mdc`, the
second is reported `differs … pass --force` against that just-written file and is installed nowhere; `shadowedRules`
points both refs at one file; dry run promised `would-import` to `rules/house/x.mdc`.
**Decision:** fix by keying the project slot on the full ref: `.metaproject/rules/project/<dir>/<name>.mdc`
(`core/x.mdc` → `rules/project/core/x.mdc`). Resolution order becomes `rules/project/<ref>` then `rules/<ref>`.
Dry run and real run must agree on destination. Docs follow in fix D.

**F-005 — technology-pair prose becomes a path trigger and gates the reviewer off every round.** `src/review/reviewers.ts:272` (`isLiteralFilePath`), `:295`, `:325`.
Description `React/Next.js conventions reviewer.` with no glob → `paths: ["React/Next.js"]`, `pathsSource: "description"`
(base: `none`, dispatched every round), and no `paths: none` warning. Same for `Express/Node.js`, `and/or.ts`.
**Decision:** fix. A literal path is a trigger only when the description also yields at least one glob (AC6's wording is
"beside globs"). Literal-only descriptions stay `pathsSource: none`.

**F-006 — `metadata.flags` entries taken verbatim make a reviewer unselectable and defeat `familyFlags`.** `reviewers.ts:338` (`reviewerFlags`), `:215`, `:501`.
`flags: [acme]` → `["acme"]`; `["--Acme "]` keeps case and space; `flags: --acme --house` is one entry; a YAML
block list is silently ignored. Three spellings of one flag → `familyFlags: []` → the correctly spelled reviewer is
dispatched without the path gate.
**Decision:** fix. Normalise (trim, lower-case, split on commas/whitespace, prefix `--` when absent), accept a YAML block
list for `metadata.flags` and `metadata.paths`, and drop entries that still do not match `^--[a-z][a-z0-9-]*$` with a
warning visible in `keryx review reviewers` (text and JSON) and in the import output.

## Minor

- **F-007** `remove-skill.ts:319` — registry `module`/`name` interpolated unvalidated into the report path; a crafted entry deletes `<outside>/a-b-verification.json`. **Decision:** fix (apply `SEGMENT` to registered entries).
- **F-008** `reviewers.ts:501` — an imported package declaring another reviewer's unique flag turns it into a family flag for both. **Decision:** fix (warn at import on a flag collision with an existing project reviewer).
- **F-009** `import-skills.ts:67-82` (`optionValues`) — empty `--only ""` is dropped; with `--module quality` the whole tree imports. **Decision:** fix (error on an empty value).
- **F-022** `import-skills.ts` (`frontmatterCategory`) — matches `category:` anywhere in the file, so a fenced example in a body makes a non-review tree "target module review". **Decision:** fix (one frontmatter-bounded reader for category, name, deprecated).
- **F-010** `remove-skill.test.ts` — the `SEGMENT` check and the root-equality clause of `resolveTarget` survive deletion. **Decision:** add the two cases.
- **F-011** no test drives `--only` through either command (`import-skills.ts:1118`, `import-reviewers.ts:55`, `review.ts:498`). **Decision:** one test per command through `skillsCommand` / `reviewCommand`.
- **F-012** AC4 fixture only collides on a keryx-shipped name; `collides` at `import-skills.ts:950` never decides. **Decision:** add a collision under a non-shipped name.
- **F-013** `--only` anchoring, `?` and literal escaping (`import-skills.ts:422-424`) unpinned. **Decision:** add a prefix-sharing sibling, a `?` case, a dotted name.
- **F-014** report lookup by body and by conventional name mask each other. **Decision:** one non-conventional filename with matching `skillPath`, one conventional name with an unrelated body.
- **F-015** rule-import branches with no fixture: rules for deprecated-/bundled-skipped sources, the post-gate `present` re-check, a gate-blocked rule, a direct `project/x.mdc` citation. **Decision:** add fixtures.
- **F-016** `remove-skill.ts` — catalog-row module cell, installed-tree half of the bundled refusal, `path` clause of `isTargetEntry` survive. **Decision:** fixture with one name in two modules.
- **F-017** unpinned parse clauses: metadata-level `deprecated`, flag de-duplication, `.MD` case-folding, the `..` exclusion, packaged-first order in `defaultBundledSourceRoot`. **Decision:** pin them.
- **F-018** `import-skills.ts:16` — first production `gdskills → review` import; directories now mutually dependent. **Decision:** fix (move `reviewerPathGate` and its pure helpers into gdskills, re-export from review).
- **F-019** `remove-skill.ts:63-70`, `:100`, `:319` — hand-copies the on-disk format `project-skills.ts` writes. **Decision:** fix (export and share).
- **F-020** `src/commands/skills.ts:1758` — a `skills` subcommand needs four registrations with no parity test. **Decision:** add the source-derived parity test `review` has.
- **F-021** `import-skills.ts:903-910` — re-implements the order `resolveRuleReference` owns. **Decision:** fix with F-004.
- **F-023** `import-skills.ts:885-1015` — `importReferencedRules` (~130 lines) outgrew one responsibility; F-004 lives in it. **Decision:** split where F-004/F-021 touch it; `sourceFromDirectory` and `renderReviewerInventoryMarkdown` only if the fix already reshapes them.
- **F-024** `import-skills.ts:67` — generic `optionValues` lives in the importer. **Decision:** move to `src/lib/args.ts`.
- **F-025** text names a `keryx install` command that does not exist: `reviewer-skill-creator/SKILL.detail.md:139`, `:205`, `:434`; `review-orchestrator/SKILL.detail.md:80`; `import-skills.ts:276`, `:926`; `reviewers.ts:600`. **Decision:** fix (name `keryx skills install` / `init` / `update`, whichever is true at each site).
- **F-026** AC13 names `SKILL.md`; the example lives in `SKILL.detail.md`. **Decision:** done — AC13 amended via `keryx flow ac update`.
- **F-027** `review-orchestrator/SKILL.detail.md:121`, `:177`; `SKILL.md:1088` — "in the `bundled` half means installed" is false when `bundledSource` is `package`. **Decision:** fix (qualify with `bundledSource: "project"`).

## Info (not fixed in this flow unless free)

- **F-028** rule import follows a symlinked source rule and searches `rules/` up to three levels above the package (pre-existing).
- **F-029** `--only` compiles to a backtracking regex (35 s on a thirteen-star pattern); operator-typed.
- **F-030** handler-level `--help` guards in `runComments` / `runLearn` are unreachable from any test.
- **F-031** `skill_path` means two things in the orchestrator skill (project-only in the input schema, required in the prompt for a bundled fallback). **Decision:** reconcile the wording in fix D, it is one sentence.

## Checked clean

`--help` interception (198 invocations, base vs HEAD); path triggers on 9 overlay + 28 bundled descriptions; `skills remove`
argument/registry traversal; rule references cannot climb out of `rules/`; `bundledManifestPath()` in both layouts; the worked
example reproduced row for row.
