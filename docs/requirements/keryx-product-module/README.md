# Keryx Product Module

Version: 0.1.0

## Purpose

Add the two questions keryx does not ask.

Every module in keryx answers a question: where does this live and what breaks
(`gdgraph`), why is it built this way (`gdwiki`), what did we decide before
(`memory`), what state is the work in (`tasks`), is it correct (`health`,
`testing`), is it safe to publish (`security`). Between them they cover
building, testing, coordinating and most of what a project manager used to do.

Two questions have no module:

- **Why are we doing this, and for whom?** An intention exists today only as a
  flow title and the text of its criteria. There is no set that can be queried.
- **Did it help?** Nothing asks. A flow closes on merge and the history ends.

This package specifies a `product` module that answers both, and states the
theory it is derived from.

## Status

**Draft — specification written, nothing implemented.**

Depends on W0 of [`keryx-acceptance-layer`](../keryx-acceptance-layer/README.md):
without a declared verification kind per criterion there is nothing to index.
That package ships first; this one consumes what it produces.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Status, scope, non-goals, index. |
| [theory.md](theory.md) | The research base: phase transitions, current trends with figures, dated predictions, and the prior literature this does **not** claim to have invented. |
| [prd.md](prd.md) | Problem, goal, users, requirements, release and outcome criteria, risks. |
| [specification.md](specification.md) | Module identity, storage, CLI surface, data contracts, integration points, acceptance criteria. |
| [implementation-plan.md](implementation-plan.md) | Order, decision gates, and the bulk budget. |

## Scope

- One new module, `product`, with four deterministic commands: `index`,
  `admit`, `open`, `map`.
- One derived object: the **intent set**, built from flows and requirements
  packages, never maintained by hand.
- One advisory skill, invoked only when `admit` returns candidates.
- Three additions to steps that already happen: a call in docpack Phase 0, a
  line at flow freeze, a registration at flow completion.

## Non-goals

- **No new subagents.** The judgement steps here are short and single-pass.
  Fanning "does this contradict anything" out to a roster would cost more than
  the problem does.
- **No gate.** Nothing blocks a freeze, a completion, a merge or a new flow. The
  corpus measurement behind `keryx-acceptance-layer` showed that an imposed
  discipline is worked around while an emergent one is not; this module supplies
  visibility, never a requirement.
- **No activity report.** What merged, what closed, who did how much is a solved
  commodity. This module consumes that record; it does not re-emit it.
- **No outcome measurement.** The module does not measure whether something
  helped. It makes it impossible to forget that nobody did.
- **No module named after a role.** `product` is named for the question it
  answers, like every other module here. A module per job title would re-import
  the org chart the work is dissolving.

## Related

- `keryx-acceptance-layer` — the verification kinds this module indexes; ships first.
- `tasks` — flow lifecycle; gains the freeze line and the completion registration.
- `gdskills/planning/docpack-orchestrator` — Phase 0 gains the `admit` call.
- `keryx-p0-improvements` W3 — owns delivering reports to a pull request.
