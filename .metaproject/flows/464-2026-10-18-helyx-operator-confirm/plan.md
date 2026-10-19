# Implementation Plan

Status: draft for operator approval

## Approach

Extend flow 456's card framework (`src/commands/operator-confirm-tools.ts`) and the remote bridge (`src/remote/shell-bridge.ts`), not Helyx. The remote bridge already verifies `allowedUserIds`, binds the card to the session topic and returns `fromId`; it is dropped before the record. Close that gap, bind the callback to the existing one-time token, and add the missing `review_complete` card. Alternatives rejected: a Helyx inbound endpoint (nothing in Helyx accepts an external process; larger blast radius, separate repo) and agent-sent polls (the answer would travel through the model, which is the forgery path).

## Steps

1. Carry `fromId` and press time from `askApproval` through `agent.ts` into the card result; add `pressedBy` and `pressedAt` to the record types.
2. Bind the token to the question (subject hash) and callback data; enforce single use and a 1-hour TTL; reject every other answer path.
3. Cards and tools: `review_complete` (SHA, evidence level, waivers); confirm `review_confirm_plan` and `review_decide_premise` answer through the remote card.
4. Fallback: no remote config or failed send leaves the TUI card and the terminal commands intact and says so.
5. TUI surfaces, help modal, command list; docs, skills (both review-orchestrator copies), `unattended.ts`, TM-04 section.
6. Verify, release in a batch with the live test, owner live check.

## Risks

- The agent shares the OS user, so store forgery stays possible; the decision record states the limit and does not claim more.
- Telegram delivery is not guaranteed; the TTL and the terminal fallback cover a lost message.
