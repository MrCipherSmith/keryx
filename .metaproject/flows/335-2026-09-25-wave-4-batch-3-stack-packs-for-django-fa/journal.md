# Flow Journal

- 2026-09-25T15:14:43.714Z - flow created
- 2026-09-25T15:18:38.321Z - frozen: 5 criteria; checksum recorded
- 2026-09-25T15:18:40.804Z - started
- 2026-09-25T15:18:45.690Z - task-attempt: T1: started (attempt 1)
- 2026-09-25T15:18:45.947Z - task-done: T1: Collect remaining context
- 2026-09-25T15:19:25.226Z - task-attempt: T2: started (attempt 1)
- 2026-09-25T15:40:33.225Z - task-done: T2: Implement per plan
- 2026-09-25T15:40:37.160Z - task-attempt: T3: started (attempt 1)
- 2026-09-25T15:40:37.418Z - task-done: T3: Add/adjust tests and make them pass

## Phase A summary (runner note)

Authored django, fastapi, rust, java-kotlin-spring stack packs via 4
parallel sonnet workers (one disjoint pack directory each), then runner
wiring: `install-manifest.json` (modules/components/profiles),
`authoring-lint.ts` `STACK_EXTENSIONS` (django, fastapi,
java-kotlin-spring added; rust was already present). Scout-recorded every
skill for real via `keryx skills scout --record` (offline, deterministic):
two false-"use" collisions found and fixed by rewording descriptions
(django-testing vs fastapi-testing; java-kotlin-spring-implementation vs
its own code-review sibling) -- both now score fork/create. Added
django-vs-fastapi near-miss negatives to both packs' evals.json per the
coordinator's request. Ran the real offline suites: `stack-packs.test.ts`
(122/124 pass; the 2 pre-existing failures are go/python's stable-pack
gate, unrelated to this batch and not touched here), `bundled-eval.test.ts`
+ `agent-catalogue-xref.test.ts` + `enforcement-claims.test.ts` (73/73),
all of `src/gdskills/governance/*.test.ts` (236/236), `tsc --noEmit`
(clean), `eslint .` (clean). The real I11 (negation-aware trigger scorer)
does not exist on this branch yet -- it ships with flow 334, not merged --
so a manual token-overlap proxy was run instead and documented as
best-effort only; the authoritative I11 check reruns during the Phase B
rebase onto main once #719 and flow 334 land. Committed per pack (4
commits) plus one shared-wiring commit. Stayed at Phase A per instructions:
no calibration/gate run, no PR opened. Returning `STATUS: READY_FOR_GATE`.

## Phase B: rebase, stable-pack protection, I11, honest gate

