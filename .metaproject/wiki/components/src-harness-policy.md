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

The module provides the policy vocabulary and helpers used by harness operations to describe profiles, trust, approvals, redactions, and decisions. It serves as the canonical source of truth for policy-related types and evaluation logic within the harness subsystem.

## Overview

This module owns the shared model for policy evaluation inside the harness. It defines profile-related types, local profile helpers, trust concepts, and the decision/approval/redaction structures that other harness layers can consume.

It acts as a policy foundation for tools, mutations, child processes, runs, and commands. Rather than executing the full application workflow, it provides the stable contracts and resolution helpers needed to decide whether an action is allowed, restricted, approved, redacted, or otherwise constrained.

## How it works

The module is organized around a few logical layers that separate concerns and keep policy logic modular:

### Types and contracts

`src/harness/policy/types.ts` contains the core vocabulary: profile definitions, evaluation context, decision types, approval structures, redaction models, and trust enums. These types serve as contracts that other harness components agree upon.

### Profile management

`src/harness/policy/profiles.ts` provides utilities for working with named profiles and local profile names. It includes helpers to validate and resolve profiles, as well as shell-specific helpers that construct profiles for parent and child scenarios.

### Ranking logic

`src/harness/policy/ranks.ts` contains supporting logic for ordering or prioritizing policies, profiles, or decisions when multiple candidates exist.

### Policy engine

`src/harness/policy/engine.ts` is the orchestration layer. It accepts a `PolicyContext` and `PolicyDeps`, applies profile and ranking logic, and produces a `PolicyDecision`.

### Public surface

The module exports three main categories of public symbols:

**Profile identity and configuration:**

- `PolicyProfileId` — uniquely identifies a policy profile
- `PolicyProfile` — describes a profile's controls and settings
- `PolicyProfileDefaults` — defines default behavior when no explicit override exists
- `PolicyProfileRequiredControls` — defines constraints that cannot be bypassed

**Runtime decision types:**

- `PolicyOutcome` — represents the result category of a policy evaluation (e.g., allowed, denied, deferred)
- `PolicyDecision` — the runtime decision produced after evaluation, including the outcome and any metadata
- `PolicyDecisionWire` — a serialized or transport-oriented shape for `PolicyDecision`, suitable for persistence or IPC
- `Approval` — represents an approval requirement or current approval state for a given action
- `PolicyRedaction` — represents redaction requirements or policy output related to content removal

**Trust concepts:**

- `PolicyTrustMode` — the mode or level of trust being applied
- `PolicyTrustSource` — where trust input originates (e.g., environment, config, remote)
- `PolicyTrustReliability` — indicates the reliability or confidence of a trust source

**Local profile helpers:**

- `LocalProfileName` — a type representing known local profile identifiers
- `LOCAL_PROFILE_NAMES` — the enumerated list of supported local profile names
- `isLocalProfileName` — validates whether a value is a known local profile name
- `resolveLocalProfile` — resolves a local profile name into a usable `PolicyProfile`

**Shell profile helpers:**

- `shellParentProfile` — constructs a policy profile for a parent shell operation
- `shellChildReadOnlyProfile` — constructs a constrained, read-only policy profile for a child process

### Dependencies

The module depends on:

- `src/harness/tool` — for tool abstractions that may influence policy evaluation
- `src/lib` — for shared library utilities and common types
- `src/contracts` — for contract-level data shapes that define agreed interfaces

### Consumers

This module is consumed by harness layers such as `src/harness/child`, `src/harness/mutation`, `src/harness/run`, and `src/commands`. These consumers rely on the policy types and engine to make gating decisions without needing to understand policy internals.

## Key concepts

### Policy profiles

A policy profile (`PolicyProfile`) encapsulates a set of controls and settings that govern behavior. Profiles can be identified by a `PolicyProfileId` and may include both default behaviors (`PolicyProfileDefaults`) and hard constraints (`PolicyProfileRequiredControls`).

### Policy evaluation flow

When a harness operation requires a policy decision:

1. A `PolicyContext` is constructed, representing the current evaluation environment and inputs
2. `PolicyDeps` are supplied, providing the necessary dependencies (e.g., tool info, environment variables)
3. The policy engine processes the context and dependencies through ranking and profile logic
4. A `PolicyOutcome` is determined, categorizing the result
5. A `PolicyDecision` is produced, wrapping the outcome with additional metadata
6. For serialization or transport, a `PolicyDecisionWire` shape is used

### Trust modeling

Trust is modeled across three dimensions:

- **Mode** — what level of trust is being established (e.g., full trust, partial trust, no trust)
- **Source** — where the trust determination originates (e.g., command-line flag, config file, remote service)
- **Reliability** — how dependable the trust source is (e.g., high confidence, best effort, unverified)

This trinity allows fine-grained policy decisions that consider not just whether something is trusted, but how and from where the trust determination came.

### Approval and redaction

Two extension mechanisms exist for policy decisions:

- **Approval** — represents cases where a policy decision requires human or automated approval before proceeding. An `Approval` type tracks the requirement and its current state.
- **Redaction** — represents cases where policy dictates that certain content must be removed or obscured from output, logs, or artifacts.

### Local profiles

Local profiles are named, pre-defined profiles that can be referenced by name rather than constructed from scratch. The module provides validation (`isLocalProfileName`) and resolution (`resolveLocalProfile`) helpers to work with these built-in profiles.

### Shell propagation

When spawning shell child processes, the harness uses `shellParentProfile` to determine the parent's policy posture and `shellChildReadOnlyProfile` to construct a constrained profile for the child that preserves read-only semantics while respecting parent-level policy.

## Main flows

### Local profile resolution

1. A caller receives a profile identifier or local profile name string
2. `isLocalProfileName` validates that the value matches a known local profile
3. `resolveLocalProfile` converts the validated name into a fully-populated `PolicyProfile`
4. Profile defaults and required controls are extracted and passed to downstream consumers
5. The effective constraints are applied during policy evaluation

### Policy decision production

1. A harness operation constructs or receives a `PolicyContext` containing the evaluation scenario
2. It gathers `PolicyDeps` from available dependencies
3. The policy engine (`engine.ts`) processes the context and dependencies
4. Profile and ranking logic (`profiles.ts`, `ranks.ts`) determine the applicable constraints
5. A `PolicyOutcome` is produced categorizing the result (e.g., allowed, denied, needs approval)
6. The outcome is wrapped in a `PolicyDecision` with relevant metadata
7. If needed for serialization or transport, the decision is converted to `PolicyDecisionWire`

### Shell parent and child policy

1. A parent shell operation queries `shellParentProfile` to obtain its own policy profile
2. The parent may apply additional filtering or restrictions based on its constraints
3. `shellChildReadOnlyProfile` constructs a child profile that inherits appropriate settings while enforcing read-only constraints
4. The child process operates under the constrained profile, preventing unauthorized modifications
5. This pattern ensures policy consistency across process boundaries while maintaining appropriate isolation
