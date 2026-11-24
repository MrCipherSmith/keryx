Partial review: pr-files waived by the operator: Delta round over 3ad918b66..0d6df2937; every changed file was assigned to reviewers through the slices

Reviewed SHA: 0d6df293794fe1b4582463544f9ad21f5ce202d2 — the PR has not moved on since (head of https://github.com/MrCipherSmith/keryx/pull/1301; delta round over 3ad918b66a990c7f0b04180e17d9fb74fb82713a..0d6df293794fe1b4582463544f9ad21f5ce202d2; merge-base a5d1ab236fe85dee62a758a19390049dde4eb7f9)

# Managed Review Report — round 5 (delta, fix round 4; round cap reached)

Evidence level: ran — tests-to-run at the head (core tree/explorer tests, Desktop tsc and the whole Desktop suite, exit 0, 1021 pass: research-evidence/verify-tests-to-run-1.txt); review-testing-practices re-ran the tree/view/platform suites (148 pass); the orchestrator ran the mutation pass (research-evidence/mutation-1.json: 4 mutants, 3 killed, 1 survived). Other findings are static reads; no verifier ran (no blocker or major).
Plan estimate vs actual: plan 16-40 min (29 dispatches); actual 8 min from first to last raw reply (32 replies); pauses over 10 min: 0

round cap: round 5 of 5

## Prior findings — dispositions

4 round-4 findings attached to the FIX slice (slice-01), judged by 9 reviewers against the code at 0d6df2937:

- r4-clean-code-w2-F-001: closed (9/9) — the component doc defers to handOff
- r4-frontend-w2-F-001: closed (9/9) — `reload` is required; every caller passes it
- r4-logic-w2-F-001: closed (9/9) — plan.md states the focus rule and has a stale-snapshot matrix row
- r4-degradation-w2-F-002 (info): open (9/9) — the 'every catalog load' wording; carried into r5-pr-contract-w1-PC-001

Round-4 findings judged outside the fix slice: r4-style-w2-F-001 closed (handOffTarget helper); r4-testing-practices-w1-F1/F2/F3 closed (new tests; round-4 mutants M3-M7, M12, M15 now killed per the implementer's red/green evidence, and M1/M2/M4 of this round killed); r3-pr-contract-w1-PC-001 closed (PR body edited after fix round 4; review-pr-contract-w1/w2 found the body's round claims hold); r4-style-w2-F-002 dismissed by the operator in round 4.

## Regressions the fixes introduced

- [r5-pr-contract-w1-PC-001] answering r4-logic-w2-F-001: the new plan.md stale-snapshot row repeats the 'every catalog load re-reads parked reads' wording (premise judge: the plan.md cell reads correctly under its 'new snapshot' column; the hook docs and PR body do not).

## Stage counts

- Reviewer dispatches: 31 of 31 returned (FIX slice-01, NEW slice-02/03, SECOND-LOOK slice-04..07).
- Raw findings: 11; after merging two duplicate clusters: 6 canonical from reviewers + 1 from the mutation pass = 7 (0 blocker, 0 major, 4 minor, 3 info). Pre-filter dropped: 0.
- Verifier (Wave C): not run (no blocker or major).
- Premise judge (Wave D) over 4: 4 upheld, 0 challenged, 0 downgraded.
- Mutation pass: 4 mutants on handOffTarget from review-testing-practices; killed M1, M2, M4; survived M3 (filed as r5-testing-practices-w1-M3).
- slice-03 is again a slicer artifact (metaproject.ts unchanged in this range); recorded as info r5-frontend-w2-F-001.

## Findings by severity

### Blocker (0)

### Major (0)

### Minor (4)

- [r5-clean-code-w2-F-001] (review-clean-code; premise: upheld) `apps/desktop/src/metaproject/MetaprojectView.dom.test.tsx` — DRY: the new test adds the third copy in this file of the same block that records scrollIntoView calls by patching HTMLElement.prototype and restores it in a finally (`const scrolled: HTMLElement[] = []; const original = HTMLElement.prototype.scrollIntoView; H
- [r5-pr-contract-w1-PC-001] (review-pr-contract; premise: upheld) `.metaproject/flows/518-2026-11-23-desktop-metaproject-sidebar-tree/plan.md` — Regression from the fix for r4-logic-w2-F-001. The plan.md amendment added the state-matrix row 'folder or page read answered stale-snapshot', and its new-snapshot cell says 'every catalog load re-reads parked reads, same snapshot id included'. The code does n
- [r5-pr-contract-w2-PC-001] (review-pr-contract; premise: upheld) `docs/docs/guides/desktop-metaproject.md` — Guide :107-110: 'shows **Loading…** until they arrive … If a folder fails to load, its row reads **Could not load.** with the reason and a **Retry** button.' slice-02 pins different behaviour for a stale-snapshot refusal. MetaprojectView.dom.test.tsx asserts `
- [r5-testing-practices-w1-M3] (review-testing-practices; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Gate unpinned (mutation pass, research-evidence/mutation-1.json): removing the guard `if (at < 0) return undefined;` from handOffTarget (MetaprojectTree.tsx) survives the tree, view and platform suites. With the guard gone, an anchor that is not shown (the roo

### Info (3)

- [r5-clean-code-w2-F-002] (review-clean-code; premise: not judged (info)) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — Comment accuracy: the new handOffTarget doc says that with no parent the target is 'the row after the anchor', and attaches the 'or the anchor itself' fallback only to the parent case. The code (`return next ?? rows[at];`) applies the anchor fallback to both c
- [r5-frontend-w1-F-001] (review-frontend; premise: not judged (info)) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Answering r4-frontend-w2-F-001, `reload` is now a required key, but its type is `unknown`, so `reload: undefined` or any constant still type-checks. That caller would have no exit from a parked stale read (the reload effect is the only re-read of a `stale` par
- [r5-frontend-w2-F-001] (review-frontend; premise: not judged (info)) `apps/desktop/src/platform/metaproject.ts` — slice-03 presents removed hunks in apps/desktop/src/platform/metaproject.ts (the capabilities `return 2` line and the expectedSnapshotId check in matchesRequest), but the file is unchanged in 3ad918b66..0d6df2937 (last touched by b5c8d5fe8); the lines were rem

## Verdict

Not clean: 4 upheld minor findings, no blocker or major. This is round 5 of 5 (the cap): no further managed review round follows. The remaining findings are documentation (two), test hygiene (one) and one unpinned test gate; none changes runtime behaviour.

## Not run

- Verifier: no blocker or major to verify.
- Rust `cargo test`: no local toolchain; Rust unchanged in this range (CI covers it).
- Live render / screen-reader pass of the Desktop tree (ui-ux): no running build supplied.

## Review parity

Nothing to carry into the report: no Not run candidates, held severity notes or open follow-ups.

## Token spend

token spend: 3646591 in, 0 out over 31 dispatch(es)
