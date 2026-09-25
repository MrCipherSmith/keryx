# Flow Journal

- 2026-09-25T06:09:18.148Z - flow created
- 2026-09-25T06:13:54.315Z - task-added: T5: Extend STACK_EXTENSIONS for nestjs/vue/angular/nextjs-nuxt/mobx
- 2026-09-25T06:13:54.463Z - task-added: T6: Author nestjs pack (extends ts-js-node)
- 2026-09-25T06:13:54.599Z - task-added: T7: Author nextjs-nuxt pack (extends react+vue)
- 2026-09-25T06:13:54.731Z - task-added: T8: Author vue pack (extends ts-js-node)
- 2026-09-25T06:13:54.864Z - task-added: T9: Author angular pack (extends ts-js-node)
- 2026-09-25T06:13:54.996Z - task-added: T10: Author mobx pack (extends react)
- 2026-09-25T06:14:00.582Z - task-added: T11: Extend install-manifest.json for all 5 packs (modules/components/profiles)
- 2026-09-25T06:14:00.714Z - task-added: T12: Judge calibration: judge-check --record for every new skill until AG green
- 2026-09-25T06:14:00.842Z - task-added: T13: Honest gate run (deepseek runner+judge, trials=10) for every new skill
- 2026-09-25T06:14:00.973Z - task-added: T14: Stability promotion + agents generate for packs that clear the gate
- 2026-09-25T06:14:01.102Z - task-added: T15: Update W1/W2 docs with batch-2 implementation notes
- 2026-09-25T06:14:01.235Z - task-added: T16: Adversarial review loop, PR, CI, merge
- 2026-09-25T06:14:06.253Z - task-done: T1: Collect remaining context
- 2026-09-25T06:14:06.388Z - task-done: T2: Implement per plan
- 2026-09-25T06:14:06.527Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T06:14:06.663Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T06:14:10.436Z - frozen: 8 criteria; checksum recorded
- 2026-09-25T06:14:10.570Z - started
- 2026-09-25T06:14:26.984Z - task-done: T5: Extend STACK_EXTENSIONS for nestjs/vue/angular/nextjs-nuxt/mobx
- 2026-09-25T06:16:07.865Z - task-attempt: T6: started (attempt 1) — dispatched parallel sonnet pack-authoring worker
- 2026-09-25T06:16:08.001Z - task-attempt: T7: started (attempt 1) — dispatched parallel sonnet pack-authoring worker
- 2026-09-25T06:16:08.130Z - task-attempt: T8: started (attempt 1) — dispatched parallel sonnet pack-authoring worker
- 2026-09-25T06:16:08.259Z - task-attempt: T9: started (attempt 1) — dispatched parallel sonnet pack-authoring worker
- 2026-09-25T06:16:08.394Z - task-attempt: T10: started (attempt 1) — dispatched parallel sonnet pack-authoring worker
- worker-review: mobx (T10) reported DONE. Reviewed its evals.json before accepting: 5-6 of 8
  mobx-store-implementation positive trigger prompts leaned on exact API tokens (@action.bound,
  runInAction, observer, autorun) after "2-3 rounds of prompt tuning" — a sign of tuning toward the
  scorer rather than staying realistic. Sent the worker a follow-up (not yet accepted) to de-jargon
  at least half the positives, fix any resulting collision via SKILL.md description/triggers (never
  by re-adding jargon to prompts), and re-verify trigger accuracy. mobx-observable-testing's
  positives already read naturally — no change requested there.
- worker-review: vue (T8) reported DONE. Reviewed its 5 skills' evals.json trigger prompts —
  natural, casual, symptom/tool-based phrasing (not keyword-stuffed); vue-build-fix's positives are
  appropriately error-message-shaped since that IS how build-fix requests arrive. Also reviewed the
  vue-build-fix `template-union-type-narrowing` scenario, whose rubric/fail_criteria the worker
  tightened after finding its original `subtle_wrong` calibration (a `typeof` ternary) was actually
  type-safe: the tightened fail_criteria targets a real behavioral gap (the ternary leaves the
  string branch unformatted, defeating the `.toFixed(2)` currency-formatting intent the prompt's
  own code implies) — not over-demanding relative to the prompt. Accepted as-is, no further worker
  action needed for vue.
- worker-review: mobx (T10) revision accepted. 4/8 mobx-store-implementation positives and 3/7
  mobx-observable-testing positives rewritten to drop literal MobX API tokens and describe the
  symptom/goal instead; two resulting collisions fixed via SKILL.md `description`/`triggers`
  widening (not by re-adding jargon to prompts). Re-verified TP/FP clean (8/8, 7/7, FP=0 both),
  lint clean, scout re-recorded for mobx-store-implementation. mobx pack accepted.
- 2026-09-25T06:28:55.344Z - task-done: T8: Author vue pack (extends ts-js-node)
- 2026-09-25T06:29:07.610Z - task-done: T10: Author mobx pack (extends react)
- worker-review: nestjs (T6) reported DONE. Same eval-softening pattern as mobx found in
  nestjs-testing/evals.json (3/6 positives leaning on literal API tokens Test.createTestingModule/
  overrideProvider after the worker "sharpened" prompts to fix scoring). Sent a follow-up (not yet
  accepted) to de-jargon nestjs-testing's positives and spot-check nestjs-implementation/
  nestjs-build-fix for the same pattern. nestjs-implementation and nestjs-build-fix read naturally
  already on first read.
