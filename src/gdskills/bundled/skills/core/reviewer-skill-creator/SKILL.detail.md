# Reviewer Skill Creator — detail

Overflow reference for `core/reviewer-skill-creator`, linked from its SKILL.md
section "Bulk import of overlay reviewers". Nothing here overrides SKILL.md.

## Importing reviewers from an overlay — a worked example

The output below was produced by running the commands against this tree, kept
inside the project at `vendor/acme-overlay`. Lines cut for length are marked `…`.

```
vendor/acme-overlay/
  skills/
    review-acme-api/SKILL.md       reviewer; triggers and flags only in its description
    review-acme-styling/SKILL.md   reviewer; declares metadata.paths and metadata.flags
    review-acme-naming/SKILL.md    reviewer; its description names one file and no glob
    review-acme-legacy/SKILL.md    `deprecated: true` alias of review-acme-api
    acme-review/SKILL.md           the overlay's own review entry point (an orchestrator)
    review-logic/SKILL.md          the overlay's copy of a reviewer keryx ships
  rules/core/
    error-handling.mdc             same filename as a rule keryx ships
    acme-api.mdc                   a name only the overlay has
```

The project already has one reviewer of its own, `review-house-api`, selected
by `--api` and gated on `src/api/**`. It matters in section 2.

`--from` takes that tree (a directory of packages, or a parent that contains
`skills/`), or one package directory. `keryx review import` is the review-shaped
spelling of `keryx skills import --module review`: one importer, the module
implied. For a non-review skill, or a GitHub `SKILL.md` URL, use
`keryx skills import` directly.

### 1. A tree without `--only` is refused

```
$ keryx review import --from ./vendor/acme-overlay
keryx review import: ./vendor/acme-overlay holds 6 packages and the import targets module review, where review-orchestrator dispatches every package it finds. Say which ones with --only <glob> (repeatable; matched against the package directory name).

Candidates:
  - acme-review
  - review-acme-api
  - review-acme-legacy (deprecated — skipped in a tree import)
  - review-acme-naming
  - review-acme-styling
  - review-logic (bundled keryx skill name — skipped unless --force)

Example:
  keryx review import --from ./vendor/acme-overlay --only 'review-acme-api'
```

Exit code 1, nothing written. The reason is what module `review` means:
`review-orchestrator` dispatches every package registered there, and a package
with no path gate is dispatched on every round. A tree imported whole brings its
entry point, its deprecated aliases and whatever else sits beside the reviewers,
and each of those becomes a sub-agent that runs on every review. So the
selection is yours to state, not something inferred from how one overlay names
its packages. The candidate list is the input for that decision: read it and
write the glob.

`--only` is a glob over the package **directory name** as it is on disk (`*`
any run of characters, `?` one), and it is repeatable: `--only 'review-acme-*'
--only 'code-acme-*'`. A glob that matches nothing is refused with the same
list. A single package directory, or a `SKILL.md` file, needs no `--only`.

An `--only` with no glob in it is an error, not "no selection":

```
$ keryx review import --from ./vendor/acme-overlay --only ''
keryx review import: --only needs a glob; an empty value selects nothing. Pass a package directory name or a glob over them (`*`, `?`), or drop --only.
```

The directory name is what you select by; the **slug** of that name is what
gets written. A directory `review_acme_api` is matched by `--only
'review_acme_*'` (and by `--name review_acme_api` in `keryx skills import`),
and lands as `review/review-acme-api`: the destination, the "already exists"
and bundled-name checks, and the row the import prints all use the slug. Two
selected directories that slug to one destination are refused before anything
is written — here a tree holding both `review-dup` and `review_dup`:

```
$ keryx review import --from ./dup --only 'review*' --dry-run
keryx review import: review-dup and review_dup both import as review/review-dup. Narrow --only to one of them, or rename one directory.
```

### 2. Dry-run first

