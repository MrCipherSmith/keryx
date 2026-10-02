# Audit remediation 1: provider stream contracts and harness/shell error boundaries (R1, R2)

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
Flow 1 of docs/requirements/keryx-audit-remediation (prd.md R1, R2; specification.md §4.1, §4.2, §8 AC1–AC5): the four provider adapters disagree on what a truncated stream, an in-stream error and a missing tool-call id mean; the sequential tool loop has no error boundary; `/new` leaves stale `/expand` output; completion waiters grow unbounded; an unused worktree helper leaks; one test claims coverage it does not have.

## Non-goals
R3 security depth, R4 architecture, R5 gates (later flows); L-9 needs a Gemini credential.
