# Desktop Review v2 stage 4: shared registry — Head moved procedure, shared publish code, session uses the update command

Status: in progress
Source: operator request (start stage 4 now, independent parts first); plan `docs/requirements/keryx-desktop-review-v2/implementation-plan.md` v0.1.3, row "4. Единый реестр"

## Problem

A review run in an agent session and a review run from Desktop do not share one path:

- `review-orchestrator` has no procedure for a pull request whose head moves during or after a round. It says only "Re-read head and thread before posting. If head moved, re-check findings" with no command (spec O13). Between waves the head is not checked at all (O7).
- There are two publish paths, `keryx review publish` and `keryx review desk-publish`, and only the second has the duplicate guard, the acceptance and the receipt (O15).
- A session has no update command of its own; the spec gives both surfaces one command, `keryx review advance`, which stage 3 introduces.

## Expected Outcome

1. `review-orchestrator` carries a "Head moved" procedure: detection at every wave boundary and before completion and publishing, `on_head_move` with `ask` as the default (D2), the update round, and the D1 publish rule (an old commit is published "as is" only with the Comment verdict, and the first line names the reviewed commit).
2. Publishing from Desktop and from a session runs through one shared code path (`desk-publication` acceptance, receipt and duplicate marker).
3. A session opens the update round with the same command Desktop uses.

Items 2 and 3 require stage 2 (rounds model, flow 519) and stage 3 (update round and publish dialog variants). Until those land, this flow delivers item 1 and the divergence map of the two publish paths with the extraction plan, and records items 2 and 3 as blocked.

## Outcome criteria

- After stage 4 lands, a review started in a session for a PR is published from Desktop with one duplicate guard, and a head move during a session round ends in an operator question, not a silent publish of an old commit. Checked on a real PR (implementation plan, "Проверка", stage 4).

## Out of Scope

- The rounds schema, the `reviews` table and migration (stage 2).
- The publish dialog variants and `on_head_move` storage and UI (stage 3).
- "Fix comments" as a Flow (the remaining part of R7) — planned in the same stage row but not part of this flow's assignment.
- Registering session packages as Attempts beyond what items 2–3 need.