```
$ keryx review import --from ./vendor/acme-overlay --only 'review-acme-*' --dry-run
# skills import

from: ./vendor/acme-overlay
dry-run: yes
force: no
imported: 0 overwritten: 0 updated: 0 skipped: 1 would-import: 3 would-overwrite: 0

## would import (3) — dry run, nothing written

- review/review-acme-api
- review/review-acme-naming
- review/review-acme-styling

## packages

- review/review-acme-api: would-import — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: flag --api is carried by one existing project reviewer, review-house-api: it becomes a family flag for both, so --api now selects review-house-api path-gated instead of dispatching it outright.
- review/review-acme-legacy: skipped — deprecated
- review/review-acme-naming: would-import — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: paths: none — dispatched on every round. Declare `metadata.paths: "<glob>, <glob>"` in its frontmatter to gate it on the diff.
- review/review-acme-styling: would-import — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: metadata.flags: "--acme_css" dropped — a flag is `--` and a name of lower-case letters, digits and dashes that starts with a letter

A package whose frontmatter says `deprecated: true` is skipped in a tree import. To import one anyway, pass its own directory as --from.

## rules the skills cite

- core/acme-api.mdc: would-import — from vendor/acme-overlay/rules/core/acme-api.mdc (cited by review-acme-api)
- core/acme-styling.mdc: unresolved — no rules/ directory beside the source has it (cited by review-acme-styling)
- core/error-handling.mdc: differs — .metaproject/rules/core/error-handling.mdc is not the overlay's version; the overlay's would be written to .metaproject/rules/project/core/error-handling.mdc, which is the file the reviewer would read — from vendor/acme-overlay/rules/core/error-handling.mdc (cited by review-acme-api)
…
```

Read three things off it before running for real:

- **The `would import` list is the whole answer to "what lands".** Here the glob
  also matched `review-acme-legacy`, and it is skipped as `deprecated` — a tree
  import skips a deprecated package even with `--force`. `acme-review` and
  `review-logic` did not match the glob, so they are not rows at all.
- **Every `warning:` row.** There are three kinds here, and each is a decision
  to make before the real run:
  - `paths: none` — that reviewer will run on every round whatever the diff
    touches. The remedy is `metadata.paths` in the overlay's frontmatter
    (section 4).
  - `metadata.flags: … dropped` — an entry of the declared list is not a flag
    and will not select the reviewer. Fix the spelling in the overlay.
  - `flag … is carried by one existing project reviewer` — the import changes
    how a reviewer the project **already has** is dispatched. Until now `--api`
    dispatched `review-house-api` outright; once a second reviewer carries it,
    `--api` is a family flag for both and each stays path-gated. If the
    existing reviewer must keep its own flag, rename the flag in the overlay.
    The warning is about reviewers that were on disk before the import and are
    not replaced by it; packages arriving together that share a flag (`--acme`)
    are the overlay's own family and get no warning.
- **Every rule row that is not `would-import` or `present`.** `unresolved` means
  the reviewer will cite a rule the project will not have. `differs` means a
  file already answers that reference with other content.

A dry-run does not run the security gate that a real run applies to every file
it writes, so a `would-…` status can be optimistic: the real run may still block
a package, or report a rule as `unresolved` with `blocked by the security gate`.

### 3. The real run, and what it writes

