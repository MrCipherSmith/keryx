---
Title: "SAC: SAC harness integration demo"
Version: 0.2.0
Type: decision
Status: draft
Summary: "Establishes that Shared Agent Context (SAC) serves as a complementary mechanism alongside the existing wiki and graph systems, rather than a replacement."
---

# SAC: SAC harness integration demo

Records a decision about the role and scope of Shared Agent Context (SAC) within the project.

> **Note on this record:** this page was written by the SAC wiki owner-writer
> from an accepted `wiki-update` proposal (`proposal-a41fc4152ad147e2`,
> workspace `workspace-e1b704272f124ba7`). The proposal's own cited session
> evidence (`session-evidence/77720896-3aa2-4cc6-84c5-5694efdc4c01.md`) is an
> unrelated Q&A about the M1 safety-track containment work — it demonstrates
> the SAC propose/review/write mechanism itself rather than supplying the
> reasoning behind the SAC/wiki/graph boundary. The sections below are
> therefore grounded in the project's dedicated SAC design documents
> (`docs/requirements/shared-agent-context/design-rationale.md` and `prd.md`)
> and the related architecture page
> ([Wiki, Graph, and Shared Agent Context](../architecture/wiki-graph-sac.md)),
> not in that session transcript. Where no source states something, it is
> marked `unknown` rather than inferred.

## Questions this page must close

<!--
  Decision template (wiki-specification.md §4).
  Check question: Why was this approach chosen, and when does the decision stop applying?
-->

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Why doesn't SAC replace or duplicate the wiki, graph, memory, or Flow? | covered | `docs/requirements/shared-agent-context/design-rationale.md` §"Keryx-first boundaries" states each owner explicitly (Flow owns work state, wiki/memory/skills own durable knowledge, SAC composes existing seams); `.metaproject/wiki/architecture/wiki-graph-sac.md` restates the same split with a source-of-truth table. |
| Q2 | What alternative shape was considered and rejected for SAC's boundary? | partial | `design-rationale.md` states the boundaries actually chosen (SAC as a read-first, review-gated entry point) and, for the cross-project/network-storage alternative specifically, states the reason it was deferred rather than adopted. It does not enumerate every alternative shape considered before landing on FWK (Facts/Work/Know-how); this proposal's own evidence (the session transcript) records none. |
| Q3 | Who accepted this specific record, and on what basis? | covered | This page's own Provenance block (Source: sac-proposal, SHA-256 `aad881...`) plus the workspace's decision record `.metaproject/workspaces/workspace-e1b704272f124ba7/proposals/proposal-a41fc4152ad147e2.76a75e924ccc2d2bdcacf3513d319857a089428579055c252a4501ea0cac5de0.decision.json`: reviewer `user:local-502` (authority: owner), decision `accepted`, decided at 2026-08-14T20:28:39.362Z, idempotency key `flow-153-wiki-update-1`. |
| Q4 | What would end or supersede this decision? | unknown | No decision record, the PRD, or the specification states an explicit sunset condition or a successor decision for this specific boundary record. |

## Decision Summary

SAC complements the wiki and graph systems; it does not replace either.

## Rationale

This decision clarifies the integration boundaries for SAC tooling:

- **Wiki** — human-authored, long-lived documentation
- **Graph** — structured relationships and dependencies between artifacts
- **SAC** — ephemeral session context and agent coordination

SAC provides value by bridging these systems without duplicating their responsibilities. It captures transient, session-scoped context that agents need during a task, while durable knowledge continues to live in the wiki and graph.

## Acceptance Criteria

SAC proposals must be:

- Reviewed by an owner/editor with appropriate authority
- Hash-verified against the source session export
- Recorded as mechanically-derived content, not synthesized prose

## Problem

