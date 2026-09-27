---
Title: Module src/harness/mutation
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/mutation` groups 12 file(s). Depends on `src/harness/policy`, `src/harness/tool`, `src/harness/resume`. Exposes 14 public symbol(s)."
---
```markdown
---
Title: Module src/harness/mutation
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/mutation` groups 12 file(s). Depends on `src/harness/policy`, `src/harness/tool`, `src/harness/resume`. Exposes 14 public symbol(s)."
---
# Module src/harness/mutation

## Summary

`src/harness/mutation` groups 12 file(s). Depends on `src/harness/policy`, `src/harness/tool`, `src/harness/resume`. Exposes 14 public symbol(s).

## Overview

The mutation module owns the safety layer used by the harness when an operation may change state or interact with potentially sensitive external targets. It provides public abstractions for:

- Evaluating a proposed mutation
- Deciding whether it is allowed
- Validating approvals that authorize risky actions

This module is used broadly across the harness and command flow, particularly by subsystems that need to gate tool execution, provider interaction, or session-sensitive behavior. Its dependencies on `src/harness/policy`, `src/harness/tool`, and `src/harness/resume` indicate that it coordinates policy rules, tool contracts, and resumable operation state.

## How it works

The module is organized around two main public surfaces:

- **Guarding**: `guardAction` evaluates a mutation request represented by `GuardInput` and returns a `GuardOutcome`. This is the primary gate for deciding whether a mutation can proceed.
- **Approval validation**: Approval-related symbols describe the data needed to request, bind, and verify an approval for a guarded action. `checkApproval` consumes this data and reports whether the approval is valid or why it is invalid.

### Key internal files

| File | Purpose | Import impact |
|------|---------|---------------|
| `guard.ts` | Main guard logic and host-related helpers | Imported by 14 files |
| `approval.ts` | Approval contract used by guarded flows | Imported by 10 files |
| `fingerprint.ts` | Deterministic fingerprinting for mutation/approval data | Imported by 9 files |
| `execute.ts` | Coordinates mutation execution | Imported by 1 file |
| `execute.test.ts` | Regression coverage for orchestration | Test file |
| `guard.ssrf-encoded.test.ts` | Tests around encoded/tricky host values | Test file |

## Key concepts

### Guard types

- **`GuardInput`** — Input shape describing the mutation or action being evaluated.
- **`GuardOutcome`** — Result classification returned by `guardAction` after policy and guard checks.
- **`guardAction`** — Main guard function used by callers to decide whether a proposed mutation should proceed.

### Host classification

These helpers evaluate network-facing mutation requests:

- **`isLoopbackHost`** — Checks if target resolves to loopback addresses.
- **`isPrivateEgressHost`** — Checks if target is a private egress endpoint.
- **`isPrivateLanHost`** — Checks if target is within the local area network.

### Approval types

- **`ApprovalBinding`** — Associates an approval with the specific action, context, or target it authorizes.
- **`ApprovalRequest`** — Request object describing what approval is being sought.
- **`ApprovalDecision`** — Classification representing the decision made on an approval.
- **`ApprovalResult`** — Result of validating an approval, indicating whether it is usable.
- **`ApprovalInvalidReason`** — Classification used when an approval cannot be accepted.

### Approval checking

- **`ApprovalCheck`** — Contract for validating approval data.
- **`ApprovalCheckInput`** — Input shape for the approval check operation.
- **`checkApproval`** — Function that validates approval data against rules expected by the mutation layer.

## Main flows

### 1. Mutation guard evaluation

1. Caller prepares a `GuardInput` describing the mutation it wants to perform.
2. Caller invokes `guardAction`.
3. Guard layer evaluates the request against policy and host-related checks.
4. Function returns a `GuardOutcome`, which callers use to allow, block, or route the mutation.

**Consumers**: `src/harness/extension`, `src/commands`, `src/harness/process`

### 2. Approval binding and validation

1. Guarded operation produces or receives an `ApprovalRequest` and an `ApprovalBinding`.
2. Approval-related data is normalized or identified through fingerprinting.
3. Caller passes an `ApprovalCheckInput` into `checkApproval`.
4. `checkApproval` returns an `ApprovalResult` or explains failure via `ApprovalInvalidReason`.

This flow provides a shared way to verify that a human or policy-level approval still matches the action being attempted.

### 3. Mutation execution orchestration

1. `execute.ts` participates in the higher-level mutation path after guard and approval concerns are resolved.
2. Coordinates with `src/harness/tool` and `src/harness/resume` to handle execution or continuation.
3. `execute.test.ts` provides regression coverage for this orchestration path.

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `GuardInput` | interface | Input shape for mutation evaluation |
| `GuardOutcome` | type | Result classification for guard decisions |
| `guardAction` | function | Main guard function for mutation requests |
| `isLoopbackHost` | function | Host classification helper |
| `isPrivateEgressHost` | function | Host classification helper |
| `isPrivateLanHost` | function | Host classification helper |
| `ApprovalBinding` | interface | Associates approval with authorized action |
| `ApprovalRequest` | interface | Request object for approval |
| `ApprovalDecision` | type | Decision classification for approval |
| `ApprovalResult` | interface | Result of approval validation |
| `ApprovalInvalidReason` | type | Reason for approval rejection |
| `ApprovalCheck` | type | Contract for validating approvals |
| `ApprovalCheckInput` | interface | Input for approval checking |
| `checkApproval` | function | Validates approval data |

### Key files

| File | Imports | Imported by |
|------|--------|-------------|
| `guard.ts` | 4 | 14 |
| `approval.ts` | 1 | 10 |
| `fingerprint.ts` | 0 | 9 |
| `execute.ts` | 6 | 1 |
| `execute.test.ts` | 10 | 0 |
| `guard.ssrf-encoded.test.ts` | 4 | 0 |

### Dependencies

| Module | Import count |
|--------|--------------|
| `src/harness/policy` | 8 |
| `src/harness/tool` | 5 |
| `src/harness/resume` | 3 |
| `src/contracts` | 2 |
| `src/harness/session` | 2 |
| `src/harness/provider/ollama` | 1 |

### Dependents

| Module | Import count |
|--------|--------------|
| `src/harness/extension` | 5 |
| `src/commands` | 3 |
| `src/harness/process` | 3 |
| `src/harness/provider/anthropic` | 1 |
| `src/harness/provider/compat` | 1 |
| `src/harness/provider/gemini` | 1 |

### Graph signals

- Files: 12
- Cross-module imports: 22

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

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```
