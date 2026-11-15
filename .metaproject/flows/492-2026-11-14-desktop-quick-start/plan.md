# Implementation Plan

Status: draft

## Approach

Quick start is a server-side composition, not a new store. Evidence from the code (src/hub/work/model.ts:20-31, domain.ts:77, domain.ts:299-303, http.ts:234): every mutation is a `WorkCommand` with an `operationId` that is the idempotency key; `flow.create` accepts `specification: null`; `flow.approve-and-start` freezes criteria and is human-only. A new additive route wraps `flow.create` then `intent.create` then `flow.approve-and-start` in one `workTransaction` under one derived `operationId`, so a replay returns the stored receipt and a changed body under the same id gives 409 `idempotency-conflict`, the existing rule.

The mode table (`quick-modes.ts`) and the template questions (`clarify.ts`) are plain data plus pure functions, in `src/hub/work/`, imported by the route, the web and the TUI, so the three surfaces cannot drift. A parity test asserts that every field of the quick-start request is present on both surfaces.

Evidence pass first (T1): the spec's section 6 is rewritten with the real names. Findings live in the review-orchestrator log, not in the work module, and stages do not exist there at all; the evidence report says so and the stage record is described as a derived projection for the next Flow.

Open point to confirm in T1: which handler imports a document, because `specification` may stay null for quick start but the spec file for the Flow must still land somewhere readable.

## Steps

1. T1 evidence report, spec section 6 updated, document-import handler confirmed.
2. T2 tests for the mode table and templates, then `quick-modes.ts`, `clarify.ts`.
3. T3 tests for the quick-start handler (one transaction, replay, conflict, skipped form recorded), then handler and route.
4. T4 web dialog tests, then dialog, i18n RU/EN, embedded assets rebuilt.
5. T5 TUI modal tests, then `/task` command, modal, menu entry.
6. T6 parity test.
7. T7 verification: all new tests, typecheck, web check, a real-Hub smoke run.

## State and event matrix (UI scope)

| State | Event | Web | TUI |
|---|---|---|---|
| closed | open (button / `/task`) | dialog opens, focus on mode | modal opens, focus on mode |
| mode chosen | type description | submit enabled when description is not empty | same |
| mode chosen | questions shown | one field per template question, each skippable | same, keyboard only |
| form filled | submit | request sent with one operation id, submit disabled | same |
| submitting | server accepts | dialog closes, Flow appears in the work view | modal closes, status line names the Flow |
| submitting | replay (same id) | same receipt, no second Flow | same |
| submitting | server rejects (4xx) | error shown in the dialog, input kept | error shown in the modal, input kept |
| submitting | network lost | error with retry, same operation id reused | same |
| any | Escape | closes without sending, draft kept | closes without sending |
| form filled | questions skipped | skip recorded on the Flow | same |

## Risks

- The criteria freeze is human-only; the quick-start route must act as the signed-in operator and never mint a human confirmation for an agent. T1 confirms how the route identifies the actor.
- The TUI slash-menu registry and modal-host registration were not located by the evidence pass; T5 starts from `modal-host.test.ts` and `help-modal.ts`.
- Embedded web assets (`src/hub/web-assets.generated.ts`) must be rebuilt, or the production Hub serves the old UI.
- A mode default for review depth must map onto an existing review profile, not invent one.