```
$ keryx review import --from ./vendor/acme-overlay --only 'review-acme-*'
# skills import

from: ./vendor/acme-overlay
dry-run: no
force: no
imported: 3 overwritten: 0 updated: 0 skipped: 1 would-import: 0 would-overwrite: 0

- review/review-acme-api: imported — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: flag --api is carried by one existing project reviewer, review-house-api: it becomes a family flag for both, so --api now selects review-house-api path-gated instead of dispatching it outright.
- review/review-acme-legacy: skipped — deprecated
- review/review-acme-naming: imported — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: paths: none — dispatched on every round. Declare `metadata.paths: "<glob>, <glob>"` in its frontmatter to gate it on the diff.
- review/review-acme-styling: imported — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: metadata.flags: "--acme_css" dropped — a flag is `--` and a name of lower-case letters, digits and dashes that starts with a letter
…
## rules the skills cite

- core/acme-api.mdc: imported — from vendor/acme-overlay/rules/core/acme-api.mdc (cited by review-acme-api)
- core/acme-styling.mdc: unresolved — no rules/ directory beside the source has it (cited by review-acme-styling)
- core/error-handling.mdc: differs — .metaproject/rules/core/error-handling.mdc is not the overlay's version; the overlay's was written to .metaproject/rules/project/core/error-handling.mdc, which is the file the reviewer reads — from vendor/acme-overlay/rules/core/error-handling.mdc (cited by review-acme-api)

A reviewer that cites `<dir>/<name>.mdc` reads `.metaproject/rules/project/<dir>/<name>.mdc` when that file exists,
and `.metaproject/rules/<dir>/<name>.mdc` otherwise. `keryx init`, `keryx update` and `keryx skills install` overwrite
rules/core with keryx's own rules and leave rules/project alone. `keryx review reviewers` lists each such reference
under `shadowedRules`.

Reviewers: `keryx review reviewers` must list every imported review/* name. That is the same call review-orchestrator makes.
```

Per imported package, four things now exist:

- **The package directory** `.metaproject/project-skills/review/<name>/`, holding
  `SKILL.md` and `skill-changelog.md`. The import copies `SKILL.md` and the rules
  it cites, nothing else: a checklist, template or script the reviewer points at
  is not brought along (section 4, `unresolvedReferences`).
- **A header stamped into `SKILL.md`**, directly after the frontmatter. The body
  below it is the source's, unchanged:

  ```
  Version: 1.2.0
  Target: review-acme-api
  Module: review
  Origin: vendor/acme-overlay/skills/review-acme-api/SKILL.md
  Origin Hash: sha256:d6cfb23a47093ac46c5b1788bd1325cbba0c08b76e749c40f371f474589eef2f
  Imported At: 2026-09-30T15:49:48.204Z
  Status: active
  Last Verified: never
  ```

  `Origin`, `Origin Hash` and `Imported At` are what drift is computed from.
  `Origin` is recorded project-relative when the source is inside the project,
  as `~/…` when it is under the home directory, and absolute only otherwise — an
  absolute origin is true on one machine and reads as drift `missing` on every
  other.
- **A `projectSkillRegistry` entry** in `.metaproject/metaproject.json`
  (`modules.gdskills.projectSkillRegistry`):

  ```json
  {
    "module": "review",
    "name": "review-acme-api",
    "target": "review-acme-api",
    "path": ".metaproject/project-skills/review/review-acme-api",
    "version": "1.2.0",
    "status": "active",
    "updatedAt": "2026-09-30T15:49:48.246Z"
  }
  ```
- **A catalog row** in the Project Skills section of `.metaproject/skills/catalog.md`:

  ```
  | review | review-acme-api | `review-acme-api` | .metaproject/project-skills/review/review-acme-api/SKILL.md |
  ```

**Rules.** For each backticked `.mdc` rule a selected package cites, the import
looks for the file in a `rules/` directory beside the overlay's skills and
reports one status:

