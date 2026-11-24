# Implementation Plan

Status: active

## Approach

Independent parts first, dependent parts after rebasing onto stage 3 (operator decision, same as for stage 3).

1. **Head moved procedure (independent).** `review-orchestrator/SKILL.md` sits at its line ceiling (918, `src/gdskills/skill-length-ceilings.ts`, asserted by `src/gdskills/review-orchestrator-preflight.test.ts`), so the procedure goes into `SKILL.detail.md` as a section "Head moved", and SKILL.md changes in place, without new lines: Round plan step 5 adds the head check before `keryx review next`, and the two lines "Re-read head and thread before posting…" become a pointer to the procedure. Both copies change identically: `src/gdskills/bundled/skills/review/review-orchestrator/` and `.metaproject/skills/gdskills/review/review-orchestrator/`. Written against the spec contract (`specification.md`, "Поведение при смене head"); `keryx review advance` does not exist yet, so the procedure names it and says what to run while `keryx review --help` does not list it (a new `keryx review plan` on the new head, which already detects a delta round).
2. **Divergence map (independent).** Read the two publish paths (`src/review/publish.ts`, `src/commands/review.ts` `runPublish`, `src/review/desk-publication.ts`, `src/commands/review-desk-publish.ts`, `apps/desktop/src-tauri/src/review.rs`, `apps/desktop/src/review/ReviewPublishDialog.tsx`, `src/review/publish-guard.ts`) and record in `divergence-map.md` where they diverge, with file:line, plus the extraction plan.
3. **Shared publish code and session update command (blocked on stages 2 and 3).** After stage 3 is pushed: rebase onto it, extract per the map, make `keryx review publish` use the shared acceptance/receipt/duplicate marker, and make the session procedure and the Desktop prompt (`src/review/autonomous-profile.ts:199`, "New commits belong to a separate request") use `keryx review advance`. Not built against the old run model; no own rounds schema; no publish-dialog work (stage 3 owns it).

State × event matrix: not applicable — this flow changes skill text and, later, CLI publish code; no UI or stored UI state is in its scope (the publish dialog belongs to stage 3).

## Steps

1. T5 (implement): Head moved procedure, both copies, plus preflight test assertions.
2. T6 (context): divergence map.
3. Review round on the branch (`review-orchestrator`).
4. `git fetch origin`; stages 2/3 status decides T7/T8 or the blocked record.
5. Draft PR against `main` naming the dependency and expected overlap.

## Risks

- Stage 3 may name the update command or the publish variants differently from the spec; the procedure then needs a follow-up edit when T8 runs.
- Stage 3 may also edit `review-orchestrator` or `desk-publication.ts`; expected overlap is recorded in the PR body.
