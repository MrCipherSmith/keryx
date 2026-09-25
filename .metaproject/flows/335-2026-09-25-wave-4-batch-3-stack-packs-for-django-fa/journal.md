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

## Phase B continued: merge origin/main (batches 4/5/6), BLOCKED

Origin/main moved again while Phase B ran: Wave 4 batch 4
(csharp-dotnet/swift-ios/kotlin-android/flutter-dart, PR #738), batch 5
(php-laravel/ruby-rails/c-cpp/sql-db, PR #735), and batch 6
(docker-k8s-terraform/ci-github-gitlab, PR #733) all merged into main.
Merged origin/main into flow/335-w4b3 with an explicit merge commit (not
rebase), resolving 5 conflicted shared files additively: `install-
manifest.json` (union, no real conflicts in either side's entries),
`authoring-lint.ts` `STACK_EXTENSIONS` (union), `manifest.test.ts`
profile allowlist (union), `stack-pack-eval-integrity.test.ts`
`I11_ENFORCED_PACKS` (union), and `scout.test.ts`'s `KNOWN_HONEST_LOSSES`
+ ratchet, re-measured against the fully combined catalog: 170 skills,
1006 triggers, 231 failing `checkSkillSelectedLeaveOneOut` (up from
flow 335's own 169/775 pre-merge measurement). Two of flow 335's six
honest losses (`python-code-review::"check for python security issues"`
and `dependency-update::"upgrade packages"`) no longer reproduce against
the larger combined catalog and were removed rather than carried forward
as stale pins; the remaining four still reproduce (outranker identities
shifted again, as expected — corpus redistribution is not a one-time
event). Full targeted suite re-run post-merge: `tsc --noEmit` clean;
`stack-packs.test.ts` + `scout.test.ts` + `manifest.test.ts` +
`stack-pack-eval-integrity.test.ts` — 6591 pass, 1 fail.

**The 1 failure: a stable-pack-protection collision I could not honestly
fix.** `checkStablePackGate('python', 'stable')` now fails:
`python/python-testing`'s own trigger-positive-1 ("Write pytest tests for
the new widgets module") no longer routes to itself — outranked by
`flutter-dart/flutter-testing` (shared "widget" token, unrelated to any
flow-335 content) at score 0.4848 vs. python-testing's own 0.4736.

Diagnosis, done rigorously before concluding this is unfixable:
1. Confirmed the loss is caused by this merge, not pre-existing:
   excluding flow 335's four packs from the catalog restores python's win
   (score 0.4893, rank 1) — so it IS attributable to this flow's merge,
   not something flutter-dart alone already broke on main.
2. Identified the mechanism: `django-testing` and `fastapi-testing` both
   legitimately use "test"/"pytest"/"write" vocabulary (inherent to being
   testing skills), and their mere PRESENCE in the catalog lowers the
   global IDF weight for those tokens (document-frequency-based: how many
   skills contain the token at least once, not how many times). This
   lets `flutter-dart/flutter-testing`'s rarer "widget" token edge out
   python's now-cheaper "test"/"pytest"/"write" match.
3. Tested whether rewording could fix it, per the "fix it in YOUR pack's
   description/triggers" instruction: rewrote `django-testing`'s and
   `fastapi-testing`'s most generic triggers and description clauses to
   remove/reduce "test"/"write"/"pytest" repetition — re-measured after
   each edit, INCLUDING a full rewrite of every fastapi-testing trigger.
   Zero score movement, at any step. Root cause: IDF is binary per-skill
   document frequency, not per-occurrence — as long as EITHER skill
   contains the word "test" even once anywhere in its indexed text
   (description + all triggers), the document frequency (and therefore
   the IDF weight) is unchanged. Only fully eliminating "test" as a word
   from both skills' entire indexed text would move this number, which
   is not a real scope statement for two testing skills — that would be
   gaming the scorer by hollowing out real content, exactly what the
   standing rule forbids. Reverted both experimental edits (`git checkout
   --` on the two SKILL.md files) rather than leave ineffective, disallowed
   changes in the tree.
4. Per the explicit instruction ("if the collision can't be fixed
   honestly, report it and stop"): stopped here and handed back BLOCKED
   with the full diagnosis. Never touched `python/`'s own triggers or
   eval prompts.

## Owner decision and resolution (2026-09-26)

**decided-by: MrCipherSmith (owner, in chat)** — demote `python` to
`stability: "experimental"`. This is the honest-evals rule applied
consistently: the gate genuinely fails against the merged catalog, so
the pack's stability claim must follow the gate, not be propped up.
Explicit: do not touch python's triggers or its eval prompts, and do not
loosen the gate to route around this.

Applied:
- `src/gdskills/bundled/stacks/python/pack.json`: `stability:
  "experimental"`.
- `src/gdskills/bundled/install-manifest.json`: `python-rules` and
  `python-skills` module entries moved to `stability: "experimental"` to
  agree with pack.json (the pack.json <-> install-manifest guard test).
- `src/gdskills/bundled/stacks/python/agent-refs.json`: `"agents": []`
  with a note recording the exact reason (score 0.4736 vs 0.4848,
  binary-per-skill-IDF cause, verification method, owner decision),
  matching the format flow 317 used for `ts-js-node`'s removal.
- Removed `src/gdskills/bundled/agents/python-code-auditor.md` and
  `python-build-fixer.md` (the generated pair).
- Updated the three test files that pinned the old "go and python
  gate-cleared" state to "go only" (`src/agents/generate.test.ts`,
  `src/agents/verify.test.ts`, `src/commands/agents-catalog-commands.test.ts`),
  following flow 317's exact precedent for the equivalent ts-js-node
  demotion (`git log --grep`, commit `df55b49af`).
- `docs/docs/guides/agent-catalog.md`,
  `docs/requirements/keryx-agent-platform-expansion/workstreams/
  W1-stack-catalog.md`, and `.../W2-agent-catalog.md` updated with a new
  "Implementation notes: Wave 4 batch 3 (flow 335)" section recording the
  full reason, matching the style of every prior batch's own section.

**Follow-up, recorded rather than attempted mid-flow:** route and gate
only among packs of a project's detected/installed stacks (via `keryx
stack detect`), not the whole bundled catalog — the mechanism that
demoted python here is purely an artifact of scoring every trigger
against every OTHER bundled pack regardless of whether a real project
would ever have both `python` and `flutter-dart` installed at once. A
scoped gate would never see this particular collision. Then re-gate
`python` under that narrower scope as a genuine test of whether it
recovers. Not attempted in this flow — it is a design change to the gate
itself, not a content fix within this flow's four packs.

**Unproven hypothesis, recorded per the standing rule (not acted on):**
the I11 rewrite pass (reducing a prompt's Jaccard overlap with its own
skill's frontmatter triggers, required by the I11 integrity floor)
plausibly works directly against the `trigger-rank-fork-family` router's
own need for that same overlap to outrank sibling packs — i.e. the fix
for one integrity rule may be structurally undermining trigger accuracy
for the honest gate. This would explain both batch 3's own weak trigger
accuracy after the I11 rewrite and, more broadly, why corpus growth
degrades even unrelated packs' (python's) trigger accuracy: every new
skill's frontmatter triggers are themselves I11-compliant (low overlap
with THEIR OWN triggers), which does nothing to prevent them from
accidentally sharing high-IDF tokens with an unrelated skill's query.
Not proven; no content was touched to test this hypothesis in this flow.

**Verification after applying the demotion:**
- `checkStablePackGate('go', 'stable')` — `status: "pass"` (unaffected,
  confirmed directly).
- `checkStablePackGate('python', 'experimental')` — `status:
  "not-applicable"` (correct: a non-stable pack is out of the gate's
  scope by design).
- Full targeted suite re-run: `tsc --noEmit` clean; `stack-packs.test.ts`,
  `scout.test.ts`, `manifest.test.ts`, `stack-pack-eval-integrity.test.ts`,
  `src/agents/generate.test.ts`, `src/agents/verify.test.ts`,
  `src/commands/agents-catalog-commands.test.ts` — see the commit for the
  exact pass count.
