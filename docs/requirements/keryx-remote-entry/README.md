# Keryx Remote Entry
Version: 1.0.0

## Purpose

This package specifies `keryx serve` — a second door into the existing Project
Agent Harness. Today the only way to reach a keryx agent is a TTY: `keryx shell`
owns stdin, and the run loop lives inside a process bound to that terminal.
Remote Entry exposes the same run loop over a local HTTP surface so that a
Telegram bot, a browser workspace, or another product can drive it, without
introducing a second agent runtime or a second owner of session state.

Remote Entry is transport-neutral. Telegram is its first client, specified in
[keryx-telegram-transport](../keryx-telegram-transport/README.md).

## Status

**Specification ready (future).** No runtime, CLI command, HTTP server, or
network listener is introduced by this package. The Project Agent Harness it
builds on *is* implemented (`src/harness/`, ~175 files); Remote Entry is a new
adapter beside the existing TUI adapter, not a rewrite of either.

## Scope

Release 0 is a loopback-bound HTTP entry for explicitly authorized callers:

- a bearer-token-authenticated request that submits a turn to a project agent;
- durable session continuity through the existing append-only session store;
- asynchronous, fail-closed approvals for policy-`ask` actions, because the
  human is no longer sitting at the terminal when the turn runs;
- streamed turn progress;
- mandatory redaction of everything leaving the process.

The TUI stays canonical for provider/model selection, credential entry, and
emergency shutdown. Task Manager stays the only writer of managed-flow state;
Remote Entry never writes `flow.json`.

## Boundary decision

Release 0 of the Telegram package deliberately shipped a **companion** boundary:
observe, approve, cancel — never submit work. This package **widens that
boundary** to full agent operation (`task.submit`) as an explicit, recorded
decision, and pays for it with compensating controls: a remote policy profile
that can never be weaker than the local one, unforgeable turn origin, untrusted
treatment of every remote prompt, and no self-granting of approvals. See
[PRD](prd.md) §Decision and [security-policy.md](security-policy.md).

## Non-goals

- A second agent runtime, provider adapter, or session store.
- A public-internet listener, multi-tenant service, or hosted control plane.
- Writing managed-flow state from outside Task Manager.
- Replacing the TUI as the credential and provider-management surface.
- A new database dependency. Remote Entry stays on the existing on-disk
  append-only session store; keryx keeps zero runtime dependencies.

## Document index

| Document | Purpose |
|---|---|
| [PRD](prd.md) | Problem, users, scenarios, the boundary decision, risks. |
| [Specification](specification.md) | Architecture, ownership, lifecycle, state machine, acceptance criteria. |
| [API protocol](api-protocol.md) | HTTP surface, session semantics, streaming, error contract. |
| [Security policy](security-policy.md) | Trust model, authentication, remote policy profile, approvals, redaction. |
| [Brainstorm](brainstorm.md) | Alternatives considered, the helyx and Eggent evidence, why this shape. |
| [Metrics and validation](metrics-and-validation.md) | Success metrics, offline fake-transport tests, release evidence. |
| [Remote entry configuration schema](schemas/remote-entry-config.schema.json) | Safe configuration without a raw token. |
| [Turn request schema](schemas/turn-request.schema.json) | Inbound turn submission contract. |
| [Turn result schema](schemas/turn-result.schema.json) | Redacted terminal turn outcome. |
| [Stream event schema](schemas/stream-event.schema.json) | Provider-neutral progress event. |
| [Pending approval schema](schemas/pending-approval.schema.json) | Asynchronous, expiring, one-time approval record. |

## Related modules

- `src/harness/run`, `src/harness/session`: the run loop and append-only session
  store Remote Entry reuses unchanged.
- `src/harness/policy`, `src/harness/mutation`: the single source of allow / ask
  / deny classification and approval gating.
- `src/security`: input scanning, prompt-injection detection, and the redaction
  seam every outbound payload passes through.
- `src/flow`: Task Manager, read-only projection only.
- `.metaproject`: graph, wiki, memory, skills, testing, health, evidence.

## Sources

Architectural evidence was collected from two working systems and is recorded in
[brainstorm.md](brainstorm.md): `helyx` (a Telegram-fronted Claude Code
orchestrator running on the same host, studied at `/home/altsay/bots/helyx`) and
the public Eggent workspace (`github.com/eggent-ai/eggent`).
