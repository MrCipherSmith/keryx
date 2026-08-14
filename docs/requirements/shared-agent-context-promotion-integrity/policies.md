# Shared Agent Context — Promotion Integrity Policies
Version: 0.1.0

## Status

**Future / planned policy set.** These policies constrain a future implementation; they do not change current authorisation or storage behavior.

## P-01: Explicit-target policy

Only the finite kind/target pairs in [specification.md](specification.md) may be proposed. Validation happens before owner discovery or rendering. Unsupported, incomplete, or mismatched intent fails closed. In particular, a non-skill proposal must never be converted to a Skill proposal to make it fit an available writer.

## P-02: Canonical-content policy

A proposal revision is immutable. The reviewable subject is the owner-rendered `PreviewBundle`, not a mutable note, sidecar, display title, or later attachment. Any post-creation material input requires a new revision, digest, preview, and review decision.

## P-03: Independent-review policy

The system resolves reviewer identity and authority at the trusted server boundary. It rejects any caller-provided actor/role/reviewer field as authority. Acceptance requires a reviewer independent from the proposer and preview producer under the current canonical identity graph. A policy inability to establish independence is a denial, never a self-review or auto-accept fallback.

## P-04: Owner-controlled-write policy

Only the target owner may render target bytes, validate owner invariants, execute owner security guards, write target storage, and issue `TargetWriteReceipt`. SAC may issue a request and preserve immutable metadata, but it cannot invoke a generic filesystem write as an owner substitute. Owner failure, unavailable security policy, or receipt absence prevents acceptance.

## P-05: Live strict-security policy

Promotion requires a live strict-enforced security decision from the authoritative security policy at both preview and write time. A hard-coded `pass`, advisory/fail-open result, exception fallback, or stale policy revision is not a passing gate. Security output detail is minimised in SAC records.

## P-06: Idempotency and replay policy

The idempotency binding is owner/workspace/proposal/revision/operation plus `bindingDigest`. Duplicate delivery with the complete same binding returns the original result. Any partial match, different proposal/revision, different target or preview digest, or altered owner/policy context is a conflict and causes no mutation. Process correlation identifies an attempt only; recovery never treats correlation mismatch as a new promotion.

## P-07: Transaction and recovery policy

SAC records `pending-write` before calling an owner. The owner atomically persists target mutation plus matching receipt. SAC records the link-back in its own durable workspace transaction and marks accepted only after both receipts verify. Recovery is read-before-write: it asks the owner for the stable intent/scope/binding receipt first, then performs at most the missing idempotent step. A timeout or crash is not evidence of failure, success, or permission to create a new proposal.

## P-08: Locator and workspace policy

All identifiers are parsed before resolution; all paths are derived from canonical workspace/owner registries; and all resolved locations undergo realpath containment. A loaded proposal must prove membership in the requested workspace. Unsafe path, cross-workspace, symlink, unknown target owner, or post-check target change fails before target disclosure or mutation.

## P-09: Link-back and discoverability policy

The owner receipt proves target creation/update; the workspace link-back receipt proves that the originating workspace now references that target. Both are required for `accepted`. Link-back is typed metadata, is idempotent on the same intent/binding, and cannot be supplied by the client or owner. The absence of a link-back leaves an observable recovery state, not an implicitly accepted target.

## Non-negotiable prohibitions

- No automatic acceptance, including restart handlers and single-user mode.
- No direct SAC write to an owner store.
- No client-authored reviewer authority.
- No mutable review subject or digest omission.
- No untyped target path or generic fallback owner.
- No acceptance on a target receipt alone or a workspace link alone.
