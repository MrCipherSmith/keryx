# Implementation Plan

Status: draft — to be confirmed before `flow freeze`

## Approach

Two halves, both needed for the outcome "no repair round after each enrich/collect":
**reversibility** (per-page version history keryx itself writes before changing a page)
and **prevention** (invariant guards in the writers plus validate checks), because a
restore alone still throws away the good part of a run.

### Versioning model — per-page history, no archives

Decided with the user on 2026-10-01 (replaces the earlier tar-snapshot choice): every page
gets its own version folder, holding plain-markdown copies of earlier versions and an
`index.md` that links them, says when each was made and which is current.

Layout — a mirror tree outside the wiki root:

```
.metaproject/data/gdwiki/history/
  <page-path-without-.md>/            e.g. modules/auth/
    index.md                           current version + table of versions
    v0001-2026-10-01T10-26-50Z.md      exact bytes of the page before change #1
    v0002-2026-10-01T11-02-13Z.md
```

`index.md` of a page folder:

```
---
page: wiki/modules/auth.md
current: v0003            # the live page in .metaproject/wiki/
---
| version | when (UTC) | by | run | sha256 | file |
|---|---|---|---|---|---|
| v0003 | 2026-10-01T11:40Z | wiki enrich | run-7f2a | 9c1e… | (live page) |
| v0002 | 2026-10-01T11:02Z | wiki collect --force | run-51bd | 4a0d… | [v0002](v0002-….md) |
| v0001 | 2026-10-01T10:26Z | manual (detected) | — | e77b… | [v0001](v0001-….md) |
```

Rules:

- **Before** a writer overwrites or deletes a page, the current bytes are written as the
  next `vNNNN` file and the index row is added; only then is the page written. If that
  fails, the page is not written.
- A version is recorded only when content actually changes (sha256 differs) — no-op
  rewrites add nothing.
- A page **created** by a run gets a `created` row, so rolling the run back deletes it;
  a page **deleted** by a run keeps its last version, so rolling back recreates it.
- A **manual edit** between keryx runs is caught on the next write: if the live page's hash
  differs from the index's `current` hash, that live content is saved first as a
  `manual (detected)` version, so it is never lost.
- Each command run gets a run id; `keryx wiki restore --run <id>` restores every page that
  run touched to its pre-run version (the "undo the bad enrich" case), and
  `keryx wiki restore <page> [--version vNNNN]` restores one page.
- Retention is per page (keep last N versions, configurable); rotation deletes only
  `vNNNN` files the index lists.

**Why a mirror tree, not a folder next to each page inside `.metaproject/wiki/`:** the wiki
root is read as the current truth — `wiki validate` checks `Type` against folder and every
link, `wiki ask`/gdwiki index every `.md`, and the wiki index lists pages. Old versions in
there would be validated, indexed and answered from as if current. Outside the root they
are invisible to all of that and still plain markdown with clickable links.

**Why not all versions in one file per page:** the file grows without bound, a reader of
the page or the index has to skip past history, and restoring means parsing versions back
out of a combined file instead of copying one file.

Rejected earlier, still rejected: nested git repo inside the wiki (tools walking up for a
repo root, git as a hard dependency, embedded-repo hazard where `.metaproject/` is
tracked); un-ignoring `.metaproject/wiki/` in the host repo (wiki churn in every feature
branch and PR, cross-branch conflicts on generated pages). Projects may still opt into
the latter themselves.

All of this lives in keryx (`src/wiki/`) behind one `writeWikiPage()` / `deleteWikiPage()`
that every writer must use, so a new writer cannot skip history silently.

### Invariant guards

A single `checkPageInvariants(before, after)` used by enrich, deep-enrich, collect and
refresh before any page write: changelog section and entries preserved (append-only),
attestation entries byte-identical, front-matter keys preserved, `Version` ≥ newest
changelog version. Violations → page not written, reported, non-zero exit.
`keryx wiki validate` reuses the same parsers for its new checks, comparing against the
page's previous version in its history folder.

## Steps

1. Context: map every write/delete into `.metaproject/wiki/` (`src/wiki/enrich.ts`,
   `deep-enrich.ts`, `refresh.ts`, `service.ts` collect/sync, `sac/wiki-owner-writer.ts`,
   `keryx update` template writes) via `keryx gdgraph affected` + `keryx ctx rg`.
2. History store: version write, index read/write, manual-edit detection, run ids,
   retention.
3. Route every writer from step 1 through `writeWikiPage()` / `deleteWikiPage()`.
4. `keryx wiki history <page>`, `keryx wiki restore <page> [--version]`,
   `keryx wiki restore --run <id>`; register in `src/standard/command-registry.ts`.
5. Invariant guard + wire into enrich / deep-enrich / collect / refresh.
6. Make `collect --force` merge generated sections instead of replacing whole pages.
7. `wiki validate` checks for Version/changelog/attestation drift.
8. Tests per AC; real-store round-trip (`diff -rq` = 0) recorded as AC2 evidence.
9. Docs: wiki module contract + help text, including what is not covered.
10. Release; verify in vantage-frontend via npm install + `keryx update` (never the dev
    checkout).

## Risks

- A writer missed in step 1 stays unversioned — mitigate with a test that fails on any
  direct `writeFile`/`rm` into the wiki root outside `writeWikiPage()`/`deleteWikiPage()`.
- Page renames/moves: history must follow the page (record `renamed-from` in the new
  folder's index) or the old history is orphaned.
- `collect --force` semantics change may surprise users who relied on full regeneration —
  keep an explicit opt-in flag for the old behavior, still versioned.
- Distinguishing "machine-generated attestation" from prose needs a stable marker; if
  pages don't carry one today, define it and treat unmarked entries as prose.
- `.metaproject/data/` is tracked in this repo: history folders must be gitignored here
  (or the repo will commit every enrich run's versions).
