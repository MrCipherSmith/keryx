# Audit remediation 3: architecture (cycles, retryableFor, orphans) and own-tree gates (security scan, module data dirs, worktrees, doctor) plus L-16, S-11 (R4, R5)

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
Flow 3 of docs/requirements/keryx-audit-remediation (prd.md R4, R5; specification.md §4.4, §4.5): eight import cycles, four copies of `retryableFor`, a false orphan, a secret scan that cannot cover its own repository, empty module data declarations, stale agent worktrees, two `keryx doctor` follow-ups, and two ledger leftovers (L-16 compat in-band error, S-11 Grok TOML raw values).

## Non-goals
The `tui-shell.ts` split (A-7, blocked by source-text tests — backlog item 11); L-9 (needs a Gemini key).
