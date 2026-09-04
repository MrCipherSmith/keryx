# Review — Living Wiki + Graph phase 0

Reviewed: the merged phase-0 change (PR #448, squashed as `2fee9e09`) — the
wiki graph layer, describe-set resolution, page provenance and reverse
queries.

## Verdict

Three findings, two fixed in place, one accepted with a reason. No finding
challenges the shipped behaviour: the layer is correct on the real corpus
(50 pages, 373 describes edges, 6 undecidable) and the guarantee that made
the design change necessary is pinned by a byte-comparison test.

## Findings

**F-NEW-001 (major, fixed).** The `Describes:` field had two parsers, one in
`describes.ts` and one grown independently in `provenance.ts`. They already
normalised differently — only one handled markdown links — so a page could
resolve one set of paths for its edges and report another as provenance.
This is the same "second, possibly-drifting implementation" failure the
package forbids for module grouping, reproduced inside the package's own
code. The copy is deleted; `provenance.ts` imports the canonical parser.

**F-NEW-002 (minor, fixed).** `buildWikiLayer` selected describable targets
with `!== "asset"`. That negative filter is exactly what broke five call
sites when wiki nodes were going into `nodes.jsonl`, and repeating it here
would admit any future node kind. Now `=== "file"`, with the reason written
down at the site.

**F-NEW-003 (info, accepted).** The layer's bare catch in `buildGraph` makes
a real failure look like a project with no wiki. Kept: it matches the symbol
layer's precedent immediately above it, and a failed graph build is worse
than a missing optional layer. Phase 1's `limitations` channel is the right
place to surface it, and this is recorded there.

## External comments

Collected against PR head `23962dfd`: zero comments. Collection ran — that is
a different fact from no collection, and only the former is clean.
