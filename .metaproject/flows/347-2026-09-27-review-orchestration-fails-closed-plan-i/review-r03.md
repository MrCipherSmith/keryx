# Review Report — flow 347, round 3 (last in the three-attempt bound)

## Verdict: APPROVE_WITH_SUGGESTIONS → narrow fix task T19 approved by the user

Scope: 0b1d80c2 (R2-1) and a3fc14f3 (option A nonce envelope + R2-4) over 85880201. Reviewer: review-verifier (opus, logic + security, scratch reproductions under `scratchpad/r3/`); schema-valid first dispatch. Targeted suite: 477 pass / 0 fail.

## Verifications

- fixed: R2-1 (checked with a real `bun build` bundle and the source layout; the new throw is unreachable on real inputs — only via injected deps), F-009, SEC2-1/R2-2 (every untrusted `history.push` goes through `scrub`), SEC2-2 (look-alikes irrelevant once authority = exact nonce), R2-3 (tool output verbatim except the nonce), R2-4 (every `finishReason` consumer maps `interrupted` to a non-Completed outcome)
- nonce: 72-bit base64url, 100k samples unique; not logged; persisted only inside nudges in the transcript; each process/child has its own

## Findings

| ID | Sev | Where | Finding |
|---|---|---|---|
| R3-1 | minor | `agent.ts` `buildRepeatedFailureHint` call | up to 200 chars of raw tool error text (newlines included) ride inside a genuine nonce-bearing nudge — attacker-controlled stderr / MCP error can speak under the trusted marker. Reproduced. |
| R3-2 | minor (pre-existing) | same call | hint uses raw `result.output`, not the redacted `modelOutput`; a token in a repeated error reaches the provider. Reproduced. |
| R3-3 | info | `agent.ts` hook `additionalContext`, anchors block | the two history channels not passed through `scrub`; no attack path found |
| R3-4 | info | `src/acp/server.ts` | stale "undefined on EVERY abort path" comments; `controlNonceBySession` never pruned; children no longer share a cacheable system prefix (within-session caching unaffected) |

## Disposition (user, 2026-09-27)

The review/fix loop has used its three attempts; the findings are new (not a repetition) and confined to one call site. Strategy change instead of a fourth full round: T19 is a narrow fix (R3-1 hint names the tool and points at its result without quoting it; R3-2 redacted output; R3-3 scrub both channels; R3-4 comments + prune on session close), each with a test that fails without it, verified by the orchestrator's diff read, targeted tests, full `test:core` vs base, and re-running the reviewer's `scratchpad/r3/nonce.ts` reproduction — no fourth review round.
