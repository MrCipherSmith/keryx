# Product Requirements — Full Review Remediation
Version: 1.0.0

Status: **spec ready — not implemented**.

## Problem

The validated review found narrow but cross-cutting risks: runtime dependency
cycles, misleading health labels, fourteen comment-only catches with uneven
observability, and durable writes that can occur before untrusted-content
guarding or can discard a guard's redacted value.

## Goal and users

The goal is behavior-preserving remediation with executable falsifiers. Users
are Keryx maintainers, operators relying on truthful status/errors, and people
whose content or credentials pass through durable sinks.

## Requirements

1. Remove the two runtime SCCs without changing lifecycle semantics.
2. Keep sandbox/env resolution identical for foreground and background jobs.
3. Distinguish declining scopes from regressed scopes at every reporting surface.
4. Record and test all fourteen catch dispositions without raw-content logging.
5. Guard durable writes before persistence; write only approved or redacted data.
6. Keep human proposal confirmation single-use, scoped, and mandatory.

## Success criteria

- Graph predicates show no targeted runtime SCC.
- Boundary tests cover health deltas -3, -2, -1, 0, +1, +2, +3 and null baseline.
- All C-01..C-14 rows map to targeted assertions.
- Redaction persists the replacement; enforced block creates no raw artifact.
- Targeted suites pass and the full-suite comparison adds no failure or skip.

## Risks

The largest risks are over-broad security blocking, changing proposal/session
provenance, and making cleanup failures throw after a result was computed. Work
must use injected clocks, ports, sinks, and process seams to keep those risks
testable and reversible.

## Recommendation

Use bounded contract-first waves: architecture seams, health/observability,
durable-write security, then integrated verification. Keep behavior-preserving
seams separate from security behavior changes.

