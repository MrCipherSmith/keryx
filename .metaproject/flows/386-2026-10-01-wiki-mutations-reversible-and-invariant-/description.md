# Wiki mutations are reversible and preserve page invariants: snapshot before enrich/collect/sync, and enrich/collect stop dropping changelog, attestations and Version

Status: formalized
Source: user description (2026-10-01 incident in a downstream project, vantage-frontend)

## Problem

In a downstream project (vantage-frontend) `.metaproject/` is entirely gitignored, so
`.metaproject/wiki/` has no version history at all. On 2026-10-01 a single
`keryx wiki enrich --all --force` run:

- rewrote 98 of 504 pages, then died on a provider 406 mid-run;
- replaced hand-written prose irreversibly — no layer (git, keryx, provider) held the
  previous text;
- dropped the `## Changelog` section from 6 pages;
- reworded machine-generated attestation entries in its own words on 5 pages;
- left front-matter `Version` lower than the newest changelog entry on 2 pages.

Every one of these was repaired by hand. `keryx wiki validate` reported none of them: it
checks `Type` against folder and links, but never compares `Version` with the changelog,
never notices a missing `## Changelog`, and never notices a rewritten attestation.

`keryx wiki collect --force` is destructive in its own right: it strips front-matter and
replaces curated prose with generator output, so it cannot serve as a recovery path either.

The result: every `enrich` / `collect` / `update` cycle costs a round of manual repair, and a
bad run cannot be undone.

## Effect (stated by the user)

> правильное и актуальное содержание вики, без постоянных фиксов и исправлений при каждом
> апдейте и collect и enrich

(Correct and current wiki content, without a round of fixes and repairs after every
`keryx update`, `collect` and `enrich`.)

## Expected Outcome

The wiki stays correct and current without a manual repair round after each
`enrich`, `collect`, `sync --apply` or `keryx update`:

1. **Reversible, per page.** Before any keryx command overwrites or deletes a wiki page,
   the page's previous version is kept as a plain markdown file in that page's own history
   folder, next to an `index.md` listing every version, when and by what it changed, and
   which is current. One command restores a page, or every page one run touched. No
   archives. Built into keryx's page writer, not a wrapper script.
2. **Invariant-preserving.** enrich and collect never drop `## Changelog`, never rewrite
   machine-generated attestation entries, never strip front-matter, and never leave
   `Version` behind the changelog. A page the model returns in violation of these is
   rejected (kept as-is, reported), not written.
3. **Detectable.** `keryx wiki validate` fails on the drift classes above, so a regression
   from any source — including manual edits and older keryx versions — is caught.
4. **Partial runs are safe.** A run that aborts mid-way (provider 406, Ctrl-C) leaves
   either the pre-run state recoverable in one command or only fully-written,
   invariant-valid pages.

## Outcome criteria

- After the next `keryx wiki enrich --all --force` in vantage-frontend (on a release
  carrying this flow), `keryx wiki validate` reports 0 changelog/Version/attestation
  findings and no page needs hand repair; if anything regressed, `keryx wiki restore --run
  <id>` returns the store to `diff -rq`-identical pre-run state.

## Out of Scope

- Changing page content, `Status`, or versions of any existing page in any project.
- Putting `.metaproject/wiki/` under the host repo's git (rejected as the default: the wiki
  describes the code of the current branch, and committing it would leak churn into every
  feature branch — see plan.md). Projects may still opt in on their own.
- Network sync / remote backup of snapshots.
- Improving enrich's prose quality beyond the invariants listed.
