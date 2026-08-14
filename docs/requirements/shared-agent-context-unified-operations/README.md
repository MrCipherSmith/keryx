# Shared Agent Context — Unified Operations (RP-09)
Version: 0.1.0

## Purpose

RP-09 defines a future single operation registry for Shared Agent Context (SAC)
that derives CLI, MCP, Harness, help, and documentation surfaces from one
authorised contract. It makes operations predictable without making protected
workspaces, proposals, or references discoverable to callers without access.

## Status

**Future requirements · spec-ready.** This package does not claim that a
registry, inbox, doctor, or current-workspace behavior exists today.

## Document index

- [Package index](README.md)
- [Product requirements](prd.md)
- [Technical specification](specification.md)
- [Agent protocol](agent-protocol.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Scope

- Canonical operation definitions that generate/validate adapters, help, and
  documentation contracts.
- Consistent capability enablement, error semantics, normalised results, and
  local transport/risk/authorisation declarations.
- Safe workspace current/list/doctor, proposal inbox/show/preview, and handoff
  journeys.
- Executable parity and deprecation management across CLI, MCP, and Harness.

## Non-goals

- Remote identity, remote MCP expansion, web/desktop UI implementation, or
  client-provided authorization identities.
- Discovery of hidden workspaces/proposals/references or a bypass of ACLs.
- A duplicate Flow tracker, proposal store, or knowledge owner.
- Changing Context Operations, Security, Flow, Harness, or owner write
  authority.

## Related modules

- Parent SAC [implementation plan](../shared-agent-context/implementation-plan.md).
- Existing public [Shared Agent Context guide](../../docs/guides/shared-agent-context.md).
- Integrations: CLI/command registry, MCP, Harness tools, Context Operations,
  Flow, Security, Wiki, Memory, Skills, and collaboration.
- Evidence: [integrated analysis report](../../analysis/keryx-improvements-1/2026-08-14/report/ru/report.md).
