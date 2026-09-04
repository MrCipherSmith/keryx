# Plan

## Chosen approach

**The markers formalise a contract that is already written down.** LWG-5 is
not a new policy overriding "accepted belongs to the human"; it is the
boundary without which `SKILL.md:110`'s "graph-owned and regenerated" cannot
be honoured at all. The commit and the docs must both say that, or the change
reads as a land grab over human pages.

**Deterministic means provably deterministic.** `wiki refresh` must make zero
provider calls, pinned by a test with a provider that throws on any call —
the same shape phase 0 used for its own no-model guarantee.

**Byte discipline.** Every writer here is judged by diff: `migrate-markers`
changes only marker lines, `refresh` changes only bytes between markers,
`verify` changes only the frontmatter lines it stamps. Each gets a test that
compares the whole file, not the region.

## Steps

1. **Marker parse/serialise** (`src/wiki/managed-block.ts`): locate the
   region, read `v` and `hash`, detect hand edits, replace the region.
2. **`wiki migrate-markers`**: add markers to the existing corpus. Does not
   create a missing Reference section — that would be content, not migration.
3. **Reference rendering from the graph**: reuse the existing renderer that
   `collectGraphWikiCandidates` already uses (`service.ts:525-536`) rather
   than writing a second one; this is the fourth time reuse has been the
   correct call in this package.
4. **`wiki refresh`**: recompute, compare hash, write, bump patch, append
   Changelog, stamp provenance. `--force` for a hand-edited block.
5. **`wiki verify`**: stamp `VerifiedAt`/`VerifiedScope` only.
6. **`wiki validate` extension**: marker well-formedness, `describes` targets
   exist, Changelog monotonic, links resolve.
7. **Registry + tests**, then a real run over this repository's 50 pages.

## Rejected alternatives

- **Section-parsing markdown instead of markers.** Rejected: headings are
  content and a human may legitimately reword one. A marker is unambiguous
  and its hash makes tampering detectable.
- **Overwriting a hand-edited managed block silently.** Rejected: someone who
  edited inside the machine region probably knew what they were doing, and
  the cost of asking is one flag.
- **Stamping provenance automatically during `refresh` for every page.**
  Only pages whose block was actually regenerated get stamped. Stamping an
  untouched page would assert a verification that never happened.

## Risks

- The corpus has one component page with no Reference section at all (42
  pages, 41 with one). Migration must skip it rather than invent content.
- `refresh` on all 50 pages produces a large diff on first run. Expected, but
  it should be measured and stated rather than discovered in review.
- Bumping `Version` on every refresh could churn; patch-only bumps and a
  single Changelog line per change keep it bounded.
