# Implementation Plan

Status: approved by operator instruction (helyx 172447)

## Approach

Follow the R4d specification in docs/requirements/keryx-remote-entry/ and keryx-telegram-transport/security-policy.md. A durable approval store modelled on `serve-turn-store.ts`; the serve turn's `ask` handler creates a pending record, emits `approval.pending`, and awaits the answer or expiry. The fingerprint (`toolCallHash`, `isApprovalFor`) binds an answer to one call.

Decisions where the spec is silent:
- Orphaned pending record after a restart: the turn that raised it is gone, so the record resolves as expired-deny with the reason on record and the call is never re-executed (safe default, no resumption of half-run turns).
- No consumer attached: with `approval.requireConsumer` (default true) the approval resolves as `undeliverable` deny immediately rather than waiting for an expiry no one can beat.
- A remote allow is one-time only: it never sets session grants or MCP trust.
- The Telegram/web card is the helyx bridge's job; this flow documents the contract.

## Steps

1. `src/lib/serve-approvals-store.ts`: records, events, schema validation, owner-only atomic files.
2. Wire the `ask` path in serve-turn to create, await and resolve approvals; real `pendingApprovals` counter; config keys.
3. Routes `GET /v1/approvals`, `POST /v1/approvals/{id}` with 200/403/404/410 semantics and body validation.
4. Fingerprint binding, floors that stay, at-most-once execution across restart.
5. Startup reconciliation of orphaned records; delivery-failure handling.
6. TUI `/approvals`, modal, sidebar; readline text; `keryx approvals list|allow|deny` (GROUP_SUBCOMMANDS).
7. Client-contract docs, roadmap/requirements status, README, CHANGELOG, version bump.

## Risks

- Double execution on a replayed or raced answer: single-answer transition under a lock, tested with concurrent POSTs.
- Approval leaking command content: the record holds a bounded summary only.
- Bypassing floors through the remote path: floors are evaluated before an answer is consulted.
