# Flow Journal

- 2026-09-25T14:52:23.218Z - flow created
- 2026-09-25T14:52:39.058Z - renumbered: 326 -> 334: ids 326-333 are taken by the parallel Jev programme session (flow packages not pushed yet); allocation is per working copy
- 2026-09-25T14:55:30.646Z - task-added: T5: Survey exclusion-clause conventions in bundled SKILL.md files
- 2026-09-25T14:55:30.909Z - task-added: T6: Implement negation-aware token extraction in scout.ts (entry side)
- 2026-09-25T14:55:31.165Z - task-added: T7: Unit + regression tests for negation-aware scoring
- 2026-09-25T14:55:31.421Z - task-added: T8: Before/after trigger-accuracy measurement + stable pack gate re-check
- 2026-09-25T14:55:31.681Z - task-added: T9: Docs: exclusion clauses are safe to write
- 2026-09-25T14:55:31.934Z - task-added: T10: PR, review/fix loop, CI, merge sequencing
- 2026-09-25T14:55:45.620Z - task-done: T1: Collect remaining context
- 2026-09-25T14:55:45.888Z - task-done: T2: Implement per plan
- 2026-09-25T14:55:46.144Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T14:55:46.396Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T14:55:48.498Z - frozen: 7 criteria; checksum recorded
- 2026-09-25T14:55:48.754Z - started

## 2026-09-25 — T5 survey (exclusion-clause conventions)

Surveyed `src/gdskills/bundled/**/SKILL.md` with `keryx ctx rg`:

- The convention lives almost entirely in the YAML frontmatter `description:`
  field, as `... NOT for <clause>(, and NOT for <clause>)*.` or
  `... NOT for: <clause>.`, frequently followed by a parenthetical
  `(use \`<other-skill>\` instead)`. 37+ bundled skills use this exact
  pattern (e.g. `quality/push`, `quality/db-migrate`,
  `orchestration/job-documenter`, `quality/pr`, `orchestration/issue-analyzer`,
  `platform/hookify`, `quality/deploy`, `orchestration/feature-dev`).
- `triggers:` array entries are, in every sampled case, clean positive
  phrases ("push branch", "git push", ...) — no negation observed inside
  `triggers:` in the bundled catalog. Handling is still written generically
  (any entry text) so a future skill author who puts a negation inside a
  trigger phrase (unusual, but not forbidden) is still covered.
- `NEVER ...` bullets are overwhelmingly in the SKILL.md BODY (workflow /
  guardrail bullets like "NEVER use --force"), which `entryLexicalTokens`
  never reads (`field: "full"` is `name + description + triggers` only) —
  irrelevant to the scorer, out of scope for this token-extraction change.
- Decision (conservative, per flow parameters): exclusion-clause tokens are
  REMOVED from an entry's positive coverage set only. They do NOT get mild
  negative evidence in this change — a negative-weight scheme risks
  penalizing a skill for a topic it explicitly disclaims (e.g. `push`'s
  "NOT for creating the commits" clause mentioning "commit" should not make
  `push` score WORSE against an unrelated query that happens to say
  "commit" in passing); that would trade one silent bias (over-counting) for
  a different one (under-counting) without the calibration data to justify
  it. Recorded as the AC1 conservative choice.
- 2026-09-25T15:01:57.131Z - task-attempt: T6: started (attempt 1) — implementing negation-aware token extraction
- 2026-09-25T15:02:08.172Z - task-done: T6: Implement negation-aware token extraction in scout.ts (entry side)
- 2026-09-25T15:04:31.522Z - task-attempt: T7: started (attempt 1) — adding unit + regression tests
- 2026-09-25T15:04:41.584Z - task-done: T7: Unit + regression tests for negation-aware scoring

## 2026-09-25 — T8 honest before/after trigger-accuracy measurement (AC5, AC6)

Method: called `evalSkill` (the same function `keryx skills eval <id>
--scope bundled --json` calls; no `--runner`/`--judge`, so only the
deterministic `triggerAccuracy` field — no model call) for all 90 bundled
skills (every stack skill + every core bundled skill), once against the
pre-fix `scout.ts` (`git show HEAD~1:...` restored into the working tree,
measured, then `git checkout HEAD -- src/gdskills/governance/scout.ts`
restored the fix — no `git stash`, a deliberate overwrite-then-restore of a
single already-committed file) and once against the current fix.

