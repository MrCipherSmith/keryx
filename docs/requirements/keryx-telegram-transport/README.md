# Keryx Telegram Transport
Version: 2.0.0

## Purpose

This package specifies a future, optional Telegram transport for the Keryx
Project Agent Harness. It lets explicitly paired users observe long-running
local work, approve or cancel policy-eligible operations, **and submit work to a
project agent**. It is a requirements package, not a runtime implementation.

From 2.0.0 this transport is a **client of
[keryx-remote-entry](../keryx-remote-entry/README.md)**, not a parallel path into
the harness. Authentication scope, session addressing, asynchronous approvals,
the remote policy profile, and redaction are defined there and are not
re-specified here. This package owns only what is Telegram-specific.

## Status

**Specification ready (future).** No Telegram integration is claimed to be
implemented. The Project Agent Harness it ultimately reaches *is* implemented
(`src/harness/`); Remote Entry, which this transport requires, is not.

## Scope

Release 0 is a private-chat bot for one or more explicitly paired users. A
desktop/local process uses long polling by default; it validates a locally
supplied token, pairs a chat through a one-time deep link, and then delivers
status, progress, error summaries, approval prompts, cancellation of the user's
own active operation, and turn submission against a bound project.

The desktop UI remains canonical for connecting, access revocation, policy
inspection, and emergency disablement. Task Manager remains the only writer of
managed-flow state; Telegram never writes `flow.json`.

## Boundary change in 2.0.0

Version 1.0.0 scoped Release 0 to a **companion**: `status.read`,
`operation.cancel-own`, `approval.respond`, and `pairing.start`. Submitting work
was an explicit non-goal.

**2.0.0 widens the boundary** to include `task.submit`. The reasoning, the
concerns this raises, and the compensating controls that pay for it are recorded
once in [keryx-remote-entry PRD](../keryx-remote-entry/prd.md) §Decision. In
short: a submitted prompt is untrusted content and is scanned before it can
become a turn; remote turns run under a policy profile that is never weaker than
local and is stricter by default; origin is stamped by the server and cannot be
forged; and a turn can never approve its own `ask`.

This is a real perimeter expansion, recorded as a decision rather than left as
drift.

## Non-goals

- A second agent runtime, domain-state owner, or remote control plane.
- Direct shell execution, filesystem mutation, network access, or subagent
  dispatch initiated from a Telegram message. `task.submit` submits a *prompt*
  to the policy-governed run loop; it is not a tool call and never bypasses
  classification.
- Defining its own token scope, allowlist, session store, or approval semantics —
  those belong to Remote Entry.
- Groups, channels, inline mode, Mini Apps, Telegram Login/OIDC, and webhooks in
  Release 0. Forum topics are deferred to Release 1; see
  [specification.md](specification.md).

## Document index

| Document | Purpose |
|---|---|
| [PRD](prd.md) | Product problem, users, scenarios, outcomes, and risks. |
| [Specification](specification.md) | Architecture, ownership, lifecycle, state machine, and acceptance criteria. |
| [Transport protocol](transport-protocol.md) | Typed inbound/outbound transport contracts and operational behavior. |
| [Security policy](security-policy.md) | Trust, authorization, redaction, approvals, and secret-handling rules. |
| [UX flows](ux-flows.md) | Desktop-led setup, pairing, status, approval, cancellation, and recovery journeys. |
| [Metrics and validation](metrics-and-validation.md) | Success metrics, fake-adapter tests, and release validation evidence. |
| [Brainstorm](brainstorm.md) | Alternatives considered and Release 0 recommendation. |
| [Telegram transport configuration schema](schemas/telegram-transport-config.schema.json) | Safe configuration without a raw token. |
| [Credential reference schema](schemas/credential-reference.schema.json) | Opaque OS credential-store reference. |
| [Pairing request schema](schemas/pairing-request.schema.json) | One-time, expiring pairing material. |
| [Pairing result schema](schemas/pairing-result.schema.json) | Safe terminal pairing outcome. |
| [Authorized chat binding schema](schemas/authorized-chat-binding.schema.json) | Explicit local authorization record. |
| [Inbound update receipt schema](schemas/normalized-inbound-update-receipt.schema.json) | Provider-neutral, bounded input record. |
| [Outbound notification schema](schemas/outbound-notification.schema.json) | Redacted, correlated notification contract. |
| [Approval callback schema](schemas/approval-callback.schema.json) | Opaque, expiring one-time callback. |
| [Webhook configuration schema](schemas/webhook-configuration.schema.json) | Future server/headless mode configuration. |

## Related modules

- [keryx-remote-entry](../keryx-remote-entry/README.md): the transport-neutral
  entry this package is a client of. Owns authentication, session addressing,
  asynchronous approvals, the remote policy profile, streaming, and redaction.
- `src/flow`: Task Manager is the authoritative managed-flow lifecycle and state
  owner.
- `src/security`: existing security/policy boundary, input scanning, and
  redaction seam.
- `src/harness`: implemented Project Agent Harness — owner of policy
  classification, evidence, and local-session outcomes.
- `.metaproject`: source of truth for flow, policy/security, evidence, graph,
  wiki, memory, skills, testing, and health capabilities.

## Sources

Telegram protocol claims are constrained to the official documentation:
[Bots overview](https://core.telegram.org/bots),
[Bot features](https://core.telegram.org/bots/features),
[Bot API](https://core.telegram.org/bots/api), and
[webhooks guide](https://core.telegram.org/bots/webhooks).
