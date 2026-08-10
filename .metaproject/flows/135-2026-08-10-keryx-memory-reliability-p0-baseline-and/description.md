# Keryx Memory Reliability P0 — baseline and contract tests

Status: ready for freeze
Source: Keryx Memory Reliability requirements package, phase P0

## Problem

The memory reliability requirements need a durable, executable baseline before
P1 changes the service contract. Current recall is advertised as read-only but
the service writes `data/memory/artifacts/latest.{md,json}`, while the harness,
MCP, and approval-context surfaces classify or invoke that path as a read. The
existing tests cover ranking and individual integrations but do not compare
filesystem/Git state across all automatic recall boundaries or exercise the
authority lifecycle matrix as one fixture contract.

## Expected Outcome

P0-1 through P0-10 are represented by reusable snapshot tooling, authority and
temporal fixtures, and executable contract tests. The default suite remains
green; known current defects are explicit opt-in characterizations whose exact
assertions are recorded for P1. The flow package contains baseline counts,
traceability, verification commands, and a verified handoff without a PR.

## Out of Scope

P1+ production fixes, service/result contract changes, report-store design,
generated-data migration, accepted-only adapter behavior, lifecycle mutation
APIs, dependency changes, commits, pushes, PRs, and completion of the overall
requirements package.