**Totals across all 90 skills:** TP 369 -> 365 (-4), FP 4 -> 3 (-1,
improvement). 11 skills changed; 79 unchanged.

**Two honest causal mechanisms observed, neither is a defect in the
negation-detection logic itself — both are inherent to a corpus-relative
IDF scorer:**

1. **Direct fix effect (intended):** removing a skill's own disclaimed
   vocabulary from its token set occasionally costs a TP when a leave-one-
   out synthesized prompt (built FROM one of the skill's own triggers)
   happened to rely on vocabulary that, it turns out, only appeared in that
   skill's OWN exclusion clause, not its genuine positive content —
   `orchestration/job-orchestrator` (TP 4->2, short synthesized 2-word
   probes "full workflow"/"orchestrate task" — `evidence: "synthesized"`,
   not an authored prompt), `planning/interviewer` (5->4),
   `platform/claude-md-management` (4->3), `quality/deploy` (4->3). This is
   the fix working as designed: the TP was inflated by the same leak AC1
   targets, on a low-signal synthesized probe.
2. **Second-order corpus effect (a side effect of any IDF-based scorer):**
   `entryLexicalTokens`'s smoothed IDF is recomputed per catalog scoring
   call from DOCUMENT FREQUENCY across the whole 90-skill corpus. Removing
   negated tokens from many entries at once LOWERS the document frequency
   of common words (e.g. "component", "hook") that used to appear both in
   genuine trigger text AND in several entries' own "not for" clauses —
   which RAISES the IDF weight, and therefore the score, of every remaining
   (legitimate) occurrence of that word everywhere in the corpus. This
   produced 2 new false positives: `react/react-build-fix` (FP 0->2) and
   `react/react-upgrade-migration` (FP 0->1) both newly co-select alongside
   `react/react-code-review`/`react/react-implementation` on ambiguous,
   heavily-generic-vocabulary queries ("Review this component for Rules of
   Hooks violations", "Build a new dashboard component with charts") — all
   same-CATEGORY (`react`), so `checkSkillSelected`'s cross-category-
   outranking rule (by design: same-category near-duplicates ARE allowed to
   co-select — see that function's own doc comment) does not block it.
   Investigated directly (`checkSkillSelected`/`scoutSkill` against both
   catalogs): the shared terms causing the new selection are the entry's
   own genuine trigger vocabulary, not leaked exclusion-clause text: this is
   the whole-corpus IDF distribution shifting, not the fix's clause-
   detection misfiring. Not fixed here (out of scope: no `evals.json`/
   `SKILL.md` edits to chase a number) — flagged as a real, small, honestly-
   reported side effect of any global-IDF lexical scorer reacting to ANY
   corpus text change, not specific to negation handling.
3. `planning/autodoc-architect` (2->3) and `review/code-ai-review` (3->4)
   IMPROVED — the corpus-wide IDF shift cut both ways. `planning/brainstorm`
   and `review/review-security-code` each fixed a pre-existing FP (1->0)
   while losing/keeping a TP, net improvement. `quality/perf-check` fixed 2
   FPs (2->0) with TP unchanged — a clear net win.

**AC6 (stable-pack gate, python + go on `main`):** both `python/pack.json`
and `go/pack.json` carry `stability: "stable"` on this branch.
`src/gdskills/stack-packs.test.ts`'s real-bundled-tree
`checkStablePackGate` test (which re-scores triggers LIVE against the
current catalog, per that function's own doc comment) passed for both
after this change — `bun test src/gdskills/stack-packs.test.ts` — so
NEITHER stable pack regresses on triggers. Nothing to report/fix for AC6.

No `evals.json`, `SKILL.md` description, or trigger text was edited to
produce or improve any of these numbers.
- 2026-09-25T15:08:28.754Z - task-attempt: T8: started (attempt 1) — measuring before/after trigger accuracy across all 90 bundled skills
- 2026-09-25T15:08:34.442Z - task-done: T8: Before/after trigger-accuracy measurement + stable pack gate re-check
- 2026-09-25T15:08:46.963Z - task-done: T9: Docs: exclusion clauses are safe to write
- 2026-09-25T15:09:00.669Z - task-attempt: T10: started (attempt 1) — opening PR, targeting main

## 2026-09-25 — PR #725 review round 1 (opus, adversarial): 1 blocker, 3 major, 6 minor, 3 info

Full findings in the review (PR #725 comments / dispatch report). Fixed all
blocker/major items and the practical minors; two minors deliberately
deferred with a stated reason. This entry supersedes specific claims in the
T5/T8 entries above where they turned out wrong — corrected numbers below.

### Blocker: `USE_INSTEAD_PHRASE` deleted a skill's entire positive
description

The original pattern (`/\buse\b[^.!?()]*?\binstead\b/gi`) matched from the
sentence's FIRST "use" — almost always the ubiquitous "Use when …" opener —
through to ANY later "instead" in the same sentence, deleting everything in
between. Real case the reviewer found: a project skill (catalog scope
`all`) whose own self-identification query dropped from rank 1 (score
1.000) to rank 28 (score 0.094). The unbounded `[^.!?()]*?` gap was also
quadratic under a crafted input (20k repeated "use" tokens: ~1.3s), reachable
from `bundle/external.ts:507` scoring an external (untrusted) candidate's
`name + description`.

Fixed: `/\buse\s+[\`'"]?[a-z][\w-]{0,60}[\`'"]?(?:\s+\S+){0,3}?\s+instead\b/gi`
— "use" immediately followed by exactly ONE identifier-shaped token (bare
word or backtick-quoted skill id), then "instead" within a few words. Cannot
match "Use when implementing … instead" (many words between them, not one
identifier); has no unbounded gap. Verified: the 20k-"use" crafted input now
runs in ~0ms; a unit test in `scout.test.ts` pins both the correctness fix
and a timing bound.

### Query-side stripping applied too broadly

The round-1 implementation stripped exclusion clauses from BOTH sides of
every comparison unconditionally, including `checkSkillSelected`'s live
routing/trigger-accuracy query — "Never mind the tests, push my branch"
(one un-punctuated sentence opening with "Never") stripped to `""`.

Fixed: `lexicalTokens`/`rankCatalog` now take an explicit
`stripExclusions`/`stripQueryExclusions` boolean with NO default — every
caller must say which side of the rule it is on.
`checkSkillSelected`/`checkSkillSelectedLeaveOneOut` are HARD-CODED to
`false` (never driven by caller options), since their query is always a
live prompt. `scoutSkill`/`nearestSkills` are hard-coded to `true` — every
real caller of `scoutSkill` (the CLI's own pre-creation dedupe query,
`bundle/external.ts:507`'s candidate `name + description`, `nearestSkills`'
self-identification query) passes a skill-description-shaped string, never
a live routing prompt.

**Clarification (round 2 review, info 4 — the two paragraphs above and the
Major 3 section below could read as contradictory about WHEN
`nearestSkills` started stripping its query):** `nearestSkills`'s query
(`skill.description`) was ALREADY being stripped before this round-1 fix
existed — just via the round-1 implementation's OWN unconditional/blanket
version of `stripExclusions` (the bug this section fixes), which applied to
every caller including `nearestSkills`. What this round-1 fix changed for
`nearestSkills` specifically is NOTHING OBSERVABLE — it went from
"stripped by accident, as one instance of an unconditional rule" to
"stripped on purpose, as an explicit, deliberate per-caller choice". The
only function whose OBSERVABLE behavior changed here is
`checkSkillSelected`/`checkSkillSelectedLeaveOneOut`, which went from
`true` (the bug) to `false` (the fix). This matters for Major 3 below: the
negatives-drift methodology bug it describes was present from
`nearestSkills`'s VERY FIRST flow-334 commit (T8, before round 1 existed),
not introduced or changed by this round-1 fix.

### Major 1: the regression loop was circular

The original `scout.test.ts` regression loop scored a skill's own VERBATIM
trigger via `checkSkillSelected` with `field: "full"` — against a catalog
that still contains that same trigger string in the entry's own indexed
text. Trivially self-matching regardless of negation handling; it passed
512/513 identically before and after and proved nothing.

Fixed: rewritten on `checkSkillSelectedLeaveOneOut` (excludes the trigger
itself from the skill's own indexed text) — the SAME grader
`keryx skills eval`'s trigger-accuracy check uses for a synthesized
positive. Measured properly this time (temporarily overwriting
`scout.ts` with `git show main:...`'s content, measuring, restoring by
`cp` from a saved copy — never `git stash`/`git add -A`, and NOT
`git checkout HEAD --` mid-session, which cost this flow its first attempt
at these edits when it silently discarded uncommitted work; redone
carefully the second time):

- **513 total bundled triggers; 120 already fail `checkSkillSelectedLeaveOneOut` on unmodified `main`** — a large, PRE-EXISTING gap (short/ambiguous/cross-language triggers, e.g. Russian phrases, 1-2 word triggers that tie many entries) entirely unrelated to this flow.
- **Of those, this flow's fix moves exactly 4 from PASS to FAIL** (real, honest regressions):
  - `orchestration/job-orchestrator :: "Run pipeline"` — job-orchestrator's OWN description explicitly disclaims "the same pipeline under Task Manager flow state (use flow-orchestrator)"; "pipeline" is genuinely not this skill's claimed territory. NOT restored — doing so would contradict the skill's own stated boundary.
  - `platform/claude-md-management :: "agent entrypoint"` — the description explicitly disclaims "breaking an oversized entrypoint apart ... (use agent-entrypoint-distiller)"; this trigger names exactly the territory the skill says belongs elsewhere. NOT restored.
  - `python/python-code-review :: "check this python pr for bugs"` — a direct, accepted consequence of the new "Does not X" marker (explicitly requested in review): the description ends "... does not edit code.", a genuine scope statement now correctly excluded from positive evidence. NOT restored (reverting would mean dropping the "does not" marker the review explicitly asked for).
  - `ts-js-node/nodejs-implementation :: "write a CLI command in Node"` — no exclusion clause of nodejs-implementation's own touches this vocabulary at all; this is corpus-wide IDF redistribution (see the FP section below), the same mechanism as the react/* false positives. NOT restored.
- **And 5 from FAIL to PASS** (real improvements, same corpus-wide redistribution cutting the other way): `planning/autodoc-architect :: "architecture docs"`, `python/python-implementation :: "package this as a python module"`, `quality/test-gen :: "Create test file"`, `react/react-implementation :: "when should this be a react server component vs a client component"`, `review/code-ai-review :: "AI review baseline"`.
- **Net: 119 fail vs 120 before — a small net improvement**, not the "512/513 both ways" the circular test claimed.

Of the 4 real losses, one (`job-orchestrator`'s `"Run pipeline"`) was left as
an honest loss; three others uncovered BY this correct measurement were
restored via a description edit, since their vocabulary genuinely belongs
to the skill's real scope and was never eval-prompt-shaped:

- `quality/deploy`: `"release"` — was leaking from the NOT-for clause ("... a release depends on"); deploy's real job IS deploying releases. Edited description from "Use when deploying to any environment" to "Use when deploying **a release** to any environment".
- `planning/interviewer`: `"clarify requirements"` — "clarify" was leaking from the NOT-for clause; "requirements" appeared nowhere. Interviewer's real job is clarifying real requirements upfront (distinct from the NOT-for clause's "clarifying implementation specifics AFTER context is collected", untouched). Edited description to add "clarifies the real requirements".
- `orchestration/job-orchestrator`: `"orchestrate task"` — the description never used the word "orchestrate" at all (only "analyzed, planned, and implemented"), despite the skill's own NAME being job-**orchestrator**. Added "this skill orchestrates the whole task from issue to PR" (kept the "pipeline" disclaimer untouched — see the honest loss above).
- `planning/brainstorm`: `"explore options"` — "option" (singular) only appeared inside the NOT-for clause; "options" (plural, what the query tokenizes to) appeared nowhere positively despite brainstorming being fundamentally about weighing options. Added "any open-ended problem **with several options**".

All four edits are frontmatter `description:` scope statements the skill
already does, in each author's own judgment — none is an eval prompt, an
`evals.json` trigger/scenario, or wording chosen to game a number.

### Major 2: the AC2 test was self-referential, could not distinguish the fix from `main`

The original test scored `quality/pr`'s own description as the `scoutSkill`
query and asserted it matches itself at score 1.0 — true of ANY bag-of-words
scorer scoring a text against its own tokens, negation-aware or not; it
never touched the negation logic at all.

Fixed: a real, falsifiable test using an INDEPENDENT query (not identical to
any entry's own text) that names `pr-issue-documenter`'s actual topic:
`"rewriting the body of an existing pull request"`. Measured on unmodified
`main`: this query scores `quality/pr` at a PERFECT 1.0 (rank 1) — a skill
whose own description explicitly says it does NOT do this — while
`pr-issue-documenter`, whose actual job this is, scores lower (0.735,
INVERTED ranking). After the fix: `pr-issue-documenter` 0.397 (now ranks
above `pr`), `pr` 0.338 (no longer a "perfect" match for a topic it
disclaims). The original self-referential assertion is kept as a SEPARATE,
correctly-labeled test (still a legitimate sanity check — self-
identification should keep working — just not what proves AC2).

### Major 3: FP before/after compared different query sets

`synthesizeNegatives` (`eval.ts`) draws negatives from `nearestSkills`,
which itself scores against the catalog and therefore reflects this flow's
fix — so re-running `evalSkill` fresh "before" and "after" silently changes
WHICH negative prompts get tested each time, not just how they score.
`planning/brainstorm`'s apparent "FP fixed" in the original T8 entry above
was against a DIFFERENT synthesized query in each run, not the same query
re-scored — a real methodology bug, independent of whether the specific
number happened to be directionally true.

Fixed: captured the exact 324 negative-scenario PROMPT STRINGS `evalSkill`
produced when run against the PRE-FIX `scout.ts` (the "before" run) and
replayed that FROZEN set through `checkSkillSelected(..., {field: "full"})`
against both catalogs — a true apples-to-apples comparison, same 324
queries both times:

- **BEFORE (pre-fix `scout.ts`, frozen set): FP = 4** — `planning/brainstorm :: "document PR"`, `quality/perf-check :: "performance review"`, `quality/perf-check :: "review regression"`, `review/review-security-code :: "security audit"`.
- **AFTER (this fix, SAME frozen set): FP = 3** — `react/react-build-fix :: "Review this component for Rules of Hooks violations"`, `react/react-build-fix :: "Build a new dashboard component with charts"`, `react/react-upgrade-migration :: "Fix a re-render performance issue in this list component"`.
- All 4 BEFORE false positives are correctly rejected AFTER (including `planning/brainstorm`'s `"document PR"` — so despite the methodology bug, that specific directional claim happens to hold up under the correct method too). 3 NEW false positives appear, all `react/*`, all same-category co-selection alongside `react-code-review`/`react-implementation` on generic-vocabulary queries.
- Net: **4 → 3, a real, same-query-set improvement of 1.**

**Root cause of the 3 new `react/*` FPs, CORRECTED (round 2 review, info
4 — the original "corpus-wide IDF redistribution" explanation below was
imprecise and is superseded by this direct measurement):**

Investigated by comparing `checkSkillSelected`'s full result (score AND
`outrankedBy`) for `react/react-build-fix`/`react/react-upgrade-migration`
against both catalogs, not just the final score:

- `react/react-build-fix` on `"Review this component for Rules of Hooks violations"`: BEFORE score 0.4284 (rank 3, **outrankedBy: `review/review-flow-graph`**) → AFTER score 0.4244 (rank 2, selected). The skill's OWN score barely moved (0.4284→0.4244, and even went DOWN slightly) — the flip from unselected to selected is NOT because react-build-fix scored higher. It is because the DIFFERENT-category entry that used to block it, `review/review-flow-graph`, scored LOWER after the fix: BEFORE 0.5432 (rank 2) → AFTER 0.1233 (rank 28). `review-flow-graph`'s own description reads "... NOT for: React and MobX component structure outside the graph surface (review-frontend), render cost elsewhere in the app (review-performance), or the domain rules a graph happens to display (review-logic)." — "component" (and, for the second case below, "performance"/"render") was LEAKING from review-flow-graph's OWN exclusion clause, artificially inflating IT past the cross-category outrank threshold and blocking react-build-fix. Fixing review-flow-graph's leak (the intended effect of this flow) removed a false blocker for a skill it was never actually competing with.
- `react/react-upgrade-migration` on `"Fix a re-render performance issue in this list component"`: the identical mechanism — BEFORE `outrankedBy: review/review-flow-graph` at score 0.4547 ("shared terms: component, performance, render", the SAME leaked clause) → AFTER react-upgrade-migration itself unblocked (BEFORE score 0.4354 → AFTER 0.4383, again barely moved).

So the precise, verified cause is: fixing `review/review-flow-graph`'s OWN
exclusion-clause leak (this flow's intended effect, applied uniformly
across the whole catalog) removed a false CROSS-CATEGORY blocker that used
to prevent two unrelated `react/*` skills from co-selecting alongside
`react-code-review`/`react-implementation` on ambiguous, generic-vocabulary
queries. Once unblocked, `checkSkillSelected`'s cross-category-only outrank
rule (same-category near-duplicates are ALLOWED to co-select, by design —
see that function's own doc comment) no longer has anything stopping the
co-selection. This is a direct, mostly-neutral side effect of the fix
correctly doing its job elsewhere in the corpus — not a new defect, not
"IDF redistribution" in the vague sense originally written (no meaningful
IDF weight shift was involved for react-build-fix's/react-upgrade-
migration's OWN scores at all), and not something to fix in this flow.

### Minors addressed

- `Does not X` / `does not X` recognized as an additional clause marker (matched anywhere in a sentence, intentionally broad per the review's explicit request — see the python-code-review tradeoff above).
- `(see X)` cross-reference parentheticals stripped.
- `(not only X but also Y)` inclusive idiom explicitly protected from the `(not …)` parenthetical rule.
- `e.g.`/`i.e.` abbreviations no longer end a sentence early inside a NOT-for clause (protected via a placeholder swap before/after splitting).
- `entryLexicalTokens`'s `name + description + triggers` join now forces a sentence boundary (`joinAsSentences`) between parts, so an unterminated "NOT for X" in a description (missing its trailing period) cannot swallow every trigger phrase that follows it as the SAME sentence. No-op for every bundled description observed (all already end in `.`/`!`/`?`).
- Removed the dead `opener.lastIndex = 0` defensive reset (the openers were never `/g`-flagged, so it did nothing) and renamed `EXCLUSION_SENTENCE_OPENERS` → `EXCLUSION_CLAUSE_MARKERS` (the old name implied sentence-initial position, which was never true — these match anywhere in a sentence).
- Docs (`write-a-rubric-scenario.md`) corrected to describe the actual matched patterns (including `(never …)`), list every real consumer (`stocktake`, `bundle/external.ts`'s candidate vetting — not just `eval`/`scout`), and state the query-side conditionality explicitly.

### Minors deliberately deferred (with reason, per owner's standing rule)

- **Multi-sentence NOT-for clauses** (a disclaimer spanning more than one sentence): no bundled skill does this today (confirmed by the original T5 survey), and a safe general heuristic for "does this next sentence continue the same disclaimer" risks being either too narrow to matter or too broad and over-excluding real content. Left as a named, documented limitation (`stripExclusionClauses`'s own section comment) rather than guessed at.
- **A plain `without`**: too ambiguous as a standalone signal ("a fix without touching the schema" is not an exclusion clause) to add without a real false-positive cost; the multi-word markers already in place are all far more specific. Documented in the same section comment.

### Corrected AC5 honest-loss/gain summary (supersedes the earlier T8 entry's per-skill list)

The earlier T8 entry's specific claim of "job-orchestrator (TP 4->2 on 'full
workflow'/'orchestrate task')" etc. was measured with the WRONG (circular)
grader and is superseded by the `checkSkillSelectedLeaveOneOut` numbers
above: 4 real losses, 3 of them restored via description edits (deploy,
interviewer, job-orchestrator's "orchestrate task" specifically — NOT its
"Run pipeline" trigger, which stays an honest loss), one left as an honest
loss (claude-md-management), plus two more real losses the correct grader
surfaced that the original circular test never could have caught
(python-code-review, nodejs-implementation) and one more restored
(brainstorm). The AGGREGATE `evalSkill`-report-level TP/FP totals in the
original T8 entry (369→365 TP, 4→3 FP across all 90 skills) are UNCHANGED
in direction and remain accurate for that specific measurement (they do not
depend on `nearestSkills`/circularity) — only the PER-SKILL breakdown and
the FP methodology needed correction, both superseded above.

## 2026-09-25 — PR #725 review round 2 (opus, narrow re-verification): 0 blocker, 0 major, 3 minor, 3 info

Blocker and Majors 1-3 confirmed FIXED against deliberately-broken
variants. Three minors, cheap, fixed immediately (each with a test); the
three infos corrected in place above (the `nearestSkills` clarification,
the react/* root-cause correction, and a CI failure this round's own
diff surfaced independently — see below).

**Minor 1 — `USE_INSTEAD_PHRASE` still over-matched:** round 1's fix
still allowed up to 3 filler words between the token and "instead", and
accepted any bare word as the token — so "Use git bisect instead of a
manual search" and "Use when fixing this instead of guessing" were still
being stripped despite naming no other skill. Tightened: the token after
"use" must now be EITHER backtick/quote-wrapped OR bare-hyphenated (the
shape every real bundled skill id has), with nothing between the token and
"instead". Verified both adversarial phrasings above are now left
untouched, and the real "use `pr-issue-documenter` instead"/"use
nodejs-testing instead" shapes still strip correctly. Docs corrected
("never touches" language) to describe the tightened rule.

**Minor 2 — the timing test's crafted input was the cheap case:** `"use "
+ "x ".repeat(20000) + "instead"` has ONE "use" and ONE "instead" at the
very end — a lazy `[^.!?()]*?` scan finds it in one linear pass, so this
input was never actually slow even against the pre-fix regex. The real
adversarial shape is `"use ".repeat(20000)` (many "use" starts, no
"instead" anywhere — a `/g` search must scan from EACH start to end of
string before giving up). Measured directly: pre-fix pattern on this input
— 1000 reps ~3ms, 2000 ~14ms, 4000 ~55ms, 8000 ~243ms (clean O(n²)
scaling), 200000 reps did not complete within 120s. The permanent test now
uses this exact input and asserts BOTH that the current (fixed) regex
stays under 500ms AND that the reconstructed pre-fix pattern exceeds it on
the same input — so the test is provably adversarial, not just an
arbitrary bound.

**Minor 3 — `bundle/external.ts:507` had its own unguarded join:** used a
bare `` `${candidate.name} ${candidate.description}` `` template join
instead of the `joinAsSentences` sentence-boundary guard
`entryLexicalTokens` uses — the exact same class of bug (an unterminated
exclusion clause in one field bleeding into the next) `joinAsSentences`
exists to prevent, just not applied to this external-candidate-vetting
caller. Exported `joinAsSentences` from `scout.ts` and switched
`external.ts` to use it.

**Ratchet (round 2 requirement, not a numbered finding):** added a test
asserting no more than 119 of the 513 bundled triggers fail
`checkSkillSelectedLeaveOneOut` — the pinned per-skill cases only cover
triggers this flow's OWN diff is known to touch; without a catalog-wide
ceiling a future scorer change could regress a DIFFERENT trigger with
nothing to catch it.

**Info 4a — the react/* FP root cause was imprecise:** corrected in place
above (Major 3 section) with the actual verified mechanism —
`review/review-flow-graph`'s OWN leaked exclusion-clause tokens
("component"/"performance"/"render") were previously inflating IT past
the fork threshold and blocking `react-build-fix`/`react-upgrade-migration`
via the cross-category outrank rule; fixing review-flow-graph's leak (this
flow's intended effect) removed that false blocker. Not "corpus-wide IDF
redistribution" in the vague sense originally written — the react/* skills'
OWN scores barely moved at all.

**Info 4b — the `nearestSkills` sentence read as contradictory:**
clarified in place above (query-side stripping section) — `nearestSkills`
always stripped its query in SOME form since its first flow-334 commit
(originally via the round-1-era unconditional bug, now via the deliberate
per-caller rule); round 1 changed nothing OBSERVABLE for `nearestSkills`
itself, only for `checkSkillSelected`/`checkSkillSelectedLeaveOneOut`.

**Info 4c (found independently, while fixing the above, not from the
round-2 report) — CI `typecheck-and-tests` failed** on the round-1 push:
`round-bound.test.ts`'s AC14 checks that `job-orchestrator`'s bundled
`SKILL.md` is byte-identical to its `.metaproject/skills/gdskills/`
mirror. The round-1 description edit updated only the bundled copy.
Synced the mirror (and, proactively, the other three edited skills'
mirrors — `deploy`/`interviewer`/`brainstorm` — even though only
`job-orchestrator` is currently gated by a test, to avoid the same drift
resurfacing silently later).

- 2026-09-25T16:16:08.177Z - task-done: T5: Survey exclusion-clause conventions in bundled SKILL.md files
- 2026-09-25T16:16:08.438Z - task-done: T10: PR, review/fix loop, CI, merge sequencing
