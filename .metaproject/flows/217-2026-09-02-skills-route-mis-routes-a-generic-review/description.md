# skills route mis-routes a generic review request to a specialist, and orient never reads the prompt

Status: formalized
Source: user description (reported from a live session that asked for a full
review and got neither the orchestrator nor the routing layer)

## Problem

A session was asked, in Russian, for a full review with no fixes. It did not
reach `review-orchestrator`; it planned to read the diff by hand and pick
reviewers itself. The same session ran fourteen bare `grep`s past a routing rule
it had loaded at startup. Both are the same failure: routing that is stated in
prose and enforced by nothing.

The machinery to prevent it already exists. Two pieces of it are broken.

### 1. The router prefers a specialist over the orchestrator, in any language

`keryx skills route "do a full review without fixing"` returns
`review-orchestrator` at 75, correctly. The Russian form of the same request,
`"сделай мне полное ревью без исправления"`, returns `review-frontend` at 65 and
does not list `review-orchestrator` in the top ten. Four Russian phrasings were
tried; all four land on `review-frontend`.

The cause is not the language. `review-frontend` carries the trigger
`"ui review"`. `routeTokens` drops tokens shorter than three characters, so
`"ui"` is discarded and the trigger degenerates to the single token
`["review"]`. The trigger test is
`triggerTokens.every((token) => queryTokens.has(token))`, and `every` over a
one-element list is satisfied by any query containing `review`. So
`review-frontend` claims a full trigger hit (+55) on EVERY review request, in
every language, and beats `review-orchestrator`, whose triggers are honest
two-word phrases (`"full review"`, `"review code"`, `"review changes"`) and
need two matches.

This inverts `review-orchestrator`'s own stated contract: "Use when a code
review is requested and the user does not explicitly name a specialized
reviewer." The unnamed-specialist case is exactly the one it loses. Bare
`"review"` and `"review the PR"` reproduce it in English.

### 2. The Russian synonym map has holes on the words that decide the winner

`RU_SYNONYM_PREFIXES` exists and covers ~45 prefixes; `"ревью" -> review` works.
It has no `"полн" -> full`, so `"полное ревью"` never earns the `full+review`
bonus that puts the orchestrator on top in English. Also missing: `напиш`,
`начн`, `исправ`, `найд`, `объясн`. Consequence beyond review: `"напиши тесты
для этого модуля"` routes to `review-testing-practices` — a reviewer — rather
than to anything that writes tests.

### 3. The prompt never reaches the router

`keryx orient` is already a `UserPromptSubmit` hook whose stdout is added to
context, and it is already installed in this repo. It does not read stdin: its
output is byte-identical for `"сделай полное ревью"` and `"what is 2+2"`. What
it injects is the static Intent Router table — the same prose that already
failed to route the session that reported this.

So the router cannot see the request, and the request never sees the router.

## Expected Outcome

- A trigger cannot fire on fewer meaningful tokens than it was written with; a
  trigger that degenerates to one generic token no longer claims a full hit.
- A generic review request routes to `review-orchestrator` as top-1, in Russian
  and in English, while a request naming a specialist still routes to that
  specialist.
- The Russian prefix map covers the words that decide these outcomes, and the
  behaviour is pinned by a corpus of (query, expected top-1) pairs in both
  languages across the bundled catalog — not by spot checks.
- `keryx orient` reads the prompt and appends a short, targeted routing block
  naming the skill to load and the runner-up. It stays advisory: it injects
  context and blocks nothing.

## Out of Scope

- Blocking or gating. "The agent did not invoke a skill" is the absence of an
  action, and `PreToolUse` intercepts actions; there is nothing to block. A
  substitute-action gate (refusing a single-reviewer dispatch when no
  `keryx review scope` ran) was considered and rejected as a fragile heuristic
  that would fire on legitimate narrow reviews.
- The gdctx routing guard's own defects (it blocks pipe filters such as
  `npm test | grep`, and its matcher is `Bash`-only so the native search tool
  bypasses it). Real and confirmed, but a separate subsystem and a separate flow.
- Reworking the Intent Router table in `.metaproject/index.md`. More prose is
  the thing that failed.
