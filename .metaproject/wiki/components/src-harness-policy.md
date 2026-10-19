---
Title: Module src/harness/policy
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/policy` groups 8 file(s). Depends on `src/harness/tool`, `src/lib`, `src/contracts`. Exposes 20 public symbol(s)."
---
# Module src/harness/policy

## Summary

`src/harness/policy` is the deterministic policy core of the harness. It defines the frozen profile, decision and trust types, resolves the three named security profiles, and decides allow, ask or deny for a tool call. It is side-effect free with an injected clock and id sequence, and it fails closed when a profile, approval or trust source is unclear.

## Overview

This module owns the policy contract that the rest of the harness consumes. Its types mirror the frozen `policy-profile` and `harness-policy-decision` schemas and ADR-0003, and it is the one place where a named profile becomes a `PolicyProfile` value. It also owns the decision function `decide`, the context-trust guard `contextIsPolicyTrusted`, the structural comparison `compareProfiles` used to check that a remote profile does not weaken the local one, and a metaproject escalation primitive that can only tighten a decision.

The engine itself has no clock, randomness, network or filesystem access. Callers build a `PolicyContext`, pass it to `decide`, and enforce the result. The one I/O-touching helper, `metaprojectBlastRadius`, reads through a `MetaprojectPort`.

## How it works

### Types and contracts (`types.ts`)

`types.ts` holds the vocabulary and no logic. `PolicyOutcome` is `"allow" | "ask" | "deny"`. `PolicyTrustMode` is `"read-only" | "trusted-local" | "untrusted"`. `PolicyProfileDefaults` gives a baseline outcome for each of `read`, `write`, `shell`, `network` and `delegate`. `PolicyProfileRequiredControls` pins `redactionFailure` and `networkBrokerFailure` to `"deny"`. The remaining shapes are `Approval`, `PolicyContext`, `PolicyDeps`, `PolicyDecision`, its wire projection `PolicyDecisionWire`, the `PolicyRedaction` states, and the trust-source types `PolicyTrustReliability` and `PolicyTrustSource`.

### Profile resolution (`profiles.ts`)

`LocalProfileName` is a closed set of three names, and `resolveLocalProfile` maps each to a `PolicyProfile` by lookup. Fingerprints are SHA-256 of fixed literal strings, not of the profile body, so they do not move when a profile's fields change. `shellParentProfile` and `shellChildReadOnlyProfile` build internal postures that are deliberately not selectable by name.

Remote profiles have their own operator-facing names. `resolveRemoteProfile` maps `remote-restricted` and `remote-read-only` onto local profiles and returns `null` for anything else, so an unknown name becomes a refusal rather than a fallback. `localBaselineProfile` returns the shell parent profile as the ceiling a remote profile may not exceed. `compareProfiles(local, remote)` compares the two structurally (every default key, both trust axes, isolation, and the two deny-pinned controls) and returns the sorted list of widened field paths. It never compares names.

### Trust axes (`ranks.ts`)

`ranks.ts` splits `trustMode` into two axes. `axesOf` maps each mode to an `authority` (`read-only` or `acting`) and an `inputTrust` (`vetted` or `unvetted`). It also defines the orderings `AUTHORITY_RANK`, `INPUT_TRUST_RANK`, `OUTCOME_RANK` and `ISOLATION_RANK`, and `rankOf`, which returns `undefined` for unknown values. Two predicates use these orderings. `exceedingAxes` answers the remote question, whether a candidate claims more than a ceiling. `broadeningAxes` answers the child-inheritance question, whether a child takes on more exposure than its parent. The file's comments state that the two read `inputTrust` in opposite directions on purpose.

### Decision engine (`engine.ts`)

`decide(call, ctx, deps)` resolves one outcome. The checks run in this order:

1. A hard deny applies when the risk is `write`, `shell`, `network` or `delegate` and the profile defaults it to `deny`. The result has `hardDeny: true` and `override: false`, and no approval or role can change it.
2. The managed flow-file guard denies any target that `isManagedFlowFile` recognises, meaning `flow.json` or a `.json` file under a `flows/` directory.
3. A baseline `deny` from the profile is returned as a deny.
4. A baseline `allow` is returned as an allow.
5. For a baseline `ask`, a valid approval authorises allow. A valid approval is one whose `grantedForFingerprint` equals `ctx.actionFingerprint` and which is not a consumed single-use grant. The role is never consulted.
6. A non-interactive context turns the `ask` into a deny, failing closed.
7. Otherwise the result is an `ask`, carrying an `approvalId` and a `provenanceId` drawn from `deps.idSeq`.

`credential` and `destructive` have no default of their own. They become `ask` when the profile's `write` is `allow`, and otherwise take the value of `write`.

`contextIsPolicyTrusted` is a separate guard. A source counts as policy-trusted only when it is not stale, is explicitly `trustedAsPolicy`, and has `reliability === "exact"`. Any missing field fails closed.

### Metaproject escalation (`metaproject-escalation.ts`)

This module sits above `decide` and never weakens it. `escalateForBlastRadius(decision, ctx, threshold)` changes an `allow` to an `ask` when the blast radius is at least `threshold` and the threshold is positive. Every other decision passes through unchanged. `metaprojectBlastRadius(port, target)` counts the affected files returned by `port.graphAffected`, and returns 0 on a port error or a thrown exception.

## Key concepts

### Policy profiles

A `PolicyProfile` carries a `profileId` from the frozen set `read-only-review`, `monitored-trusted-local` and `unattended-untrusted`, a `trustMode`, `defaults`, and `requiredControls`. The same profile id can appear with different content, so comparisons are made on fields, not on names.

### Decisions and outcomes

A `PolicyDecision` records the outcome, the profile it was made under, the matched rules, and an optional reason. `PolicyDecisionWire` adds the fingerprints, `hardDeny`, `override`, `approvalId`, `provenanceId`, `role` and `redaction`. `redaction` takes the values `not-needed`, `applied` or `failed-safe`. The engine always emits `not-needed`, so the redaction state is set elsewhere.

### Approvals

An `Approval` is single-use or reusable, and carries `grantedForFingerprint`. It authorises an action only when that fingerprint matches the current action and it has not been consumed. The engine reads `consumed` but never sets it, so the caller owns consumption.

### Trust

Trust is modelled on the source of a context, not on the wire decision. A source has a `reliability` of `exact`, `estimated` or `unknown`, a `trustedAsPolicy` flag, and a `stale` flag. Only an exact, fresh, explicitly trusted source may act as policy.

### Remote non-weakening

A remote profile is acceptable only if `compareProfiles` returns no widened fields against the local baseline. Two profiles with the same name can differ in every default, so the comparison looks at the defaults themselves.

## Main flows

### Deciding a tool call

1. The caller builds a `PolicyContext` with the profile, the approvals, the action fingerprint, `interactive`, and optionally `targetPath` and `role`.
2. It calls `decide` with the tool call's `toolCallId` and `risk`, and with `PolicyDeps` supplying `clock` and `idSeq`.
3. `decide` runs the ordered checks and returns a `PolicyDecision`.
4. If the outcome is `ask`, the caller obtains an approval and records it in a later context. Only an approval bound to the same fingerprint authorises the action.
5. If the caller needs to escalate on blast radius, `escalateForBlastRadius` runs over the result and can only turn an allow into an ask.

### Resolving a named profile

1. A caller supplies a profile name from configuration, or from a remote profile name.
2. `isLocalProfileName` checks a local name against the closed set. For remote names, `resolveRemoteProfile` returns the resolved profile, or `null` for an unknown name.
3. `resolveLocalProfile` builds the `PolicyProfile` for the name, with its defaults and required controls.
4. The resolved profile is passed to `decide` or to a comparison.

### Checking a remote profile against the local ceiling

1. `localBaselineProfile` returns the shell parent profile as the ceiling.
2. The remote profile is resolved with `resolveRemoteProfile`.
3. `compareProfiles(ceiling, remote)` lists every widened field, such as `defaults.network`, `requiredControls.isolation` or `trustMode.authority`.
4. The remote profile is accepted only when `ok` is true. Per the comments in `profiles.ts`, this is the check `keryx serve` relies on.

### Shell parent and child postures

1. A shell parent uses `shellParentProfile`, which allows network and delegation and asks for writes and shell.
2. A child spawned from a shell uses `shellChildReadOnlyProfile`, which keeps network allowed so it can reach the model provider, and denies write, shell and delegate.

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
