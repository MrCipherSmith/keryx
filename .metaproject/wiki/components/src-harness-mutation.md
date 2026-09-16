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

This module owns the mutation-safety layer used by the harness when an operation may change state or interact with potentially sensitive external targets. It exposes public abstractions for evaluating a proposed mutation, deciding whether it is allowed, and validating approvals that authorize risky actions.

The module is used broadly across the harness and command flow, especially by subsystems that need to gate tool execution, provider interaction, or session-sensitive behavior. Its dependencies on `src/harness/policy`, `src/harness/tool`, and `src/harness/resume` indicate that it coordinates policy rules, tool contracts, and resumable operation state.

## How it works

The module is organized around two main public surfaces:

- **Guarding**: `guardAction` evaluates a mutation request represented by `GuardInput` and returns a `GuardOutcome`. This is the primary gate for deciding whether a mutation can proceed.
- **Approval validation**: approval-related symbols describe the data needed to request, bind, and verify an approval for a guarded action. `checkApproval` consumes this data and reports whether the approval is valid or why it is invalid.

The key internal files reveal the architecture:

- `guard.ts` is the highest-impact file in the module, imported by 14 other files. It contains the main guard logic and host-related helpers used by callers across the harness.
- `approval.ts` defines the approval contract used by guarded flows and is imported by 10 files.
- `fingerprint.ts` provides deterministic fingerprinting for mutation or approval data. It has no imports and is imported by 9 files, suggesting it supplies a shared normalization or stable-identity helper.
- `execute.ts` coordinates mutation execution and is exercised by `execute.test.ts`.
- `guard.ssrf-encoded.test.ts` indicates that the guard path includes tests around encoded or otherwise tricky host values, consistent with the exported host-classification helpers.

In short, `src/harness/mutation` sits between callers that want to perform mutations and the lower-level policy/tool/resume machinery that determines whether those mutations may be executed safely.

## Key concepts

- **`GuardInput`**  
  The input shape describing the mutation or action being evaluated by the guard layer.

- **`GuardOutcome`**  
  The result classification returned by `guardAction` after policy and guard checks are applied.

- **`guardAction`**  
  The main guard function used by callers to decide whether a proposed mutation should proceed.

- **`isLoopbackHost`**, **`isPrivateEgressHost`**, **`isPrivateLanHost`**  
  Host-classification helpers used to evaluate network-facing mutation requests. These support guard decisions around potentially sensitive or externally reachable targets.

- **`ApprovalBinding`**  
  The shape that associates an approval with the specific action, context, or target it authorizes.

- **`ApprovalRequest`**  
  The request object describing what approval is being sought.

- **`ApprovalDecision`**  
  A classification representing the decision associated with an approval.

- **`ApprovalResult`**  
  The result of validating an approval, indicating whether the approval is usable in the current context.

- **`ApprovalInvalidReason`**  
  The classification used when an approval cannot be accepted.

- **`ApprovalCheck`**, **`ApprovalCheckInput`**, **`checkApproval`**  
  The contract and function used to validate approval data against the rules expected by the mutation layer.

## Main flows

### 1. Mutation guard evaluation

1. A caller prepares a `GuardInput` describing the mutation it wants to perform.
2. The caller invokes `guardAction`.
3. The guard layer evaluates the request against relevant policy and host-related checks.
4. The function returns a `GuardOutcome`, which callers use to allow, block, or otherwise route the mutation.

This flow is used by a broad set of consumers, including `src/harness/extension`, `src/commands`, and `src/harness/process`.

### 2. Approval binding and validation

1. A guarded operation produces or receives an `ApprovalRequest` and an `ApprovalBinding`.
2. The approval-related data is normalized or identified through fingerprinting, where appropriate.
3. A caller passes an `ApprovalCheckInput` into `checkApproval`.
4. `checkApproval` returns an `ApprovalResult`, or explains failure through an `ApprovalInvalidReason`.

This flow gives the harness a shared way to verify that a human or policy-level approval still matches the action being attempted.

### 3. Mutation execution orchestration

1. `execute.ts` participates in the higher-level mutation path after guard and approval concerns are resolved.
2. It coordinates with `src/harness/tool` and `src/harness/resume` to handle the execution or continuation of the mutation.
3. `execute.test.ts` provides the main regression coverage for this orchestration path.

This flow ties the safety layer to actual tool execution and resumable harness behavior.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GuardOutcome`
- `GuardInput` (interface)
- `isPrivateEgressHost` (function)
- `isLoopbackHost` (function)
- `guardAction` (function)
- `isPrivateLanHost` (function)
- `ApprovalBinding` (interface)
- `ApprovalRequest` (interface)
- `ApprovalDecision`
- `ApprovalResult` (interface)
- `ApprovalInvalidReason`
- `ApprovalCheck`
- `ApprovalCheckInput` (interface)
- `checkApproval` (function)

### Key files

- `src/harness/mutation/guard.ts` - imported by 14, imports 4
- `src/harness/mutation/approval.ts` - imported by 10, imports 1
- `src/harness/mutation/execute.test.ts` - imported by 0, imports 10
- `src/harness/mutation/fingerprint.ts` - imported by 9, imports 0
- `src/harness/mutation/execute.ts` - imported by 1, imports 6
- `src/harness/mutation/guard.ssrf-encoded.test.ts` - imported by 0, imports 4

### Depends on

- `src/harness/policy` - 8 import(s)
- `src/harness/tool` - 5 import(s)
- `src/harness/resume` - 3 import(s)
- `src/contracts` - 2 import(s)
- `src/harness/session` - 2 import(s)
- `src/harness/provider/ollama` - 1 import(s)

### Depended on by

- `src/harness/extension` - 5 import(s)
- `src/commands` - 3 import(s)
- `src/harness/process` - 3 import(s)
- `src/harness/provider/anthropic` - 1 import(s)
- `src/harness/provider/compat` - 1 import(s)
- `src/harness/provider/gemini` - 1 import(s)

### Graph signals

- Files: 12
- Cross-module imports: 22

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

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

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
