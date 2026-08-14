# Shared Agent Context — Collaboration and Worktree Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** The following corpus and measures are requirements for a future implementation, not runtime evidence. Execution metrics for this documentation run are disabled.

## Mixed lifecycle acceptance corpus

| Case | Setup and expected result |
|---|---|
| ML-01 Handoff chain | Dispatch -> reservation -> handoff -> result -> verifier -> receipt; causal parents/root and references validate; no raw text payload. |
| ML-02 Proposal interleave | Handoff -> proposal -> review -> target receipt -> collaboration read; separate ledger readers succeed and no record shape is parsed as the other owner. |
| ML-03 Unknown future tag | Tagged-union consumer ignores an unknown non-owned tag without failing its known event stream. |
| ML-04 Malformed owned record | Invalid nested handoff/reference is rejected before append; existing ledger remains readable. |
| ML-05 Reservation crash | Agent crashes with active reservation; expiry makes it inactive and another authorised agent can proceed. |
| ML-06 Conflicting hints | Two agents reserve overlapping scope; both observe hints, neither receives a lock or Flow-state change. |
| ML-07 Overlay publish | Private checkout delta requires review/base revision validation; accepted publication emits receipt and base ref only. |
| ML-08 Bundle drift | Import after source reference/project/base revision changes yields typed stale/unresolved outcome with no copied fallback. |
| ML-09 Capability denial | Handoff, reservation create/release, overlay publish, and bundle export/import deny revoked, expired, missing, wrong-audience, wrong-workflow, cross-project, and cross-checkout capabilities before mutation. |
| ML-10 Evidence lifecycle | Restricted, deleted, or owner-withdrawn artifact references remain denied/unresolved through handoff, overlay publish, bundle export/import, and cross-checkout resolution without revealing content. |

## Multi-worktree corpus

| Case | Required proof |
|---|---|
| MW-01 Sibling base | Two checkouts of one Clone see the same authorised project base revision. |
| MW-02 Private overlay | Sibling checkout cannot list/read another overlay merely by parent path, branch, UID, or common repository location. |
| MW-03 Separate clone | An authorised Clone imports a portable bundle by ProjectId/verified membership; an unauthorised clone learns no shared-store existence. |
| MW-04 Containment | Absolute path, traversal, symlink escape, fabricated checkout ID, and cross-project bundle are denied before artifact disclosure. |
| MW-05 Flow integrity | Collaboration/handoff/reservation operations cannot create, change, or substitute Flow task status/AC data. |

## Acceptance gates

1. CLI, MCP, and Harness handoff calls produce the same normalized event/receipt fixtures and all call the public writer.
2. Mixed-lifecycle and multi-worktree corpus cases pass under restart/append failure injection.
3. All ledger collision, direct write, malformed nested payload, raw-transcript, and cross-overlay tests deny with no new event or owner mutation.
4. Reservation expiry/release is idempotent and never blocks an otherwise authorized owner write.
5. Overlay publish and bundle import preserve project identity/provenance while denying path/proximity authority.
6. Every public collaboration mutation proves authorize-at-use with a current RP-06 action/resource/audience/workflow-bound capability; denial appends no event, reservation, delta, bundle, or owner receipt.
7. Trust/sensitivity/retention/deletion labels propagate without content; restricted, deleted, or owner-withdrawn references cannot be resolved from another checkout or portable bundle.

## Proposed operational measures

Record only metadata: handoff success/denial, malformed-event rejection, reservation age/expiry/release, duplicate-work notices, causal-gap count, overlay publish conflict count, unresolved bundle references, and cross-worktree isolation denials. Do not collect event payload text, prompts, or raw transcript to derive metrics. Thresholds require future baseline data.
