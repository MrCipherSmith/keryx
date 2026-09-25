# Implementation Plan

Status: active

## Approach

Handle negation at TOKEN-EXTRACTION time, in the shared `entryLexicalTokens`
path in `src/gdskills/governance/scout.ts`, not by touching the shared
`routeTokens`/`normalizeRouteText` tokenizer in `src/lib/route-tokens.ts`
(that tokenizer is also used for live query tokenization, which has no
"exclusion clause" concept — a query is not a skill definition). Concretely:

1. Add a small, deterministic sentence/clause splitter + a regex set for the
   exclusion-clause openers actually used in bundled SKILL.md files
   ("NOT for", "Never …", "Do not use for …", "Use `<x>` instead"),
   surveyed first with `keryx ctx rg`.
2. For each entry, split its description+triggers text into clauses; tokens
   from clauses that match an exclusion opener are extracted SEPARATELY as
   `excludedTokens` and are removed from the entry's ordinary coverage-token
   set. Decision (recorded in journal): excluded tokens do NOT count as
   negative evidence either, initially — conservative default per the flow
   parameters — unless the survey of real skills shows a clear, safe case
   for a small negative weight; re-decide after the survey.
3. `entryLexicalTokens`/`lexicalTokens` for scoring entries changes; QUERY
   tokenization (`lexicalTokens(query)` in `rankCatalog`) is unaffected —
   queries aren't skill definitions and don't carry exclusion clauses.
4. `scoutSkill`'s use/fork decision reuses `rankCatalog`, so AC2 falls out
   of AC1 automatically once entry tokens are negation-aware — verify with
   a direct test scoring a skill's own "Not for <sibling>" clause against
   that sibling.
5. Tests: unit tests in scout.ts's own test file with real bundled catalog
   entries (testing skill vs. an implementation skill's "Not for writing
   tests" clause); a full-catalog regression loop asserting every bundled
   skill's own eval trigger scenarios that currently pass still select
   correctly (or are honestly reported as a pre-existing negation-leak
   regression per AC5's before/after report).
6. Honest re-measurement: run `bun ./src/cli.ts skills eval <id> --scope
   bundled --json` (triggers portion only) before (on a stashless throwaway
   copy of the current behavior, or simply record main's numbers from the
   PR-719 journal / a checkout of main) and after, for every bundled stack
   skill + core bundled skill. Also run `checkStablePackGate` for python and
   go.
7. Docs: update `docs/docs/guides/write-a-rubric-scenario.md` (or the
   closest skill-authoring guide) to say exclusion clauses are safe.

## Steps

1. T1 — Survey exclusion-clause conventions across bundled SKILL.md files
   (`keryx ctx rg`); confirm the clause-opener regex set against real data.
2. T2 — Implement negation-aware token extraction in `scout.ts` (entry side
   only), keep the tokenizer in `route-tokens.ts` untouched, keep the scorer
   pure/deterministic.
3. T3 — Unit + regression tests: real bundled examples (testing vs.
   implementation "Not for writing tests"), full-catalog trigger regression
   loop, scout use/fork negation test.
4. T4 — Before/after trigger-accuracy measurement across bundled catalog +
   `checkStablePackGate` for python/go; record honestly in journal + PR body.
5. T5 — Docs update (write-a-rubric-scenario.md or equivalent).
6. T6 — Local targeted checks (typecheck/eslint on changed files, targeted
   tests), draft PR against `main`, review/fix loop (opus adversarial
   reviewer), CI, sequence merge behind PR #719 per owner rule.

## Risks

- A regex-based clause splitter could misclassify a sentence and silently
  drop real positive evidence (e.g. "Not for the faint of heart" is not an
  exclusion of a topic). Mitigate: scope openers tightly to the surveyed
  conventions, and check the before/after report for any bundled skill
  whose TP count drops for a reason unrelated to negation leakage.
- `checkSkillSelectedLeaveOneOut`'s `DESCRIPTION_SUPPORT_THRESHOLD` gate
  also reads entry tokens; must confirm it doesn't double-penalize once
  negation-aware extraction is in place.
- Stable packs (python, go) could newly fail `checkStablePackGate` purely on
  triggers — report, don't fix, per the flow's fixed parameters.
- PR #719 is still open/draft; do not merge this flow's PR before #719
  merges (owner rule) — sequence via READY_TO_MERGE.
