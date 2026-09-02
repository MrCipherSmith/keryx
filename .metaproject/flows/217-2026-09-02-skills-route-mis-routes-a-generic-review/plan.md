# Implementation Plan

Status: ready

## Approach

Fix the scorer, then wire the prompt into the hook that already exists. Nothing
new is installed and nothing new blocks: `keryx orient` is already a
`UserPromptSubmit` hook whose stdout lands in context, so the change is that it
reads the request instead of ignoring it.

The scoring fix is global rather than per-skill. The defect is one rule in
`scoreBundledSkillRoute`, and `review-frontend` is the skill that happens to
expose it; patching that one trigger would leave the rule in place for every
other short-token trigger in the catalog.

## Steps

1. `scoreBundledSkillRoute` — a trigger may not fire on fewer meaningful tokens
   than it was written with. When a trigger's tokens survive filtering at fewer
   than two, fall back to requiring verbatim inclusion instead of the order-free
   `every` test. `"ui review"` then needs `"ui review"` in the query;
   single-word triggers like `"brainstorm"` still work, because verbatim
   inclusion is what they always meant.
2. Trigger specificity — a longer trigger match outranks a shorter one, so a
   request naming a specialist reaches the specialist and a generic one reaches
   the orchestrator. Verify the direction on both cases before keeping it.
3. `RU_SYNONYM_PREFIXES` — add the prefixes that decide these outcomes:
   `полн`, `весь/всего`, `напиш`, `начн`, `исправ`, `найд`, `объясн`, and any
   the corpus in step 4 shows are needed.
4. A routing corpus: (query, expected top-1) pairs in Russian and English over
   the bundled catalog, run as a regression test. This is the deliverable that
   keeps step 1-3 honest; spot checks are what let the defect ship.
5. `keryx orient` — read the `UserPromptSubmit` payload from stdin, route the
   prompt, and append a short block naming the top skill and the runner-up.
   Absent, empty, or unparseable stdin must leave today's output unchanged, so
   the hook cannot break a runtime that sends it nothing.
6. Verify end to end: the hook's stdout must differ for a review request and for
   `"what is 2+2"`, which is the property that is false today.

## Risks

- **A confident wrong suggestion is worse than none.** The block must name the
  runner-up and stay advisory in tone, and it must say nothing at all when no
  skill scores above a floor. A router that answers every prompt teaches the
  agent to ignore it.
- Step 2 can regress the specialist direction while fixing the generic one. The
  corpus has to hold both, and both directions are in it before the change.
- `orient` runs on every prompt: it must never fail the turn. Errors are
  swallowed and the block is simply omitted.
- Runtime enforcement uses the INSTALLED `~/.keryx/keryx`, so none of this takes
  effect for a live session until that build is updated. Stated here so the
  verification is not mistaken for deployment.
