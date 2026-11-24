# Desktop Review v2 stage 3: head move

## Problem

When the head of a pull request moves after a Desktop review finished, the review can no longer be published at all: `desk-publish` reports "The pull request is closed or its revision moved" and only a local save remains (spec O8). There is no `on_head_move` setting, and "Review again" starts an unrelated run instead of an update round of the same review. The previous-round rules reject a partial round and a round run with different settings (spec O10).

Source: `docs/requirements/keryx-desktop-review-v2/` (PRD R9, R10; specification "Поведение при смене head"; implementation plan v0.1.3, stage 3, owner decisions D1 and D2).

## Expected outcome

1. The publish dialog offers the D1 variants when the head moved after the reviewed commit: "Publish as is for `<sha>`" is allowed only with the verdict Comment and a first body line that names the reviewed commit and says the pull request moved on. Save locally and Skip stay as they are. Automatic publication still refuses a moved head.
2. `on_head_move` exists as a typed setting with the values `ask`, `follow`, `ignore`; a manual review defaults to `ask` (D2), a rule-triggered review to `follow`.
3. "Review again" becomes an update round of the same Review (blocked on stage 2, see below).
4. The previous-round choice accepts a partially completed round and a round run with other settings, with tests.

## Dependency on stage 2

Stage 3 requires stage 2 (flow 519, branch `feat/desktop-review-v2-stage2`): the update round belongs to the Review entity and its rounds, which stage 2 introduces. The operator chose to start stage 3 before stage 2 lands. Items 1, 2 and the round-independent part of 4 are built first, shaped so they attach to rounds without a rewrite. Item 3 and the parts of item 4 that need rounds (wiring the selection into the run start, the package trust rule) wait for stage 2's rounds migration; this flow records them as blocked until then. No rounds schema is invented here.

## Out of scope

- The Reviews tab, the `reviews` table and the migration (stage 2).
- Wave-boundary head checks in the executor and the `review-orchestrator` "Head moved" procedure (stage 4 for the skill; executor checks go with item 3).
- Carrying finding answers across the update round (goes with item 3).