- `imported` — the project did not have it; copied to `.metaproject/rules/<ref>`
  (here `acme-api.mdc`, into the project's `rules/core`).
- `present` — the project already has it, identical to the overlay's, or the
  overlay has no version to compare with.
- `differs` — a file already answers that reference with other content. The
  overlay's version is written to the reference's project slot,
  `.metaproject/rules/project/<dir>/<name>.mdc`, and the existing file is left
  untouched. This is the ordinary case for a filename keryx also ships
  (`error-handling.mdc` above, written to `rules/project/core/`): the file in
  `rules/core` is keryx's generic rule, not the overlay's.
- `imported-project` — a `core/<name>.mdc` that keryx ships under the same name
  and the project has no file for yet; the overlay's goes to
  `.metaproject/rules/project/core/<name>.mdc` rather than to `rules/core`,
  because `keryx init`, `keryx update` and `keryx skills install` overwrite
  `rules/core` with keryx's own rules.
- `unresolved` — no `rules/` directory beside the source has it. Add the file by
  hand, or the reviewer keeps citing a rule the project lacks.

The project slot keeps the whole reference, directory included:
`core/error-handling.mdc` resolves to
`.metaproject/rules/project/core/error-handling.mdc` first and to
`.metaproject/rules/core/error-handling.mdc` second, and a
`house/error-handling.mdc` would resolve to
`.metaproject/rules/project/house/error-handling.mdc` first — two rules with
one filename never share a slot. A file lying directly in `rules/project/` is nobody's slot:
it is read only by a reviewer whose text cites it literally, as
`project/<name>.mdc`. Nothing loads rules for a reviewer, so the order takes
effect in one place: `review-orchestrator` reads `shadowedRules` from the
inventory and tells the reviewer, in its dispatch prompt, which file to read. A
reviewer run outside the orchestrator reads what its text names. An existing
project-slot copy that differs from the overlay's is left as it is — it may be
a hand edit — unless `--force` is passed.

Running the same command again is safe and is how rules are fetched for an
import made earlier: packages come back `skipped — already exists; pass --force
to overwrite`, and the rule rows are re-resolved — `present` for both files
written above, the second with `the reviewer reads
.metaproject/rules/project/core/error-handling.mdc`.

### 4. Reading `keryx review reviewers`

```
$ keryx review reviewers
…
## project-local

- review-acme-api (vendor/acme-overlay/skills/review-acme-api/SKILL.md — clean)
  - paths: src/api/**, src/server/routes.ts [description]
  - flags: --acme, --acme-api, --api
  - family flags: --acme, --api — shared with another project reviewer: selects it, stays path-gated
- review-acme-naming (vendor/acme-overlay/skills/review-acme-naming/SKILL.md — clean)
  - paths: none — dispatched on every round [none]
  - flags: --acme-naming
- review-acme-styling (vendor/acme-overlay/skills/review-acme-styling/SKILL.md — clean)
  - paths: src/**/*.css, src/theme/** [metadata]
  - flags: --acme, --acme-styling
  - family flags: --acme — shared with another project reviewer: selects it, stays path-gated
  - warning: metadata.flags: "--acme_css" dropped — a flag is `--` and a name of lower-case letters, digits and dashes that starts with a letter
- review-house-api (house/review-house-api/SKILL.md — clean)
  - paths: src/api/** [description]
  - flags: --api
  - family flags: --api — shared with another project reviewer: selects it, stays path-gated

## rules cited but not in .metaproject/rules

- review-acme-styling: core/acme-styling.mdc
…
## rules read from .metaproject/rules/project

- review-acme-api: `core/error-handling.mdc` → .metaproject/rules/project/core/error-handling.mdc
…
```

This is the call `review-orchestrator` makes (with `--json`), so what it prints
is what a round will do. `review-house-api`'s last row is what the import
warned about: `--api` is now a family flag for it. The frontmatter the three
imported rows were derived from:

```yaml
# review-acme-api — nothing declared; everything is read out of the description
description: |
  Use when reviewing Acme API handlers against the Acme error contract.
  Dispatched for --acme, --acme-api, --api, --all, or changes under src/api/** and
  src/server/routes.ts. NOT for styling.
metadata:
  stack_requires: "http-server"

# review-acme-styling — declared; the description is not consulted for these
metadata:
  paths: "src/**/*.css, src/theme/**"
  flags:
    - acme
    - --Acme-Styling
    - --acme_css

# review-acme-naming — a file path in prose, and no glob anywhere
description: |
  Use when reviewing names against the Acme naming guide. Dispatched for
  --acme-naming or --all. The pattern to follow is in src/app/names.ts.
```

How each field of a `project` entry in `--json` is derived:

- **`flags`** — `metadata.flags` when it has entries; otherwise every `--flag`
  the description names. `--all` is excluded either way: it selects every
  reviewer already. `metadata.flags` and `metadata.paths` take the same three
  spellings: a comma-separated string, a flow list (`[a, b]`) or a YAML block
  list as above. A declared flag entry is normalised before anything compares
  it: split on commas and whitespace, trimmed, lower-cased, and given `--` when
  it has no leading dash — so `acme` and `--Acme-Styling` above became `--acme`
  and `--acme-styling`.
- **`flagWarnings`** — one line per `metadata.flags` entry that is still not
  `--` plus a lower-case name after normalising (`--acme_css` above). The entry
  is dropped from `flags`, and the line is printed as a `warning:` row here and
  on the import row. A declared list replaces the description even when nothing
  in it survives: the reviewer then has no flags, a second line says so, and it
  is selected by its paths or by `--all`. Empty when there is nothing to say.
- **`familyFlags`** — the subset of `flags` that at least one other project
  reviewer also carries (`--acme` and `--api` above). A passed family flag
  selects the reviewer and leaves it path-gated; a passed flag only this
  reviewer carries (`--acme-styling`) selects it explicitly, with no path gate.
- **`paths` and `pathsSource`** — `metadata.paths` when declared
  (`pathsSource: metadata`); it wins. Otherwise the triggers found in the
  description (`pathsSource: description`): any token with a `*` that looks like
  a path, and — only in a description that has at least one such glob — any
  literal repo-relative file path beside it, such as `src/server/routes.ts`;
  `src/**/*.ts(x)` expands to both spellings. A cited document (`.md`, `.mdc`)
  and a path under `.metaproject/` are never triggers, and neither is prose
  without a glob or an extension (`date/temporal utils`). A description with no
  glob yields no trigger at all, whatever file paths it names: prose is full of
  things shaped like one (`React/Next.js`), and a trigger that matches no file
  would gate the reviewer off every round. That is `review-acme-naming` above —
  `src/app/names.ts` is not a trigger, the entry has `paths: []` and
  `pathsSource: none`, and the reviewer is dispatched on every round, with the
  import warning.

  The description reader works on prose, so it can be wrong in both directions:
  beside a glob, a file the description merely mentions ("see src/app/main.ts
  for the pattern") becomes a trigger, and a directory named without a glob
  yields nothing. When the printed `paths` are not what the reviewer should be
  gated on, declare `metadata.paths` in the overlay's frontmatter and refresh
  the import — do not reword the description until the guess comes out right.
- **`stackRequires`** — `metadata.stack_requires`, a comma-separated list of the
  tags `keryx review stack` knows (`nestjs`, `react`, `mobx`, `prisma`,
  `playwright`, `sql`, `http-server`). An unknown tag is dropped, which leaves
  the reviewer unscoped rather than excluded.
- **`unresolvedRules`** — backticked `.mdc` rules the text cites that exist
  neither at `.metaproject/rules/project/<ref>` nor at `.metaproject/rules/<ref>`.
  Printed under "rules cited but not in .metaproject/rules". The reviewer is
  still dispatched; add the rule, or accept that it reviews without it.
- **`shadowedRules`** — `[{ ref, resolved }]`: rules the text cites as
  `<dir>/<name>.mdc` that the project-slot copy answers first — above,
  `{ "ref": "core/error-handling.mdc", "resolved":
  ".metaproject/rules/project/core/error-handling.mdc" }`. Printed under
  "rules read from .metaproject/rules/project". Expected after a `differs` or
  `imported-project` row; it is a fact to check, not a defect.
- **`unresolvedReferences`** — `[{ ref, reason }]`, printed under "references
  that do not resolve". `missing`: a backticked path starting `skills/` or
  `rules/` and ending `.md` or `.json` with no file at that path under
  `.metaproject/` — the import did not bring it; copy it there or edit the
  reference out. `non-portable`: a rule cited by an absolute or `~` path, which
  exists on one machine at most; cite it as `core/<name>.mdc` instead.
- **`drift`** — `clean`, `changed` or `missing`, from re-hashing the file
  `Origin` names against `Origin Hash`; `none` when no origin was recorded. It
  is the word after the dash on the reviewer's row. A remote (`https://`) origin
  always lists as `clean`: listing opens no connection, and `keryx skills
  update` is what re-reads it.

## What is not a reviewer

Module `review` is a dispatch list, not a folder for review-adjacent skills. A
package belongs there only if it can be handed a bounded diff and return
`REVIEW_RESULT` under the orchestrated review contract. Leave these out of
`--only`:

- **An orchestrator, facade or entry point** (`acme-review` above). Registered
  as a reviewer it is dispatched as a sub-agent of the round it was written to
  run.
- **A deprecated alias.** The tree import skips a package whose frontmatter says
  `deprecated: true`; one whose deprecation is only stated in prose is yours to
  exclude.
- **A report generator, comment interpreter or other post-processing skill.** It
  consumes findings; it does not produce them.
- **Anything with no review contract** — a rule digest, a style guide, a
  checklist with no output schema.
- **A copy of a reviewer keryx ships** (`review-logic` above). It is skipped
  unless `--force`, and forcing it shadows the bundled one.

Naming a package by its own directory is the operator asking for it, so none of
the tree protections apply: a deprecated package is imported, with a warning.
If one of these is worth having in the project, import it under another module
(`keryx skills import --from <package-dir> --module orchestration`): it is
registered for `keryx skills route` and is not dispatched by review rounds.

## Undo

```
$ keryx skills remove review/review-acme-naming --dry-run
Would remove project skill: review/review-acme-naming
- would remove: registry entry — .metaproject/metaproject.json
- would remove: catalog row — .metaproject/skills/catalog.md
- would remove: package directory — .metaproject/project-skills/review/review-acme-naming
- absent: verification report — .metaproject/data/gdskills/reports/review-review-acme-naming-verification.json
Dry run: nothing was changed.

$ keryx skills remove review/review-acme-naming
Removed project skill: review/review-acme-naming
- removed: registry entry — .metaproject/metaproject.json
- removed: catalog row — .metaproject/skills/catalog.md
- removed: package directory — .metaproject/project-skills/review/review-acme-naming
- absent: verification report — .metaproject/data/gdskills/reports/review-review-acme-naming-verification.json
```

One skill per call. It removes the four things an import registered, plus the
`review/` directory when that was the last skill in it; `absent` means the part
was already gone and is not an error, so a removal interrupted half-way is
finished by running it again.

The command deletes a directory recursively and takes its target from a
registry anyone can edit, so it checks where it is about to reach and refuses
(exit 1) before changing anything — a refused run leaves the registry, the
catalog and the disk as they were:

- a bundled skill, or a name that is not a project skill;
- a symlink where something would be deleted: `.metaproject/project-skills`
  itself, the module directory, or the package. It does not delete through the
  link and does not unlink it; remove the link by hand if that is the intent;
- a registry entry whose `path` is not its own
  `.metaproject/project-skills/<module>/<name>` — an entry pointing at the
  module directory or at another skill's package would otherwise delete that;
- a registry entry whose key is not two plain path segments.

A verification report is removed only when it is this skill's: a report whose
body names another package (`skillPath`) is left alone even if its file name
matches.

It leaves in place, deliberately: the rules the import copied into
`.metaproject/rules/` — `rules/project` included — because other skills may
cite them; runtime exports under `.metaproject/runtime/skills/`; and learning
proposals under `.metaproject/data/gdskills/proposals/`. Delete a rule by hand
once nothing cites it, and check with `keryx review reviewers` that no reviewer
lists it as unresolved afterwards.

## Refresh when the origin moves

After the overlay's `review-acme-api/SKILL.md` was edited:

```
$ keryx review reviewers
…
- review-acme-api (vendor/acme-overlay/skills/review-acme-api/SKILL.md — changed)
…
## origins that moved on

- review-acme-api: `vendor/acme-overlay/skills/review-acme-api/SKILL.md` changed since 2026-09-30T15:49:48.204Z
…
$ keryx skills update review/review-acme-api --dry-run
…
## would import (1) — dry run, nothing written

- review/review-acme-api (overwrites the existing one)
…
$ keryx skills update review/review-acme-api
…
- review/review-acme-api: updated — review-orchestrator will dispatch this after `keryx review reviewers` lists it
```

`changed` does not mean the reviewer is wrong; it still runs, from the older
text. `keryx skills update <module>/<name>` (or `--all`) re-reads each `Origin`
and overwrites the project's `SKILL.md`, re-stamping the hash — so an edit made
to the imported copy is lost. If the project deliberately differs from the
overlay, make the change in the overlay, or record the divergence and leave the
row `changed`.

`keryx skills update` refreshes `SKILL.md` only; it reports no rule rows. When
the overlay's rules moved too, re-run the import. `--force` on the import
overwrites packages that already exist and replaces a project-slot copy
(`rules/project/<dir>/<name>.mdc`) that differs from the overlay's:

```
$ keryx review import --from ./vendor/acme-overlay/skills/review-acme-styling --force
…
- review/review-acme-styling: overwritten — review-orchestrator will dispatch this after `keryx review reviewers` lists it
  - warning: metadata.flags: "--acme_css" dropped — a flag is `--` and a name of lower-case letters, digits and dashes that starts with a letter
  - warning: flag --acme is carried by one existing project reviewer, review-acme-api: it becomes a family flag for both, so --acme now selects review-acme-api path-gated instead of dispatching it outright.
…
```

The second warning is worth reading twice on an overwrite. The package being
replaced is left out of the comparison, so `review-acme-api` looks like the
only carrier of `--acme` — but `--acme` was already a family flag through the
copy being replaced, and nothing changes for `review-acme-api`. Check
`family flags` in `keryx review reviewers` before acting on it.

An origin that reads `missing` cannot be updated from: pass the new location
with `keryx skills update <module>/<name> --from <new-origin>`.

## Registration is per clone where `.metaproject/` is ignored

Everything above lives under `.metaproject/`. Many projects git-ignore that
directory, and then an import registers reviewers in the clone it ran in and
nowhere else: a teammate, a fresh worktree and CI see none of them until the
import is run there too. Check with `git check-ignore .metaproject` before
telling anyone the reviewers are wired for the team.

Where `.metaproject/` is tracked, commit what the import wrote:
`.metaproject/project-skills/review/`, the registry entry in
`.metaproject/metaproject.json`, the catalog row, and the rules — including
`.metaproject/rules/project/`, which `keryx init`, `keryx update` and
`keryx skills install` neither write nor clean, so a clone that lacks it
silently reads keryx's generic rule under the same name. Keep the overlay at a path that resolves for everyone
(inside the repository, or the same `~/…` location), or `drift` reads `missing`
on every machine but the importer's.

## `review-learning.config.json`

Optional, and separate from importing: it names which pull-request comment
authors `keryx review learn` may turn into lessons for one project skill. The
file is `.metaproject/review-learning.config.json`:

```json
{
  "schemaVersion": 1,
  "skill": "review/review-acme-api",
  "repo": "acme/shop",
  "authors": ["alice", "bob"],
  "reviewerProfiles": ["alice"]
}
```

- `schemaVersion` — required, exactly `1`.
- `skill` — required, `<module>/<skill>` naming a project skill under
  `.metaproject/project-skills/`: one `/`, no whitespace. The loader checks the
  shape only.
- `repo` — required, `owner/repo`: the repository whose collected comments
  teach that skill.
- `authors` — required, at least one GitHub login. Matching is
  case-insensitive and otherwise exact. A present file with no authors is an
  error rather than a pass that teaches nothing.
- `reviewerProfiles` — optional array of logins that also get a per-reviewer
  profile rule. Every entry must be one of `authors` (case-insensitive);
  omitted means nobody gets a profile.

There are no defaults: every required field must be present. No file at all is
the supported "this project does not learn" state and is not an error; a file
that is present and malformed is refused with the field named.
