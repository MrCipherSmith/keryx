Partial review: pr-files waived by the operator: Delta round over b2043b98d..3ad918b66; every changed file was assigned to reviewers through the slices

Reviewed SHA: 3ad918b66a990c7f0b04180e17d9fb74fb82713a — the PR has not moved on since (head of https://github.com/MrCipherSmith/keryx/pull/1301; delta round over b2043b98dba98f8b86bbd444e1e2ac99a88a4e1a..3ad918b66a990c7f0b04180e17d9fb74fb82713a; merge-base a5d1ab236fe85dee62a758a19390049dde4eb7f9)

# Managed Review Report — round 4 (delta, fix round 3)

Evidence level: ran — tests-to-run at the head (Desktop tsc and the whole Desktop suite, exit 0: research-evidence/verify-tests-to-run-1.txt); review-testing-practices re-ran the Desktop tree/view/platform suites (146 pass); the orchestrator ran the mutation pass (research-evidence/mutation-1.json: 15 mutants, 7 killed, 8 survived). Other findings are static reads; no verifier ran (no blocker or major).
Plan estimate vs actual: plan 16-40 min (29 dispatches); actual 14 min from first to last raw reply (30 replies); pauses over 10 min: 0

round cap: round 4 of 5

## Prior findings — dispositions

10 round-3 findings attached to the FIX slice (slice-01), judged by 9 reviewers against the code at 3ad918b66:

- r3-regression-w1-F-001 (major): closed (9/9) — a stale-snapshot read is parked and re-read on every catalog load; tests cover folder and page recovery
- r3-architecture-w1-F-001: closed (8/9; 1 partial for the missing Rust-side note)
- r3-clean-code-w1-F-002: closed (9/9)
- r3-clean-code-w2-F-001: closed (9/9)
- r3-clean-code-w1-F-003, r3-clean-code-w2-F-002, r3-highload-w2-F-001 (info): partial (9/9) — one TS literal now, but metaproject.rs:199 still has no pointer to its Desktop consumer and no exact-text test (no Rust toolchain locally)
- r3-style-w1-F-002, r3-style-w2-F-001 (info): open — PERMIT_RETRIES is still exported with no importer
- r3-pr-contract-w1-PC-001 (minor): open — the PR body still says a stale read "shows only the banner"; the body was not edited (the active gh account cannot edit this PR)

Round-3 findings judged outside the fix slice: r3-logic-w5-F-002 closed (handOff anchors status rows to their own parent; new DOM test; mutants M13/M14 killed); r3-testing-practices-w2-F1 closed (two retry-guard tests; mutants M10/M11 killed).

## Regressions the fixes introduced

None at blocker or major. The new minors are documentation and test gaps around the round-3 fixes (component doc, plan, the optional `reload` input, untested `stale` branches).

## Stage counts

- Reviewer dispatches: 29 of 29 returned (FIX slice-01, NEW slice-02/03, SECOND-LOOK slice-04/05/06).
- Raw findings: 21; after merging four duplicate clusters: 15 canonical (0 blocker, 0 major, 8 minor, 7 info). Pre-filter dropped: 0.
- Verifier (Wave C): not run (no blocker or major).
- Premise judge (Wave D) over 8: 7 upheld, 1 challenged and held for the operator (r4-style-w2-F-002), 0 downgraded.
- Mutation pass: 15 mutants from review-testing-practices; killed M1, M2, M8, M10, M11, M13, M14; survived M3-M7 (confirm r4-testing-practices-w1-F1/F2/F3), M9 (equivalent), M12 (the MetaprojectRequestError exclusion in isMetaprojectPermitRefusal is unpinned), M15 (the `?? rows[at]` focus fallback is unpinned). M12/M15 fold into the testing findings' fix scope.
- slice-03 is a slicer artifact (two removals rendered that are not in the range); reported by 9 reviewers as r4-frontend-w2-F-003 (info).

## Findings by severity

### Blocker (0)

### Major (0)

### Minor (8)

- [r4-clean-code-w2-F-001] (review-clean-code; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Documentation drift in a symbol this delta changed. The fix for r3-logic-w5-F-002 replaced the hand-off rule. A status row now anchors to its own parent: a Loading row anchors to `d:<parent>`, and a Show more row to the parent's last entry,
- [r4-frontend-w2-F-001] (review-frontend; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — A stale-snapshot read is parked as status 'stale' (or more: {status: 'stale'}) and only a change of `reload` re-reads it (the useEffect comparing loadedCatalog.current to reload is the sole caller of reread(scope, parent, 'stale')). `reload
- [r4-logic-w2-F-001] (review-logic; premise: upheld) `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/plan.md` — plan.md (Desktop UI, WAI-ARIA bullet) still says focus is never moved by data arriving. Its state x event matrix has no row for a read answered stale-snapshot. Both behaviours have changed under recorded operator decisions. (1) Fix round 1,
- [r4-style-w2-F-001] (review-style; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Ternary chain (a ternary inside a ternary) added by this delta. The layout effect that restores focus now picks the focus target with `const target = at < 0 ? undefined : (lost.parent === undefined ? after[0] : after.find(...)) ?? rows[at];
- [r4-style-w2-F-002] (review-style; premise: challenged) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — One concept has two names in the code this delta added. The hook's new input is called `reload` and typed `unknown`. Its doc says it 'Changes whenever the explorer loads its catalog'. The ref that remembers it in the same hook is `loadedCat
- [r4-testing-practices-w1-F1] (review-testing-practices; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — tdd-workflow.mdc Rule 3 (new branch with no test). This round adds the `stale` state and three branches that decide what a parked read looks like and whether it can be asked for again. (a) flatten renders a stale folder as a Loading row (`|
- [r4-testing-practices-w1-F2] (review-testing-practices; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — tdd-workflow.mdc Rule 3 (new branch with no test). In the reveal effect, a step folder parked as `stale` makes the reveal wait instead of giving up. Without `|| folder.status === "stale"`, the stale folder has empty entries and no nextCurso
- [r4-testing-practices-w1-F3] (review-testing-practices; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Mandatory under the lens's mutation rule: this gate was added in answer to the earlier round's major (r3-regression-w1-F-001). The reload effect re-reads parked reads in both scopes, but both recovery tests park a read in the graph scope on

### Info (7)

- [r4-clean-code-w1-F-001] (review-clean-code; premise: not judged (info)) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — This is new code from the fix for r3-clean-code-w1-F-002. withPermitRetry takes `retries` as a parameter (default PERMIT_RETRIES), but it finds the attempt number from the module constant: `PERMIT_RETRIES - retries + 1`. The function theref
- [r4-clean-code-w2-F-002] (review-clean-code; premise: not judged (info)) `apps/desktop/src/platform/metaproject.ts` — The prefix the classifier matches on is a second hand-written literal. It restates the start of the exported METAPROJECT_PERMIT_REFUSAL on the line above it. Nothing ties the two together, so a change to one wording can leave the other behi
- [r4-degradation-w2-F-002] (review-degradation; premise: not judged (info)) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The `reload` doc, the MetaprojectView comment ('Every catalog load (a new catalog object) re-reads…') and the PR body ('every catalog load re-reads it') all say that any catalog load re-reads parked stale reads. The quiet re-read that runs 
- [r4-frontend-w2-F-002] (review-frontend; premise: not judged (info)) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The delta writes `shown.current = rows` in the render body; remember() (blur microtask, layout effect) computes handOff from it. Under concurrent rendering a discarded render would leave uncommitted rows in the ref. Same pattern as the hook
- [r4-frontend-w2-F-003] (review-frontend; premise: not judged (info)) `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1301-r03/slices/slice-03.diff` — slice-03 shows two removals in apps/desktop/src/platform/metaproject.ts (the capabilities `return 2` line and the expectedSnapshotId check in matchesRequest) that `git diff b2043b98d 3ad918b66 -- apps/desktop/src/platform/metaproject.ts` do
- [r4-logic-w2-F-002] (review-logic; premise: not judged (info)) `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/journal.md` — The T14 journal entry summarises the hand-off as 'status rows anchor focus hand-off to their own parent (Loading row -> parent row, Show more -> parent last entry)'. Read alone, 'Loading row -> parent row' says focus lands on the parent fol
- [r4-logic-w4-F-001] (review-logic; premise: not judged (info)) `src/integrations/metaproject-explorer-v2.ts` — graphTree answers an empty, partial root whenever model.graphPresent is false. loadExplorerGraph also sets graphPresent = false when nodes.jsonl/edges.jsonl exist but cannot be read or hold invalid records (it sets graphError = 'Graph stora

## Verdict

Not clean: 7 upheld minor findings and the open round-3 minor r3-pr-contract-w1-PC-001 remain; r4-style-w2-F-002 is held for the operator. A fix round (round 4 fixes, then review round 5, the cap) is needed.

## Not run

- Verifier: no blocker or major to verify.
- Rust `cargo test`: no local toolchain; Rust is unchanged in this range.
- Live render / screen reader pass of the Desktop tree (ui-ux): no running build supplied.

## Review parity

Nothing to carry into the report: no Not run candidates, held severity notes or open follow-ups.

## Token spend

token spend: 4082203 in, 0 out over 29 dispatch(es)
