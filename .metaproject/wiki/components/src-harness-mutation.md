---
Title: Module src/harness/mutation
Version: 1.0.2
Type: component
Status: accepted
VerifiedScope: sha256:aced14cd652d2f65e2c823d564f64468fcd2cfae252ac5e4c91a0d5f15863b39
Summary: "`src/harness/mutation` is the fail-closed gate for state-changing and shell-capable actions. It guards a proposed action structurally before policy, checks single-use approvals against an action fingerprint, and runs approved mutations through one injected adapter that yields an execution receipt."
---
# Module src/harness/mutation

## Summary

`src/harness/mutation` is the fail-closed gate for state-changing and shell-capable actions. It guards a proposed action structurally before policy, checks single-use approvals against an action fingerprint, and runs approved mutations through one injected adapter that yields an execution receipt. The module groups 12 files and exposes 14 public symbols.

## Overview

The mutation module is the harness's safety gate for actions that change state or run shell-capable commands. It decides whether a proposed action may proceed (`guardAction` in `guard.ts`), checks that a recorded approval still matches the exact action (`checkApproval` in `approval.ts`), and carries out an approved mutation through a single injected adapter, recording the result as an execution receipt (`executeGuardedMutation` in `execute.ts`). The code graph lists the extension, commands and process layers as its dependents, so they call into this gate before acting.

## How it works

The module is three fail-closed layers that run in order, each denying before the next is consulted, with a small fingerprint helper linking them.

The first layer is `guardAction` in `guard.ts`. It runs structural checks that need no policy: it denies when scanning or isolation is unavailable, when the path or a symlink resolves outside the worktree root, when an argv token carries shell metacharacters, when an argument names a private, loopback, link-local or metadata address, and when the action touches credential files or dumps the environment. Only an action that passes all of these is handed to the policy engine's `decide()` from `src/harness/policy` for the profile and risk verdict. The host helpers in the same file decode encoded IPv4 forms (decimal, hex, octal and short dotted) so that the SSRF checks see through alternate spellings.

The second layer is `checkApproval` in `approval.ts`, a pure function over a recorded `ApprovalResult`. It applies a fixed precedence: a missing result, a rejected, expired or invalidated decision, a grant already consumed, a changed fingerprint, an elapsed window, and a headless session each produce an invalid outcome. Only a fresh, matching, unexpired, interactive `approved` decision is valid. The check compares the request's `inputHash` with the current fingerprint and does not read the `binding` field, even though the type carries it.

The third layer is `executeGuardedMutation` in `execute.ts`. It takes the guard outcome and approval check as inputs, rejects read-only trust modes and unvetted input without isolation, then stops on a guard denial or an invalid approval. Only after those gates does it call `adapter.apply` exactly once. The adapter is the single side-effecting boundary and is injected, which keeps the module deterministic and offline. A confirmed effect yields `executed` with evidence references. Any other observed outcome yields `needs-reconciliation` with a receipt marked unconfirmed, which the code comments say lets the `resume` recovery path block an unsafe retry.

`fingerprint.ts` supplies the common identity. `actionFingerprint` is a SHA-256 over the resolved path, the exact argv, and only the allowlisted environment variables, so equivalent actions produce the same value. The guard and execution layers both use it, and the receipt's `inputHash` is built from it.

## Key concepts

### Action and guard types

- **`ActionSpec`** — The action surface being guarded: a target path, the exact ordered argv, and an environment map. Defined in `fingerprint.ts`.
- **`GuardInput`** — Everything `guardAction` needs: the spec, worktree root, policy profile, interactive flag, scan availability, the tool risk, and an optional symlink resolver.
- **`GuardOutcome`** — Either `allow` or `deny` with a reason string.

### Host classification

These helpers classify network-facing targets and share one encoded-IPv4 decoder:

- **`isPrivateEgressHost`** — The broad SSRF predicate: loopback, RFC1918, link-local, metadata, unspecified and CGNAT destinations.
- **`isLoopbackHost`** — Narrower: true only for `127.0.0.0/8`, `::1` and `localhost`.
- **`isPrivateLanHost`** — Covers RFC1918 and CGNAT only. Its comment describes it as the explicit re-permit for operator-configured custom providers.

### Approval types

- **`ApprovalRequest`** — A single-use proposal whose `status` is always `"pending"`. Invalidation is computed at check time, not read from a stored status.
- **`ApprovalBinding`** — Ties an approval to a policy profile, policy fingerprint, action fingerprint and provenance id.
- **`ApprovalResult`** — A recorded decision on a request, with an `ApprovalDecision` of `approved`, `rejected`, `expired` or `invalidated`. Only `approved` can authorize execution.
- **`ApprovalInvalidReason`** — The fail-closed reasons: `denied`, `expired`, `stale`, `consumed` or `headless`.

