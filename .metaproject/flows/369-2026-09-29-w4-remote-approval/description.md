# P0 W4 remote approval: async approvals over keryx serve (R4d)

Status: draft
Source: operator "по порядку" (helyx 172447), competitive review P0 item 4; roadmap item R4d, specified in docs/requirements/keryx-remote-entry/ and keryx-telegram-transport/security-policy.md

## Problem

A tool call that needs approval is answered by a keypress in the TUI. Over `keryx serve`, and in unattended triggers, an `ask` is turned into a deny (`headless-fail-closed`, reason `approvals-not-implemented-in-this-release`), so remote and scheduled runs work only where nothing needs confirming. `/v1/approvals` and `POST /v1/approvals/{id}` are specified but not built; `pendingApprovals` is a constant 0.

## Expected Outcome

During a `keryx serve` turn an `ask` creates a durable pending approval (opaque id, bounded summary, scope, consequence, expiry, correlation id). A remote client lists it with `GET /v1/approvals` and answers it once with `POST /v1/approvals/{id}`; the answer allows or denies that one call, bound to its fingerprint. An unanswered approval denies at expiry. The behaviour follows the R4d specification; where it is silent the decision is recorded in the flow plan. The TUI shows pending approvals (command, modal, sidebar) and a local CLI can answer them.

## Outcome criteria

- A serve turn that needs approval pauses, a second client answers it over HTTP, and the tool runs exactly once; an unanswered one denies at expiry and the denial is on record.

## Out of Scope

- The Telegram/web card itself: it is a client of this API and lives in the helyx bridge (a separate repository). This flow ships the API, the store, the TUI and the documented contract, not the bot.
- Session-wide grants from a remote answer: a remote allow is one-time only; destructive, credential, publish-lease, untrusted-origin and hook-ask floors are never lifted by an answer.
- Approvals for unattended trigger runs: they keep their deny-and-record behaviour.
