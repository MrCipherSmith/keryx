# Plan

## Approach

Reuse stage 1's Create Flow end to end; add only what is specific to findings.

1. `apps/desktop/src/reviews/model.ts`:
   - `openFindingCount(findings)` = blocker + major + minor (info is not a fix target).
   - `fixFindingsTarget(review, viewer)` → `{ card, runId } | null`: non-null only when the Review is not closed or archived, is not queued/running/needs_answer, has a PR card in state `open` whose `author` equals `viewer` (case-insensitive), a reference attempt (newest unarchived attempt in a finished state with a `reviewed` range, from `review.rounds`) and `openFindingCount(review.findings) > 0`.
   - `fixFindingsPrompt(review, target, runId)`: one prompt naming the PR URL, the round, the reviewed range (short SHAs), the open counts, that info findings are left out, and the exact command `keryx review desk-run status --json --repo <repo> --repository-id <id> --viewer <login> --number <n> --id <runId>`; asks flow-orchestrator to create the fix Flow for the PR and to land fixes on the PR's branch.
2. `ReviewPanel.tsx`: a text-labelled button "Fix findings" (aria-label "Fix findings of pull request #N") in the panel header facts row area, rendered only when `fixFindingsTarget` is non-null and an `onFixFindings` prop is given; it calls `onFixFindings(card, prompt)`.
3. `ReviewsView.tsx`: pass an `onFixFindings` prop through to the panel, with the snapshot's repo and repositoryId so App can build the PR subject.
4. `App.tsx`: generalise `createPrFlow(card, subject, prompt = flowPrompt(card.url))`; the Reviews tab handler builds `prSubject(card, repo, repositoryId)` and calls it with the findings prompt. Same session choice, same unsent prefill, same pending link and Link offer on the PR row.
5. Plan doc: stage-4 row and a short «Состояние» note record the action as done (Reviews panel variant), the PR-card CHANGES_REQUESTED variant as deferred.

Trade-off: a Review-panel action (brief) rather than a PR-card action keyed on GitHub review state (spec). The Review is where the findings live; the ownership rule ("own PR") from the spec is kept.

## State × event matrix

| state \ event | press Fix findings | Review list refresh | panel close / tab switch | PR head moves |
|---|---|---|---|---|
| eligible (own open PR, finished result, open findings) | bound session opens with prompt prefilled (not sent); pending link registered only if the prompt landed in the shown session | button stays while still eligible | nothing written | button stays: findings are of the reviewed range; the prompt names that range |
| running / queued / needs answer | button absent | appears once eligible | — | — |
| no open findings (0 blocker/major/minor, only info) | button absent | — | — | — |
| not the viewer's PR, PR closed/merged, Review closed/archived, no card | button absent | — | — | — |
| press while an open of the same PR is in flight | coalesced by `subjectOpener`; no second session, no second pending link | — | — | — |

## Verification tasks

Each AC below is checked by its exec command; Rust is untouched.
