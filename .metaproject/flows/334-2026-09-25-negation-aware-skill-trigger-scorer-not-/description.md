# Negation-aware skill trigger scorer: Not-for clauses stop counting as evidence

Status: active
Source: description (flow 318 journal / PR #719 review, M3)

## Problem

The skill-selection scorer (`src/gdskills/governance/scout.ts`'s
`coverageScore`/`rankCatalog`/`checkSkillSelected`, tokenized by
`src/lib/route-tokens.ts`) is bag-of-words/IDF with no negation handling.
When a skill's own description or triggers contain an exclusion clause
("Not for X", "Never use for Y", "Use Z instead"), the tokens inside that
clause still count as ordinary positive evidence for the skill. A query
about the excluded topic can therefore score that skill anyway, and a
sibling skill's own "Not for" cross-reference to this skill inflates
`scout`'s overlap score for the "used instead" skill too.

Authors have been working around this by stripping words out of
descriptions and by stuffing eval prompts with jargon, instead of writing
the exclusion clause the guide already recommends. Flow 318 (PR #719)
hit this directly: `nextjs-nuxt` fails its trigger gate partly because of
"a structural limitation of a 5-skill meta-framework pack sharing heavy
vocabulary, compounded by a negation-unaware trigger scorer."

## Expected Outcome

- Tokens inside a skill's own exclusion clauses (description or triggers)
  no longer count as positive evidence for that skill in `rankCatalog`/
  `coverageScore`/`checkSkillSelected`/`checkSkillSelectedLeaveOneOut`.
- `scout`'s use/fork overlap decision (`SCOUT_USE_THRESHOLD`/
  `SCOUT_FORK_THRESHOLD`) uses the same negation-aware token extraction, so
  a skill's own "Not for" sibling cross-reference does not inflate the
  overlap score of the skill it points to.
- The scorer stays pure and deterministic: no model calls, no new
  classifier. `src/harness/routing/**` and `src/harness/decision/**`
  (the Jev programme's router Flow C) are untouched.
- Real bundled-catalog regression coverage: a positive query for one skill
  must not select a sibling just because the sibling's description says
  "Not for <that topic>".
- Before/after trigger-accuracy (TP/FP) measured honestly for every bundled
  stack pack and core bundled skill, with no eval/SKILL.md edits to chase
  the number. Stable-pack gate (`checkStablePackGate`, python/go on main)
  re-checked for a triggers-only regression.
- `docs/docs/guides/write-a-rubric-scenario.md` (or the closest
  skill-authoring guide) documents that exclusion clauses are safe to
  write and are now honored by the scorer.

## Out of Scope

- Any classifier or model call in the scorer (Jev programme's own `choice`
  step consumes these facts later; not built here).
- `src/harness/routing/**`, `src/harness/decision/**`.
- Editing any `evals.json`, `SKILL.md` description or trigger text to
  improve a trigger-accuracy number.
- Fixing a stable pack that regresses only because of this change beyond
  reporting it (per the flow's fixed parameters).
- Version bump / CHANGELOG release sections (handled separately).