Rebased flow/335-w4b3 onto origin/main (#719 batch-2 + flow 334's
negation-aware scorer/I11 merged). Two-file conflict in
`install-manifest.json`/`authoring-lint.ts` resolved by keeping both
sides (batch-2's nestjs/vue/angular/nextjs-nuxt/mobx entries plus
batch-3's django/fastapi/rust/java-kotlin-spring entries).

**Stable-pack protection.** Adding the four new packs knocked go and
python's `checkStablePackGate` over the fork threshold on several of
their own trigger-positive prompts (corpus-wide IDF redistribution).
Diagnosed and fixed entirely inside the four new packs' own SKILL.md
description/triggers (never touched go, python, or any pre-existing
skill) -- removed literal shared tokens (`parser`, `fuzz`, `pull
request`, `mypy`/`ruff` duplicated in both description and trigger,
"I don't understand", `asyncio.TaskGroup` named in an exclusion clause,
repeated `endpoint`/`client`/`cover`). Verified: `checkStablePackGate`
passes for both go and python; the stricter
`checkSkillSelectedLeaveOneOut` ratchet (a separate, broader budget
covering the whole catalog) also re-measured and updated in
`scout.test.ts` (155->169 of 775 triggers, six new honest losses
documented with reasoning, one #719-era honest loss removed because it
no longer reproduces).

**I11 enforcement.** Added django/fastapi/rust/java-kotlin-spring to
`I11_ENFORCED_PACKS`. 63 of the four packs' eval `triggers.positive`
prompts were near-copies (Jaccard >=0.5) of their own SKILL.md frontmatter
triggers -- inherited from authoring both lists off the same template.
Dispatched one sonnet worker per pack to rewrite ONLY `triggers.positive`
(never `triggers.negative`, `scenarios`, or `calibration`) as genuinely
independent, realistic phrasings -- different concrete details, often a
question or context-carrying sentence instead of an imperative, never a
synonym swap. All 63 rewrites verified: I11 246/246 pass, full I1-I9+AG
suite 3625/3625 pass.

**AG calibration.** `keryx skills judge-check --judge deepseek:deepseek-
chat --samples 3 --record` for all 18 skills. All green (recorded in
`src/gdskills/governance/judge-recordings/`), no calibration answers
edited.

**Honest 10-trial DeepSeek gate (official, run 1, verbatim below).** One
CLI call per skill: `skills eval <pack>/<skill> --scope bundled --runner
deepseek:deepseek-chat --judge deepseek:deepseek-chat --strictness high
--trials 10 --json`, HEAD unchanged start to end. Raw outputs assembled
verbatim (no edits) into each pack's `governance/eval.json`
(`{schemaVersion, reports: [...]}`); `regradeRecordedReport` confirms
every report is internally consistent with its own recorded trial data.

Per-skill trigger accuracy (truePositive/positives, falsePositive/negatives)
and any behavior scenario below the 0.8 pack floor:

- django/django-build-fix: trigAcc 5/7, FP 1/7, behaviors: none below floor.
- django/django-code-review: trigAcc 5/6, FP 1/7, behaviors: none below floor.
- django/django-implementation: trigAcc 6/7, FP 0/7, behaviors: none below floor.
- django/django-migrate: trigAcc 4/7, FP 2/7, behaviors: none below floor.
- django/django-testing: trigAcc 5/7, FP 0/6, behaviors: permission-view-both-paths=0.5 (BELOW FLOOR).
- fastapi/fastapi-build-fix: trigAcc 2/7, FP 1/7, behaviors: none below floor.
- fastapi/fastapi-code-review: trigAcc 4/6, FP 0/6, behaviors: none below floor.
- fastapi/fastapi-implementation: trigAcc 1/7, FP 2/6, behaviors: none below floor.
- fastapi/fastapi-testing: trigAcc 4/6, FP 3/7, behaviors: none below floor.
- rust/rust-build-fix: trigAcc 4/6, FP 0/6, behaviors: no-clippy-allow-suppression=0.7 (BELOW FLOOR).
- rust/rust-code-review: trigAcc 4/6, FP 1/6, behaviors: none below floor.
- rust/rust-implementation: trigAcc 4/7, FP 2/7, behaviors: none below floor.
- rust/rust-testing: trigAcc 3/7, FP 1/7, behaviors: none below floor.
- java-kotlin-spring-build-fix: trigAcc 2/6, FP 1/6, behaviors: none below floor.
- java-kotlin-spring-code-review: trigAcc 0/6, FP 2/6, behaviors: none below floor.
- java-kotlin-spring-implementation: trigAcc 5/7, FP 1/6, behaviors: none below floor.
- java-kotlin-spring-migrate: trigAcc 3/7, FP 3/6, behaviors: none below floor.
- java-kotlin-spring-testing: trigAcc 0/7, FP 1/6, behaviors: none below floor.

**Diagnosis, recorded rather than tuned -- no re-run followed.** Trigger
accuracy is weak across nearly every skill, several catastrophically
(java-kotlin-spring-code-review and -testing: 0 true positives). Working
hypothesis, unproven: the I11 rewrite pass (above) optimized eval
positives AWAY from their own frontmatter triggers' vocabulary to clear
the 0.5 Jaccard ceiling, which directly works against the
`trigger-rank-fork-family` router needing enough shared vocabulary to
outrank sibling packs -- the same tension noted for ts-js-node's
`no-ts-ignore-suppression` in flow 317 (more trials revealing a real
rate, not a fixture defect), but here plausibly compounded by I11's own
fix pulling scores down further. Not proven; no content was touched to
test this hypothesis, per the standing rule: run 1 is official, and no
description/trigger edit follows a gate result to chase a specific
failing prompt.

**Stability and agents, derived from the gate only.** No skill in any of
the four packs clears both a materially-accurate trigger split and every
behavior scenario at/above the floor; two skills (django-testing,
rust-build-fix) have a behavior scenario below the 0.8 floor outright,
and several skills' trigger accuracy is at or near zero. All four packs
stay `stability: experimental` (unchanged from Phase A) and
`agent-refs.json` stays `{"agents": []}` for every pack (unchanged) --
`checkStablePackGate` confirmed `not-applicable` for all four, consistent
with staying experimental. No generated agent pairs. This is a genuine,
accepted outcome per the standing rule, not a defect left unresolved.

**Post-gate description/trigger audit.** No SKILL.md description or
trigger was edited after this gate run. The only file changes after the
honest gate run are the four `governance/eval.json` files themselves
(verbatim raw-output assembly) and this journal entry.
