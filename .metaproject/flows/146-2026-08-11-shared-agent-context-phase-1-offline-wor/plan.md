# Implementation Plan

Status: selected

## Approach

Implement a small `src/sac/workspace-service.ts` boundary over the Phase 0
contracts. It owns manifest layout and uses `withFileLock` plus temp-file
rename for atomic read-modify-write. Its constructor receives server-issued
ActorContext, role resolver, strict guard, and workspace root; CLI stays a
thin local adapter. This preserves source ownership and makes MCP/UI additions
future clients rather than alternate mutation paths.

## Steps

1. Add service types, manifest validation, path containment, atomic persistence,
   and role/guard checks at operation use time.
2. Add `keryx workspace` local commands for create/list/show/add-resource,
   with only local trusted identity creation at the command boundary.
3. Add direct service and CLI tests for validation-before-write, authorisation,
   root containment, lock-safe mutation, and disabled isolation.
4. Run focused tests, changed tests, typecheck and health; internally review
   changed boundaries before PR handoff.

## Risks

- The existing CLI has no generic authenticated request context. The initial
  local adapter therefore authenticates the current OS user and deliberately
  exposes no caller-provided subject/role flags.
- A strict guard is mandatory for mutation. Its default disabled state must
  cause an explicit denial rather than a fallback write.