### Approval checking

- **`ApprovalCheckInput`** — The request, the optional recorded result, the current fingerprint, the current time, the interactive flag and whether the grant was already consumed.
- **`ApprovalCheck`** — The outcome union returned by `checkApproval`: `valid`, or `invalid` with an `ApprovalInvalidReason`.
- **`checkApproval`** — The pure check that maps an input to an `ApprovalCheck`.

### Execution types

- **`MutationAdapter`** — The injected side-effect boundary. Its `apply` reports whether the effect was confirmed, absent or indeterminate, plus a hash of what was observed.
- **`ExecuteOutcome`** — `executed` (with receipt and evidence refs), `blocked` (with reason, adapter never called) or `needs-reconciliation` (with receipt).
- **`ExecutionReceipt`** — Imported from `src/harness/resume`. `buildReceipt` in `execute.ts` fills it with a fingerprint-derived `inputHash` and an evidence reference anchored on the observed hash.

## Main flows

### 1. Guarding a proposed action

1. The caller builds a `GuardInput` with the `ActionSpec` of the action, the worktree root, the policy profile and the tool risk.
2. `guardAction` runs its structural checks in order: scan availability, path and symlink escape, shell metacharacters in argv, private-address egress, then credential and environment access.
3. An action that passes is composed with the policy engine's `decide()`, and its verdict becomes the `GuardOutcome`.
4. The caller uses `allow` to proceed or `deny` with its reason to stop. The code graph lists the extension, commands and process layers as dependents of this path.

### 2. Checking a recorded approval

1. A guarded flow holds an `ApprovalRequest` and, once a human or policy decision exists, an `ApprovalResult`.
2. The caller computes the current action fingerprint and supplies the current time, the interactive flag and whether the grant was already consumed, as an `ApprovalCheckInput`.
3. `checkApproval` returns `valid` only for a fresh, matching, unexpired, interactive `approved` result. Otherwise it returns `invalid` with the reason.
4. The function itself does not record consumption. The caller is responsible for tracking that a grant was used and for passing `consumed` back in.

### 3. Guarded execution

1. `executeGuardedMutation` receives the `ActionSpec`, the trust mode, the isolation flag, the `GuardOutcome` and the `ApprovalCheck`.
2. It applies its gates in order: read-only trust mode, unvetted input without isolation, guard denial, then invalid approval. Any failure returns `blocked` and the adapter is never called.
3. If all gates pass, `adapter.apply` runs exactly once. A confirmed effect returns `executed` with its evidence references, and any other outcome returns `needs-reconciliation` with a receipt.

`execute.test.ts` holds the regression coverage for this path, and the `guard.*.test.ts` files cover the host and SSRF classification.

<!-- keryx:reference:begin v=1 hash=ec88e84e5e64c4ffb82c0f0ec37ad64bb7103a586aa91928fc2115b7ea4dc6ca -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GuardOutcome`
- `GuardInput`
- `isPrivateIPv4`
- `isPrivateOrReservedAddress`
- `looksLikeIpHost`
- `isPrivateEgressHost`
- `isLoopbackHost`
- `guardAction`
- `isPrivateLanHost`
- `ApprovalBinding`
- `ApprovalRequest`
- `ApprovalDecision`
- `ApprovalResult`
- `ApprovalInvalidReason`
- `ApprovalCheck`
- `ApprovalCheckInput`
- `checkApproval`

### Key files

- `src/harness/mutation/guard.ts` - imported by 17, imports 4
- `src/harness/mutation/approval.ts` - imported by 10, imports 1
- `src/harness/mutation/execute.test.ts` - imported by 0, imports 10
- `src/harness/mutation/fingerprint.ts` - imported by 9, imports 0
- `src/harness/mutation/execute.ts` - imported by 1, imports 6
- `src/harness/mutation/guard.ssrf-encoded.test.ts` - imported by 0, imports 4

### Depends on

- `src/harness/policy` - 4 import(s)
- `src/harness/tool` - 2 import(s)
- `src/harness/resume` - 1 import(s)

### Depended on by

- `src/commands` - 3 import(s)
- `src/harness/extension` - 3 import(s)
- `src/harness/process` - 2 import(s)
- `src/harness/process/sandbox` - 1 import(s)
- `src/harness/provider/anthropic` - 1 import(s)
- `src/harness/provider/compat` - 1 import(s)

### Dependency basis

- Production imports only: 18 import(s) from test file(s) (e.g. `src/harness/extension/execute.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 14
- Cross-module imports: 7
<!-- keryx:reference:end -->

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/harness/resume](src-harness-resume.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness/provider/ollama](src-harness-provider-ollama.md)
- [Module src/harness/extension](src-harness-extension.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
