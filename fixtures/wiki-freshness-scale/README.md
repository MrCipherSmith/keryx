# Wiki freshness scale fixture

Flow 236, phase 4, T10 (AC3/AC-22). A GENERATED corpus, not a committed one: the
50/500/2000-page git repositories this benchmark measures against are built at run
time by `scripts/benchmark/wiki-freshness-scale-fixture.ts`'s
`generateFreshnessScaleCorpus(size, seed)`, not checked in byte-for-byte. Committing
a 2000-page synthetic git repository would be dead weight in the tree and would not
even prove reproducibility the way a seeded generator does — the same seed must give
the same corpus, and this directory records the parameters that make that claim
checkable rather than the corpus itself.

## What's committed here

- `manifest.json` — the sizes, seed and category proportions the generator uses.
  Change a number here and re-run the generator to get a materially different
  (but still reproducible for THAT seed) corpus.

## What the generator builds, per size N

1. `git init` a throwaway repo under a temp directory; N synthetic source files
   (`src-gen/mod-NNNNNN.ts`), one per page, committed as the root commit.
2. A small number of "checkpoint" commits after the root (`sqrt(N)`, capped at 20),
   so `VerifiedAt` values cluster onto a handful of shared base revisions instead of
   each page pinning a distinct commit — the shape batching-by-base-revision
   (AFC-22) is meant to exploit.
3. Each page is assigned, deterministically from `seed` and its index via a seeded
   PRNG (mulberry32; no external dependency), to one of four categories at the
   proportions in `manifest.json`:
   - `git-log` (reachable `VerifiedAt`) — the dominant case, and the one that drives
     the measured git-subprocess cost (`cat-file` + `log` + optional `diff`).
   - `git-log-unreachable` — a syntactically valid `VerifiedAt` that is NOT in this
     repo's history (AC12's legitimate fallthrough to the scope-hash basis).
   - `scope-hash` — no `VerifiedAt`, but a frozen `VerifiedScope` value.
   - `undecidable` — neither.
4. Within `git-log` and `scope-hash`-family categories, roughly 70% are marked
   "changed" (their source file is touched in one final mutation commit) and 30%
   "unchanged" — approximating the proportions this task measured on the real
   50-page corpus (26/37 changed among reachable `VerifiedAt` pages).

## Ground truth (the oracle)

The generator records, for every page, the fixture's OWN bookkeeping of which
category it assigned and whether that page's file was touched in the mutation
commit — not a re-derivation via git, and not a call into
`src/wiki/freshness/page-freshness.ts` (the code under test). For the `scope-hash`
family the frozen `VerifiedScope` value is computed by an independent
reimplementation of `computePageNodeHash`'s documented algorithm
(`src/wiki/staleness.ts:50-58`: sha256 of sorted `path:content-sha256` pairs, missing
paths hashing as `<missing>`) written directly in
`scripts/benchmark/wiki-freshness-scale-fixture.ts`, not by importing and calling
that function. See that file's `expectedVerifiedScope` for the reimplementation and
its doc comment for why this is still an independent oracle rather than the
implementation testing itself.

## Reserved, not yet used

`manifest.json` reserves a `dirtyCheckout` variant flag for a future task: AFC-22
requires batching/caching to account for a dirty/untracked working tree, and no
fixture or budget for that exists yet (see the calibration profile's `outOfScope`).