- **Follow-up for a future flow (not fixed in this flow):** the trigger/scout matcher
  (`skills eval`'s trigger-accuracy scorer and `skills scout`'s overlap scorer) is a bag-of-words
  match with no negation awareness — a skill's own "Not for X" exclusion clause in its description
  counts as positive lexical evidence for X rather than negative evidence. This has repeatedly
  forced pack workers (batch 1 and this batch) to avoid naming adjacent-skill vocabulary in
  descriptions instead of writing an honest exclusion clause, and forced some trigger prompts
  toward exact-API-token phrasing to clear the score, which review then had to walk back toward
  more natural phrasing. Recommended fix for that follow-up flow: make the scorer negation-aware
  (e.g. strip/down-weight text inside "Not for …"/"NOT when …" clauses before matching) and add a
  regression test pinning the behavior. Left unfixed here per this flow's scope (governance/gate
  machinery is out of scope, see description.md).
- worker-review: nestjs (T6) revision accepted. 3/6 nestjs-testing positives de-jargoned;
  nestjs-implementation needed no changes (already goal/symptom-based); nestjs-build-fix's
  error-message-shaped positives judged legitimate (realistic pasted exception text, same pattern
  as the existing nodejs-build-fix precedent), left as-is. One resulting collision fixed via
  nestjs-testing's SKILL.md description/exclusion-clause rewording, not by re-jargoning prompts.
  Re-verified TP/FP clean on all three skills (7/7, 6/6, 6/6, FP=0), scout re-recorded for
  nestjs-testing (decision: create), lint clean. nestjs pack accepted.
- 2026-09-25T06:34:07.420Z - task-done: T6: Author nestjs pack (extends ts-js-node)
- worker-review: nextjs-nuxt (T7) reported DONE. Found a different softening pattern than the
  positives-jargon issue: EVERY negative across all 5 skills' evals.json was a far-away cross-stack
  prompt (Go/Python/NestJS/generic-Node/Angular) — zero same-pack or sibling-pack (react/vue)
  near-misses. Sent a follow-up (not yet accepted) requiring at least half of each skill's
  negatives to be realistic near-misses, with an honest-collision-is-acceptable instruction (report
  a genuine trigger-accuracy miss rather than swapping back to an easy negative). Also noted for
  this pack: `pack.json` correctly uses `"extends": ["react", "vue"]` per the flow's design
  decision; scout returned "use" for implementation vs. testing (0.594/0.621, mutual match within
  the same pack) — accepted as a recorded, reasoned decision to keep both skills (same lexical-
  scorer limitation as the negation-awareness follow-up above, not a real duplicate). The worker
  correctly did not create `governance/scout.json` per the brief; the orchestrator will generate it
  via the real CLI once the pack is finalized.
- worker-review: nextjs-nuxt (T7) revision accepted as DONE_WITH_CONCERNS. Negatives are now
  majority near-miss; the resulting FPs (implementation 3/6, testing 4/6, code-review 3/6,
  build-fix 1/6, migration 3/6 — all TP still clean) are a real, traced structural finding, not
  unresolved sloppiness: (a) `checkSkillSelected`'s same-pack-siblings-never-block rule means a
  5-skill meta-framework pack whose skills necessarily share heavy vocabulary (Next.js/Nuxt/App
  Router/Server Component/composable) cannot be cleanly separated by same-pack near-misses without
  stripping each skill's own needed trigger nouns; (b) the cross-pack (react/vue) collisions trace
  to this pack's own "Not for plain React/Vue..." disclaimer clauses being indexed as positive
  vocabulary for the very query they're meant to exclude — the SAME negation-unaware-scorer defect
  already logged above, now with a second concrete reproduction. Both are accepted as honest
  self-check results, not fixed by further prompt/description tuning (per this flow's "report
  honestly, the gate may keep it experimental" instruction). Not blocking: the stable-pack gate
  (`checkStablePackGate`) is scored on judge behavior-scenario pass rate, not this deterministic
  trigger-accuracy self-check, so this finding informs review/docs, not pack.json's stability
  field directly. nextjs-nuxt pack accepted; orchestrator will still generate governance/scout.json
  via the real CLI before committing.
- 2026-09-25T06:44:57.071Z - task-done: T7: Author nextjs-nuxt pack (extends react+vue)
- **Owner decision (chat, standing for this flow going forward), overriding the runner-brief PR
  target and reviewer model:** `feat/agent-platform-expansion` is FROZEN — PR #700 (the program's
  final PR) is in review there. This flow does NOT open or merge a PR against `feat` while that is
  true. Plan: finish all authoring/gate/docs work on `flow/318-w4b2` as before; once ready, if #700
  has already merged into `main`, rebase `flow/318-w4b2` onto `origin/main` and open the PR against
  `main`; if #700 has not yet merged, stop at READY_FOR_PR and hold the branch rather than opening
  anything. Reviewer model is now "opus" (the rate limit that forced "sonnet" for reviewers has
  reset) — the adversarial review of all 5 batch-2 packs, including an explicit checklist item for
  realistic positives / near-miss negatives (per this flow's own worker-review findings above), runs
  on opus. Authoring/fix workers stay on sonnet. Gate discipline (10 trials, no content edits during
  the run, agent pairs only for packs that clear the gate) and the git-hygiene rules (no stash, no
  `add -A`, no trailers) are unchanged.
