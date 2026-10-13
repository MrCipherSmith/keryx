# Import and installer CLI polish from flow 360

Status: formalized — backlog; start after flow 362 merges (both touch `src/gdskills/import-skills.ts`).
Source: split out of flow 362 on 2026-10-01 (user approved the plan "flow 362 by plan"); items found while
verifying and reviewing flow 360.

## Problem

1. `reviewer-skill-creator`'s frontmatter carries a routing trigger that names one overlay
   ("import acme reviewers"). Overlay names are not a Keryx concept.
2. `keryx skills install --with <module-id>` for a module outside the profile's closure exits 0 and changes
   nothing; the dry-run `Apply this plan` hint drops `--with`, `--without` and `--include-deprecated`.
3. `keryx skills update` prints the import renderer's `# skills import` / `would import` headings and none of
   the import's warnings (`paths: none`, `flagWarnings`, family-flag). `keryx review --help` and
   `keryx review comments --help` list different flags for `comments reply`.
4. Flow 360 review info items: the CLI says `keryx skills install` overwrites `rules/core` without the
   manifest-form qualification; `model-tier.ts` and `bundled-eval.ts` still parse frontmatter themselves.

## Expected Outcome

Each item fixed with tests; docs that quote affected output updated.

## Outcome criteria

- not measured — defect fixes; the acceptance criteria are the check.

## Out of Scope

- Security-gate behaviour (flow 362).
