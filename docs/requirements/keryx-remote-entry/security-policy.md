# Security Policy: Keryx Remote Entry
Version: 1.0.0

## Status

Future integration policy. It constrains a future adapter to the existing keryx
security and policy boundary. It does not claim the adapter exists today.

This surface is the first thing in keryx that can cause agent execution from
outside the operator's terminal. It is treated accordingly.

## Trust model

- Everything arriving over HTTP is untrusted: prompts, project paths, session
  ids, idempotency keys, headers, and any field claiming an origin or a
  privilege.
- A bearer token authenticates a *caller*. It is not evidence of intent, not a
  grant of policy authority, and not a substitute for the policy engine.
- The TUI remains the canonical surface for credential entry, provider
  selection, policy inspection, and emergency shutdown.
- The operator is assumed **absent**. Every control that depends on someone
  noticing something must instead fail closed on a timer.

## Required decision path

1. Bound body size and content type before parsing semantics.
2. Authenticate with a constant-time comparison; reveal nothing on failure.
3. Stamp origin from the authenticated connection.
4. Resolve the session identity-first from the declared project; never infer.
5. Submit the prompt to `src/security` as untrusted content. A prompt-injection
   or secret finding stops conversion into a turn.
6. Resolve the remote policy profile and verify it is not weaker than local.
7. Let the harness classify each action as `allow`, `ask`, or `deny`.
8. Create a pending approval only for `ask`; never present a `deny` as
   approvable.
9. Redact every stream event, turn result, error body, and transport
   notification before it leaves the process.

A failure at any step produces no privileged effect.

## Authentication and token handling

| Control | Requirement |
|---|---|
| Storage | User-global credential store only (`auth.json`, mode 0600) or an OS credential store, referenced by opaque id. |
| Prohibited locations | Git, project config, `.metaproject` artifacts, prompts, logs, `ctx` raw output, telemetry, fixtures, schemas, error bodies, notification text. |
| Scope | A token is scoped to this install. It is not a project grant on its own; project reach is resolved per request and checked. |
| Rotation | `keryx serve token rotate` issues a new token, invalidates the old one, and does not silently keep both valid. |
| Revocation | Revocation takes effect for in-flight requests at the next authenticated boundary, and immediately for new ones. |
| Exposure in status | `keryx serve status` never prints the token, only a redacted fingerprint. |

## Network exposure

| Control | Requirement |
|---|---|
| Default bind | Loopback only. |
| Non-loopback | Requires an explicit flag **and** a configuration acknowledgement. Either alone is a startup `refused`. |
| Reporting | A non-loopback bind is reported by `keryx serve status` and recorded in evidence at startup. |
| TLS | Not provided by Release 0. A non-loopback deployment without an external TLS terminator is out of scope, and the documentation must not imply otherwise. |
| Public/headless mode | A separate future release with its own operator-owned credential story. It must not inherit Release 0's assumption that a human is nearby. |

## Remote policy profile

| Invariant | Requirement |
|---|---|
| Non-weakening | The remote profile may never grant what the local profile denies. A resolution that would widen is a startup `refused`, not a warning and not a downgrade. |
| Stricter default | Absent explicit configuration: OS sandbox required, network off or restricted, every mutation classified `ask`. |
| Containment | When the profile requires containment and the launcher is unavailable, the turn is refused. It is never run uncontained. |
| No self-escalation | A remote turn cannot widen its own profile, cannot grant itself an allowlist entry, and cannot answer an approval it raised. |
| Origin integrity | Origin is assigned by the server from the authenticated connection. Content claiming an origin is untrusted text. |
| Auto-approve source | Resolved only from the existing policy source. Neither Remote Entry nor any transport may define its own allowlist. |

## Approval containment

An approval view states a concise action summary, its scope, its consequence,
its expiry, and a correlation id. Its identifier is opaque and carries no
arguments a caller could use to reconstruct the command.

| Rule | Requirement |
|---|---|
| Single use | One pending action, one answer, once. |
| Timeout | Unanswered resolves to **deny** at expiry; the denial is recorded. |
| Undeliverable | A delivery failure resolves to **deny immediately**, not after the timeout. |
| Immutability | An answer cannot broaden scope, alter arguments, override a `deny`, or revive an expired record. |
| Ownership | Only a caller entitled to the session may answer, and never the turn that raised it. |
| Replay | A replayed answer returns the original outcome and executes nothing, across process restarts. |

## Data minimization, redaction, and retention

- Render bounded structured summaries; never forward raw tool output, raw
  provider payloads, or raw command arguments.
- Do not disclose absolute paths, secrets, PII, stack traces, or provider error
  bodies in any response, event, or notification.
- Persist minimal redacted records: turn evidence, pending-approval state,
  idempotency keys, and safe delivery metadata, for an explicit retention
  period.
- Store nonces and identifiers as protected values where lookup permits; never
  record raw token material.
- Correlate through opaque correlation ids, never through secret-derived or
  filesystem-derived values.

## Abuse and incident response

| Event | Required response |
|---|---|
| Unauthenticated or malformed request | Fixed `401`, redacted fingerprint logged, no state change, no enumeration signal. |
| Repeated authentication failure | Throttle the peer; never throttle an authenticated in-flight turn. |
| Prompt-injection or secret finding in a prompt | Reject with `422`; state only that it was rejected. No turn is created. |
| Unknown or unreachable session | Indistinguishable response from "not permitted". |
| Approval replay or duplicate | Idempotent safe result; no re-execution. |
| Containment unavailable | Refuse the turn. Never downgrade to an uncontained run. |
| Token compromise suspicion | Revoke, rotate, drain the listener, preserve only redacted incident evidence. |
| Non-loopback bind discovered unacknowledged | `refused` at startup; the listener does not open. |

## Security validation

Release gates must include offline fixtures for: token-like strings in tool
output, injection attempts in prompts, unauthenticated and wrong-token requests,
duplicate and expired approvals, self-grant attempts, forged origin fields,
absolute paths and PII in tool output, denied actions presented as approvable,
a widening remote profile, an unavailable sandbox launcher, and a mid-turn
restart with a confirmed action.

No fixture may contain a real token or open a real listener on a non-loopback
interface.
