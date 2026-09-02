# Implementation Plan

Status: ready

## Approach

Give the two prose rules a carrier, and give the unowned check an owner. The
pattern is the one `memory` already went through in this same skill: a rule
promoted from advisory to required got typed schema fields and a named step, and
stopped being skipped. Nothing here invents a new mechanism — it applies the
existing one to the two fields that were left behind.

Deliberately NOT chosen: a `keryx review context` subcommand that would build
the pack the way `review scope`/`blast-radius`/`tier` are built. That is the
right long-term shape and it is the real asymmetry (the pack every other step
depends on is the only one still assembled by hand), but it is new CLI surface
plus persistence through `review ingest`, and it does not belong in a change
whose point is to make the existing prose enforceable. Recorded as out of scope.

## Steps

1. `review-context.schema.json` — type `pr` (`number`, `url`, `title`, `body`,
   `state`, `base`, `head`) so `pr.body` is a field rather than a naming
   convention.
2. Same file — add `cross_repo` as a typed array. Items carry `repo`, `reason`,
   `facts`, plus what an unmerged producer needs: `state`
   (`merged|open|unavailable`), `pr`, `branch`, `merge_order`
   (`producer_first|consumer_first|independent|unknown`), and
   `facts_pinned_round`/`revalidated_round`. Use `if/then` so `state: merged`
   requires `sha` and `state: open` requires `pr` or `branch` — the validator
   implements `if`/`then`/`enum`, so these are real constraints, not comments.
3. `reviewer-finding.schema.json` — add `repo` to a finding, so cross-repo
   evidence can name where it lives and the "`info` unless `file:line` at a
   pinned SHA" rule becomes checkable.
4. SKILL.md Step 1 checklist line — name the PR body, memory, and cross-repo
   contracts, so ticking the box means they were collected.
5. SKILL.md Context Pack — replace the `cross_repo` example with one carrying
   the new fields, and add a subsection for a producer that has not merged:
   merge-order severity (consumer-before-producer is a `blocker`, distinct from
   the existing `minor` about a missing deploy note), and per-round
   revalidation of `state: open` facts.
6. SKILL.md Stage 1 gate — when no `issue_url` or task doc exists, the PR body
   is the spec source; the gate owns the description-vs-diff comparison and
   files the existing `minor`.
7. Tests — drive real `review_context` and finding instances through
   `validateJson` against the shipped schemas, and assert the SKILL.md claims
   the schemas now back.

## Risks

- The severity change in step 5 adds a new `blocker` class. A blocker that fires
  wrongly is worse than a missing minor, so it is scoped to the case where the
  producer is recorded `state: open` AND `merge_order: producer_first` — both
  facts the reviewer had to write down deliberately.
- SKILL.md is 1837 lines and heavily cross-referenced; edits must not orphan an
  existing reference to the `cross_repo` shape.
- `review-context.schema.json` is not in the `keryx skills contracts` registry,
  so `contract-keywords.test.ts` does not cover it. Every keyword used here is
  checked against the validator's implemented set by hand (step 7 pins this).
