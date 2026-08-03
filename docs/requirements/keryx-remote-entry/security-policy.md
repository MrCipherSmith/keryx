# Security Policy: Keryx Remote Entry
Version: 1.1.0

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

## Secrets never traverse the remote surface

| Control | Requirement |
|---|---|
| No acceptance | No route accepts credential material. A request carrying something credential-shaped is not stored as a credential by any path. |
| Handoff only | A caller may request a one-time, expiring, loopback-bound link. The link carries an opaque identifier, a stated purpose and an expiry — no credential material, no provider secret, no filesystem path. |
| Entry | The secret is entered against the loopback address and written directly to the user-global credential store at mode 0600. |
| Exposure | It appears in no response body, stream event, evidence record, session, or log. |
| Lifetime | Single use, consumed atomically; short expiry; invalidated by token rotation or revocation. |
| Away from the machine | A loopback link is unreachable remotely. Reaching it requires the non-loopback bind with its existing flag and acknowledgement. This is the same trade-off already recorded, not a new exception. |

A transport may offer direct secret entry as an **explicit fallback** only under
all of the following, and it is a recorded concession rather than a default:

- never in a shared or multi-member conversation;
- the carrying message is deleted immediately after use;
- the value is excluded from logs, evidence, retained history, and any
  transport-side persistence;
- the operator is told, at the moment of use, that the value transited the
  transport provider's infrastructure and should be rotated if that matters.

Selection of a provider or a model carries no secret and needs none of this.

## Maintenance operations

Maintenance runs deterministic commands rather than model turns, which removes
prompt injection from that path but adds a command-execution surface. It is
bounded by construction.

| Control | Requirement |
|---|---|
| Registry-bounded | Only entries projected from `src/standard/command-registry.ts` are invocable. There is no passthrough and no free-form command. |
| Argument validation | Arguments are validated against the registry entry's declared shape before anything runs. Unknown keys are refused, not ignored. |
| No command substitution | No argument may cause a different command to run. The operation identifier is drawn from a constrained alphabet, so shell metacharacters cannot appear in it. |
| Policy still applies | Registry flags are inputs to classification, never a replacement for it. A read-only operation is still subject to the remote profile. |
| Write operations | Registry `read: false` means the operation writes to the project; it is classified `ask`. |
| Model cost is disclosed | Registry `model: true` operations state their cost in the approval, so spending is a decision rather than a surprise. |
| Growth path | A new operation becomes available by being added to the command registry, which is reviewed like any other code — not by widening the transport. |

## The project registry

| Control | Requirement |
|---|---|
| Contents | Addressing only: opaque id, path, display name, state, timestamps. |
| No secrets | The schema forbids credential material. Credentials live only in the credential store. |
| Not authority | It records which projects exist and how they are addressed. It does not carry project policy, and a project's own `.metaproject/` remains authoritative for everything else. |
| Deletion | A path that has disappeared is marked `missing` and retained. Removal is an explicit operator action, so an unmounted disk never silently erases a record. |
| Exposure | Absolute paths in the registry are operator-facing. They are not rendered into transport notifications, which follow the existing redaction rules. |

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

1.1.0 adds fixtures for: an operation absent from the command registry; crafted
arguments attempting to reach a different command; unknown argument keys; a
`model: false` operation asserting no provider call; a registry entry added
asserting it appears without a transport change; a request carrying
credential-shaped material asserting it is never stored as a credential; a
credential link asserting it carries no credential material; a replayed and an
expired link; a link outstanding across token rotation; and a registry
serialization asserting it holds no secrets.

No fixture may contain a real token or open a real listener on a non-loopback
interface.
