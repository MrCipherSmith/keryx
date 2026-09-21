# Implementation Plan

Status: filed 2026-09-21 from a live reproduction in two projects. Not started.

## Approach

First decide where the record should move, then fix one place rather than three:

1. Reproduce in a throwaway repository: init, build the graph, commit a change under
   `.metaproject/` only, then run `keryx sync`, `keryx gdgraph build`, `keryx sync
   --apply` and record what each does to `.provenance.json`.
2. Read the three owners — the diff stage (`src/sync/diff.ts`), the graph build path
   and `recordProvenance` (`src/sync/provenance.ts:226`), and the gdwiki baseline gate
   — and decide which one is wrong:
   - the diff stage, if "nothing to rebuild" should still advance provenance to HEAD;
   - `keryx gdgraph build`, if a manual build should stamp what it built;
   - the wiki gate, if "built at an older commit whose code is identical" should be
     accepted.
   The likely answer is the first: a commit that changes no code leaves the graph
   valid, so provenance should advance without a rebuild. Whatever is chosen, the
   other two keep their current behaviour and say why in a comment.
3. Implement the chosen fix with tests, and add one test that pins the disagreement
   itself: after a metaproject-only commit, the wiki baseline can be recorded.

## Risks

- Advancing provenance without rebuilding must not mask a real staleness: the graph is
  only valid if no tracked code file changed between the two commits, which is exactly
  what the diff stage already computes.
- `keryx gdgraph build` writing provenance would make a build on a dirty tree claim a
  commit it did not build; if that path is chosen it must record the tree state too.
