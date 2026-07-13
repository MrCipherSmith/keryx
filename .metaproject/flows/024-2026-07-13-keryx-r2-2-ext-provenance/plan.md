# Implementation Plan — Flow 024 (Release 2 · R2-2 registered-extension provenance)

Status: frozen scope (R2-2 only) — Release 2

## Approach

Add `src/harness/extension/provenance.ts` composing the W15 registry, R2-1's
`evaluateExtensionGrant`, W12 `childProvenance`, and W7 `Provenance`, test-first: a
successfully registered extension gets a persisted provenance record (pinned manifest +
grant + derived-trust provenance) bounded EXACTLY to its grant (authority not widened);
a capability outside the grant is an escalation that is denied or asks for approval
(registry-side). Additive-only; deterministic/offline; deps `{}`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | security/contract |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | security/contract |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security/contract |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`).

## Steps

1. T1: R2-2 scope + 2 scenarios + reuse surface + integration map (context.md).
2. T5 (RED): `provenance.ts` tests — (a) registerExtensionWithProvenance: registered ok →
   a record with pinned manifestHash + grantId + capabilities == grant (not widened) + a
   derived Provenance; a registerExtension deny → propagate deny (no record); authority not
   widened (record.capabilities === grant.capabilities, no extra). (b)
   evaluateRegisteredExtensionCapability: in-grant → ok; out-of-grant → deny or ask (reuse
   evaluateExtensionGrant — deny without policy+provenance+approval; ask/approval path);
   out-of-enum fail-closed.
3. T6 (GREEN): `src/harness/extension/provenance.ts` composing W15/R2-1/W12/W7/W10. Additive
   registry helper only if needed. Make T5 green.
4. T7 (review): provenance integrity (pinned manifest + grant + derived trust persisted);
   authority-not-widened (registration never grants a capability beyond the grant); escalation
   fail-closed (out-of-grant → deny/ask, never silent — adversarial); D-02 (no flow.json write);
   reuse-only (W15/R2-1/W12/W7/W10 unmodified or additive); determinism; deps `{}`; frozen pkg +
   canonical schemas + src/eval + src/contracts + ADRs untouched.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥1254 + new green; the provenance record persists the
pinned manifest + grant + derived-trust provenance and never widens authority beyond the grant;
an out-of-grant capability → deny/ask (no silent grant); extension/registry write no flow.json;
deterministic; no new dependency.

## Risks

- **Authority widened at registration** → the record's `capabilities` is a COPY of the grant's
  (no extra); T5/T7 assert equality + no capability outside the grant.
- **Silent escalation (out-of-grant granted)** → reuse `evaluateExtensionGrant`; out-of-grant →
  deny unless policy+provenance+approval; T7 adversarial.
- **Rewriting W15/R2-1/W12/W7** → reuse-only/additive; if a real refactor seems needed, STOP.
- **Non-determinism / new dep** → injected id/clock; no SDK/network; deps `{}`.
- **flow.json write / fs mutation** → the record is returned (no fs); T7 greps writeFlow/flow.json = 0.
- **Wrong-worktree / index-guard / frozen-array** → guard directives in every dispatch.