Before this boundary was stated, Keryx already had a graph, a wiki, memory,
Flow, verification evidence, and an agent runtime, but cross-component work
had no unified, permission-aware entry point: participants repeated the same
research, an agent could easily be handed a prompt that was too broad or
stale, and a session's useful output risked either disappearing entirely or
being written into durable memory without enough review
(`docs/requirements/shared-agent-context/prd.md` §"Problem"). Introducing SAC
to close that gap created a second, narrower problem this record answers: SAC
could easily have been built (or later drifted into) a second wiki, a second
work tracker, or a parallel knowledge store — which would fragment ownership
instead of closing the original gap
(`.metaproject/wiki/architecture/wiki-graph-sac.md`, "This separation prevents
knowledge fragmentation...").

## Chosen option

SAC complements the wiki and graph systems; it does not replace either. Concretely, per `design-rationale.md` §"Keryx-first boundaries":

- Flow remains the sole writer of work state; SAC only projects it as "Work".
- Wiki, memory, and skills remain the owners of durable knowledge ("Know-how");
  SAC only references them and routes reviewed proposals to their existing
  owner-writers.
- SAC owns the collaboration entry point, role-aware links, and receipts —
  not a new persistence or egress path of its own.
- The graph is excluded from SAC's know-how kinds entirely: it is a
  structural index, not a knowledge store
  (`.metaproject/wiki/architecture/wiki-graph-sac.md` §"SAC Know-how and Graph
  exclusion").

This specific record was accepted by reviewer `user:local-502` (authority:
owner) on 2026-08-14 — see `## Provenance` below and Q3 in the coverage
table above for the primary source.

## Rejected alternatives and known reasons

- **SAC persisting knowledge directly, bypassing the wiki/memory/skill owner
  writers.** Rejected: `design-rationale.md` states SAC "composes existing
  security and MCP seams rather than creating a direct persistence or egress
  path," and that only an accepted proposal's *owner writer* (not SAC itself)
  lands the wiki/memory/skill change.
- **SAC becoming a second writer of work/task state alongside Flow.**
  Rejected: `design-rationale.md` states "Flow remains the sole writer of
  work state"; the PRD's SAC-4 requirement (§"Product requirements", written
  in Russian in the source) says in substance that Work derives exclusively
  from Flow and must not change Flow or store parallel tasks/statuses.
- **Cross-project or networked SAC storage, instead of local-first.**
  Deferred rather than adopted for v1: `design-rationale.md` §"Why
  local-first and read-first" gives the explicit reason — "its identity,
  sharing and deletion semantics differ materially from local project
  ownership" — and treats it as "a future decision," not a closed rejection.

unknown - beyond the three boundary choices above, no source (this proposal's
own session evidence, the PRD, the specification, or design-rationale.md)
enumerates a fuller list of alternative shapes that were considered and lost
before the project settled on the Facts/Work/Know-how split; the record
above is everything the cited documents state.

## Consequences

**What it buys:** a stated ownership boundary that keeps the wiki, graph,
memory, and Flow each with one job, which is what
`.metaproject/wiki/architecture/wiki-graph-sac.md` credits with preventing
knowledge fragmentation; and a review-gated write path (SAC-9) so a session
summary cannot become accepted knowledge without a human or explicitly
authorised reviewer.

**What it costs:** SAC cannot act as a shortcut store — every reusable result
must go through propose → security/redaction gate → owner review → the
existing guarded write path before it becomes knowledge, which is slower than
writing directly; and SAC's own usefulness as a knowledge store is
deliberately capped (know-how kinds limited to `wiki`, `memory`, `skill`;
graph excluded) even where a caller might want SAC to answer more directly.

## Constraints

Per the PRD (`shared-agent-context/prd.md`) and `wiki-graph-sac.md`, this
decision now requires:

- SAC know-how kinds are limited to `wiki`, `memory`, and `skill`; the graph
  is not a valid SAC know-how target (SAC-5; "SAC Know-how and Graph
  exclusion").
- Only the target owner determines acceptance into wiki/memory; SAC proposals
  must pass schema validation, a security/redaction gate, and owner review
  before any write (SAC-9).
- No raw transcript or hidden reasoning may be persisted as SAC knowledge
  (`design-rationale.md` §"Safety invariants"; SAC-8 forbids raw transcript
  or hidden reasoning as candidate input).
- Work is read-only from SAC's side: it derives from Flow and must not expose
  an API that changes flow status (SAC-4).

## Supersession

unknown - no decision record, the PRD, or the specification names a
condition that would end this specific boundary record or a decision that
supersedes it. The nearest related statement is `design-rationale.md`'s note
that cross-project/network storage "remains a future decision," which would
revisit the *local-first* assumption this record's environment sits in, not
the wiki/graph/SAC ownership split itself — so even that future decision is
not stated to supersede this one.

## Related Artifacts

### Related Code

*(Add manually when relevant)*

### Related Wiki

- [Wiki Index](../index.md)

## Provenance

| Field | Value |
|-------|-------|
| Source | sac-proposal |
| Session | `session-evidence/77720896-3aa2-4cc6-84c5-5694efdc4c01.md` (raw session transcript, kept local and not committed; the SHA-256 below identifies it) |
| SHA-256 | `aad88101313f79c3306cfc9be51c66c94686e5dedadb4c704af7bf56f80dc60e` |
| Created | 2026-08-14 |
| Updated | 2026-08-14 |

## Changelog

| Version | Date | Change |
|---------|------|--------|
| 0.2.0 | 2026-09-26 | Added the Decision template's mandatory sections (Problem, Chosen option, Rejected alternatives and known reasons, Consequences, Constraints, Supersession) and a `Questions this page must close` coverage table, grounded in `docs/requirements/shared-agent-context/` and `wiki-graph-sac.md` since this proposal's own session evidence does not cover the SAC/wiki/graph boundary reasoning. Fixed the broken session-evidence link. |
| 0.1.0 | 2026-08-14 | Initial version written by SAC wiki owner-writer from accepted proposal |
