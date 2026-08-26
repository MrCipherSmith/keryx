# Keryx Full Review Remediation
Version: 1.0.0

Status: **spec ready — not implemented**.

## Purpose

This package turns the validated full-project review into bounded, testable
remediation contracts. It covers architecture seams, health terminology,
failure observability, and pre-persistence handling of untrusted content.

## Documents

- [PRD](prd.md) — problem, users, requirements, risks, and success criteria.
- [Specification](specification.md) — behavioral and integration contracts.
- [Implementation plan](implementation-plan.md) — sequencing and verification.
- [Catch dispositions](catch-dispositions.md) — exact C-01 through C-14 audit.
- [Validation report](../../reviews/keryx-full-project-review-validation-2026-08-26.md).

## Scope

In scope are the two runtime cycles, the harness/SAC and harness/TUI seams,
health decline terminology, fourteen comment-only catches, and durable-write
security ordering. The package does not claim that implementation is complete.

## Non-goals

Provider OAuth, wholesale module reorganization, deletion of intentional graph
orphans, changing the project-level health gate, and retaining blocked raw
content are out of scope.

## Related modules

`src/harness`, `src/sac`, `src/health`, `src/security`, `src/session`,
`src/wiki`, `src/memory`, `src/testing`, and `src/tui`.

