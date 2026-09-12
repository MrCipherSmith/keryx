# Context map — re-verified 2026-09-12 against `ea569c92`

`ea569c92` is the squash merge of flow 257 (PR #540), the skill quality gate.
`description.md` and `plan.md` were written before it landed. Everything below
was measured on this branch; where it contradicts them, this file wins.

Baseline green at cut: `bundled-eval.test.ts`, `routing-corpus.test.ts`,
`catalog-single-source.test.ts`, `skill-name-matches-directory.test.ts` →
327 pass / 0 fail; `skills verify --bundled` → all 23 checks pass.

## What one new bundled skill now costs

Seven artefacts, not the three `description.md` names. In order, each with the
test that fails if it is skipped:

1. `src/gdskills/bundled/skills/<category>/<name>/SKILL.md` — category one of
   core, orchestration, review, quality, planning, platform. Frontmatter:
   `name` equal to the directory (`skill-name-matches-directory.test.ts:43`),
   `description`, `triggers`, `metadata.version`, `metadata.category` equal to
   the directory, and `compatible_harnesses` including `claude` if declared.
   Fails `bundled-eval.test.ts:192`.
2. Registration in `BUNDLED_GDSKILLS` (`src/gdskills/catalog.ts:30`) — fails
   `bundled-eval.test.ts:1995` and `catalog-single-source.test.ts:103`. The
   trigger list must not share an **order-free token set** with any other
   skill (`catalog-single-source.test.ts:145`).
3. The install mirror under `.metaproject/skills/gdskills/…` — no test demands
   it, but once present it is swept for dangling agent names
   (`agent-catalogue-xref.test.ts:220`).
4. A `SKILL_LENGTH_CEILINGS` entry (`skill-length-ceilings.ts:103`) keyed
   `<category>/<name>` and **equal** to the line count — fails
   `bundled-eval.test.ts:1791` in both directions. No entry means the default
   ceiling of 500.
5. A `ROUTING_CORPUS` entry (`routing-corpus.ts:213`): at least 3 positives and
   2 negatives; at least 2 positives quoting none of the skill's own triggers;
   no positive equal to a trigger; every negative naming a real, different
   catalog skill that must score strictly above; every positive in the top 3.
6. `RANK1_FIRST` / `RANK1_TOTAL` (`routing-corpus.ts:203-204`, **285/287**
   today) re-measured in the same diff — equality, so an improvement fails too.
7. `keryx skills verify --bundled` clean (`skills.bundled-verify.test.ts:38`).

`anatomy:sections` demands all three of: a literal `not for` clause; a Red
Flags / rationalization heading whose section holds a table of at least 3 data
rows, each row at least 2 non-empty cells and at least 24 characters of cell
text, not byte-identical to another skill's; and a Verification / exit-criteria
heading with a non-blank body, or a `STATUS: <UPPER>` line, or a status enum.

A description must contain "Use when" / "Use to" / "Use for"; must not open
`Use when <bare verb>` (37 verbs, plus 14 noun-ambiguous ones behind a
determiner — use the gerund); must be at most 1024 characters; and must score
under 0.75 Jaccard on route tokens against every other description.

## The collision field is empty

Scored with `scoreBundledSkillRoute` over all 78 catalog entries, for 20 user
phrasings covering the six proposed additions: the highest incumbent score is
**30**, and most sit at 10-20. Six draft descriptions inserted into the
collision check produced **zero** pairs at or above 0.40; the highest existing
pair in the shipped tree is `consistency-checker :: spec-writer` at 0.581.
Nothing approaches 0.75.

The hazard is not the topic but the wording: naming an existing skill in a
description hands it a +30 skill-name bonus, which is the mechanism both
recorded `KNOWN_ROUTING_GAPS` document. A "NOT for … (see review-verifier)"
clause on the doubt skill would give `review-verifier` 30 points on every query
containing "verifier".

## Corrections to `description.md`

- **"`interviewer` accepts hedged answers as approval and states no
  confidence" is false.** Flow 257 gave it a three-value confidence enum
  (`interviewer/SKILL.md:46`), a Red Flags row rejecting "I understood the
  gist" (`:116`), a row rejecting an inference marked `certain` (`:117`), and a
  Verification line requiring a confidence value per answer (`:126`). What
  remains is narrower and is what this flow should address: nothing forbids
  `ready_to_proceed: true` on a hedged but non-vague answer, and the
  confirmation step itself carries no per-question confidence gate.
- **`THIRD_PARTY_NOTICES.md` does not exist, and creating it at the repo root
  would ship nothing.** `package.json` `files` publishes `dist`,
  `docs/requirements/shared-agent-context/schemas`, `src/gdgraph`,
  `src/gdskills/bundled`, `src/gdskills/contracts`, LICENSE, README and
  package.json. The repo's actual convention is an inline MIT credit in the
  adapting document, as `docs/skills/rejected-skill-changes.md` does. Follow
  the convention rather than inventing a file that does not reach users.
- **"definition of done spread across three rules" is unverified** —
  `description.md` names none of them. Measure before writing.
- `plan.md`, `tasks.md` and `acceptance-criteria.md` in this package are
  untouched templates.

## Where the floor guard belongs

`keryx review scope` (`src/review/scope.ts`) is the only diff-scoped machinery:
`buildReviewScope(diff)` returns scoped regions with added lines and drop
reasons. It classifies paths and regions and does **not** read line content.
`blast-radius` is file-level through the graph — wrong layer. Health takes no
diff; its sources are whole-repo. The security hooks scan content for secrets,
not diffs. Nothing in the repo detects a lowered threshold, an added
`.skip`/`.only`, a removed assertion or a new suppression. The guard is a new
consumer of `buildReviewScope`, and a new CLI surface.

## The `task-implementer` output contract

Schema at
`src/gdskills/bundled/skills/orchestration/task-implementer/output-contract.schema.json`,
registered as `task-implementer-output` (`contracts.ts:368`) with
`enforcement.kind: "none"` — the skill writes the file and no keryx command
reads it back. `additionalProperties: false`, so a new field must be declared
or a compliant result is refused by its own contract. It carries no version
field, and nothing pins one the way `export.ts` pins `schemaVersion`. Tests to
follow: `task-implementer-contract.test.ts` (21 references),
`contract-enforcement.test.ts`, `contract-keywords.test.ts`.

## Rules

`src/gdskills/bundled/rules/` has exactly one subdirectory, `core/` (34 files).
Rules are neither length-checked nor anatomy-checked and have no catalog
registration; they are swept only for dangling path references (`xref:path`)
and dangling agent names. Install copies them to `.metaproject/rules/core`.

## The ratchet bites us

Every skill this flow must edit sits **exactly** at its ceiling:
`task-implementer` 670/670, `interviewer` 131/131, `perf-check` 104/104,
`review-performance` 374/374. The rule we shipped in 257 forbids raising a
ceiling, and the test pins equality in both directions. So every addition to
those files must be paid for with a trim of the same size in the same commit,
or by moving content into a sibling document. This is the ratchet working as
designed, and it is the main constraint on how this flow is sequenced.

`RANK1_FIRST`/`RANK1_TOTAL` is a serialization point: two tasks adding skills
in parallel both edit `routing-corpus.ts:203-204` and conflict. Skills are
added in one lane, with the record re-measured once at the end of that lane.
