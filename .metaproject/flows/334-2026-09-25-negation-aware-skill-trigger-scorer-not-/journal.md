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
