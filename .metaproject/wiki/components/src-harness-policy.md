---
Title: Module src/harness/policy
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/policy` groups 8 file(s). Depends on `src/harness/tool`, `src/lib`, `src/contracts`. Exposes 20 public symbol(s)."
---
# Module src/harness/policy

## Summary

`src/harness/policy` groups 8 file(s). Depends on `src/harness/tool`, `src/lib`, `src/contracts`. Exposes 20 public symbol(s).

The module provides the policy vocabulary and helpers used by harness operations to describe profiles, trust, approvals, redactions, and decisions.

## Overview

This module owns the shared model for policy evaluation inside the harness. It defines profile-related types, local profile helpers, trust concepts, and the decision/approval/redaction structures that other harness layers can consume.

It acts as a policy foundation for tools, mutations, child processes, runs, and commands. Rather than executing the full application workflow, it provides the stable contracts and resolution helpers needed to decide whether an action is allowed, restricted, approved, redacted, or otherwise constrained.

## How it works

The module is organized around a few layers:

- Shared contracts and vocabulary in `src/harness/policy/types.ts`, including profile, context, decision, approval, redaction, and trust types.
- Profile definition and resolution helpers in `src/harness/policy/profiles.ts`, including local profile names and shell profile helpers.
- Supporting ranking or ordering logic in `src/harness/policy/ranks.ts`.
- Policy orchestration in `src/harness/policy/engine.ts`, which consumes policy context and dependencies and produces decisions.

The public surface separates identity and configuration types, runtime decision types, and helper functions:

- Profile identity and shape: `PolicyProfileId`, `PolicyProfile`, `PolicyProfileDefaults`, `PolicyProfileRequiredControls`.
- Runtime decision types: `PolicyOutcome`, `PolicyDecision`, `PolicyDecisionWire`, `Approval`, `PolicyRedaction`.
- Trust concepts: `PolicyTrustMode`, `PolicyTrustSource`, `PolicyTrustReliability`.
- Local profile helpers: `LocalProfileName`, `LOCAL_PROFILE_NAMES`, `isLocalProfileName`, `resolveLocalProfile`.
- Shell profile helpers: `shellParentProfile`, `shellChildReadOnlyProfile`.

Dependencies on `src/harness/tool`, `src/lib`, and `src/contracts` indicate that the module coordinates with tool abstractions, shared library utilities, and contract-level data shapes. It is consumed by harness layers such as `src/harness/child`, `src/harness/mutation`, `src/harness/run`, and `src/commands`.

## Key concepts

- `PolicyProfileId`
  - Identifies a policy profile.
- `PolicyProfile`
  - Describes a policy profile’s controls and settings.
- `PolicyProfileDefaults` and `PolicyProfileRequiredControls`
  - Separate default profile behavior from required constraints.
- `PolicyOutcome`
  - Represents the result category of a policy evaluation.
- `PolicyDecision`
  - Represents the runtime decision produced after policy evaluation.
- `PolicyDecisionWire`
  - Represents a serialized or transport/persistence-oriented decision shape.
- `Approval`
  - Represents an approval requirement or approval state associated with a decision.
- `PolicyRedaction`
  - Represents redaction requirements or redaction-related policy output.
- `PolicyContext` and `PolicyDeps`
  - Provide the evaluation context and dependencies needed by the policy engine.
- `PolicyTrustMode`, `PolicyTrustSource`, and `PolicyTrustReliability`
  - Describe trust inputs, where trust comes from, and how reliable it is.
- `LocalProfileName` and `LOCAL_PROFILE_NAMES`
  - Represent known local profile identifiers.
- `isLocalProfileName` and `resolveLocalProfile`
  - Validate and resolve local profile names.
- `shellParentProfile` and `shellChildReadOnlyProfile`
  - Provide profile helpers for shell parent/child scenarios.

## Main flows

### Local profile resolution

1. A caller receives a profile identifier or local profile name.
2. `isLocalProfileName` can validate that the value is one of the supported local profiles.
3. `resolveLocalProfile` resolves the local profile into a usable profile shape.
4. Profile defaults and required controls help downstream consumers understand the effective constraints.

### Policy decision production

1. A harness operation constructs or receives a `PolicyContext`.
2. It supplies `PolicyDeps` to the policy engine.
3. The engine uses profile and ranking logic to determine a `PolicyOutcome`.
4. The result is returned as a `PolicyDecision`, potentially including `Approval` or `PolicyRedaction` information.
5. A serialized or wire-facing representation can be expressed as `PolicyDecisionWire`.

### Shell parent and child policy

1. A parent shell operation can obtain its policy profile through `shellParentProfile`.
2. A child operation can be constrained through `shellChildReadOnlyProfile`.
3. This supports parent-to-child policy propagation while preserving a read-only posture for the child.
