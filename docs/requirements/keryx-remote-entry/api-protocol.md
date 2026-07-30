# API Protocol: Keryx Remote Entry
Version: 1.1.0

## Status

Future contract. No route in this document is implemented. It defines the
provider-neutral HTTP surface that transports (Telegram, a browser workspace, an
embedding product) speak to.

## Principles

- **Small surface.** One route submits work. Everything else observes or
  resolves an approval.
- **Opaque identifiers.** `sessionId`, `turnId`, and `approvalId` are opaque.
  They are never filesystem paths, never derived from secrets, and never
  meaningful to the caller.
- **Redacted by construction.** Every response body is produced through the
  redaction seam. There is no "raw" mode.
- **Silent to strangers.** An unauthenticated caller learns nothing about which
  sessions, projects, or turns exist.

## Authentication

Every route except `GET /health` requires `Authorization: Bearer <token>`.

| Rule | Requirement |
|---|---|
| Comparison | Constant-time. |
| Failure response | `401` with a fixed body. No distinction between "no token", "malformed token", and "wrong token". |
| Enumeration | A `404` for an unknown `sessionId` and a `403` for a session the token may not reach must be indistinguishable to the caller. |
| Logging | A failed attempt is logged with a redacted token fingerprint, never the token. |
| Rate limiting | Repeated failures from one peer are throttled; throttling never blocks an already-authenticated in-flight turn. |

## Routes

### `GET /health`

Unauthenticated liveness only. Returns the listener state and nothing else — no
version, no project, no session count.

### `POST /v1/turns`

Submit a turn. This is the only route that can cause agent execution.

Request body conforms to
[turn-request.schema.json](schemas/turn-request.schema.json):

| Field | Meaning |
|---|---|
| `project` | Absolute project path the caller means. Required. Resolution is exact-match; see identity-first binding in [specification.md](specification.md). |
| `sessionId` | Existing session to continue. Omitted means "create for this project" when `create` is permitted. |
| `prompt` | Untrusted text. Scanned before it can become a turn. |
| `stream` | Whether the caller intends to consume the event stream. |
| `idempotencyKey` | Caller-supplied. A repeated key returns the original `turnId` and starts nothing. |

Responses:

| Status | Meaning |
|---|---|
| `202` | Turn accepted. Body carries `turnId` and `sessionId`. |
| `400` | Schema violation or bounds exceeded. |
| `401` | Authentication failed. |
| `409` | Session is busy with a turn that cannot be interleaved. |
| `413` | Prompt or body exceeds the configured bound. |
| `422` | The prompt was rejected by the security scan. The body states that it was rejected and nothing about what matched. |
| `503` | The server is `draining`, or containment required by the profile is unavailable. |

An accepted turn is not a permitted turn. Policy classification happens inside
the run loop, and a turn may still terminate in a denial.

### `GET /v1/turns/{turnId}/events`

Server-sent events for a turn, conforming to
[stream-event.schema.json](schemas/stream-event.schema.json). Re-attachment is
supported: a caller that reconnects with a `Last-Event-ID` receives the events
it missed, replayed from the durable evidence record. Re-attachment never
re-executes anything.

Event kinds: `turn.started`, `assistant.delta`, `tool.started`,
`tool.finished`, `approval.pending`, `approval.resolved`, `turn.finished`.

Every event carries `turnId` and a monotonic `seq`. Tool events carry a bounded
structured summary, never raw stdout, raw arguments, or raw provider payloads.

### `GET /v1/turns/{turnId}`

Terminal turn result, conforming to
[turn-result.schema.json](schemas/turn-result.schema.json). Available after the
turn reaches a terminal state, and durable across restart.

### `GET /v1/approvals`

Pending approvals the token may see, conforming to
[pending-approval.schema.json](schemas/pending-approval.schema.json). Each entry
carries its opaque id, bounded action summary, scope, consequence, expiry, and
correlation id — and no arguments that would let a caller reconstruct the
command.

### `POST /v1/approvals/{approvalId}`

Answer exactly one pending approval. Body is `{"decision": "allow" | "deny"}`.

| Condition | Result |
|---|---|
| First valid answer | Applied once. |
| Replayed answer | `200` with the original outcome. Nothing re-executes. |
| Expired | `410`. Already resolved as deny. |
| Answered by the turn that raised it | `403`. |
| Unknown id | `404`, indistinguishable from an id the token may not see. |

An answer cannot broaden scope, alter arguments, or override a policy `deny`.

### `POST /v1/turns/{turnId}/cancel`

Request cancellation of a turn the token owns. Cancellation is a request to the
harness, not a kill; the turn reaches a terminal state and records that it was
cancelled. It never edits Task Manager records.

### `GET /v1/projects`

The user-global project registry, per
[project-registration.schema.json](schemas/project-registration.schema.json).
Addressing only, and no credential material. Entries marked `missing` are
returned rather than hidden, so a transport can show the operator what it can no
longer reach.

### `GET /v1/commands`

The maintenance surface, projected from `src/standard/command-registry.ts`. Each
entry carries its identifier, its argument shape, whether it is read-only, and
whether it costs a model call.

This route exists so a transport can build its command menu from the registry
instead of hard-coding one. A command added to the registry appears here without
any change to this entry or to the transport.

### `POST /v1/maintenance`

Run one registry operation, per
[maintenance-request.schema.json](schemas/maintenance-request.schema.json).

This is not `POST /v1/turns` with a different body. No prompt is constructed and
no model is invoked unless the registry declares the operation model-backed.

| Status | Meaning |
|---|---|
| `202` | Accepted. Body carries the invocation id. |
| `400` | Schema violation, or arguments that do not match the registry entry's declared shape. |
| `403` | The operation exists but the remote profile denies it. |
| `404` | No such registry entry. There is no passthrough for unknown operations. |
| `409` | An equivalent invocation is already running for this project. |

Classification follows the registry: read-only operations may run under `allow`;
operations that write to the project are `ask`; model-backed operations state
their cost in the approval so the operator sees what they are approving.

Progress and results use the same event and result contracts as turns, so a
transport renders both the same way.

### `POST /v1/credential-links`

Request a credential handoff. **No route on this surface accepts a secret**;
this one asks for a place to enter one.

The response is a [credential-link.schema.json](schemas/credential-link.schema.json)
record: an opaque identifier, a stated purpose, an expiry, and a loopback URL to
open. It carries no credential material.

| Rule | Behaviour |
|---|---|
| Single use | Consumed atomically on first successful entry; a second use returns `410`. |
| Expiry | An unused link expires with no effect and returns `410` thereafter. |
| Binding | Resolves to loopback. Reaching it from elsewhere requires the non-loopback bind, with its existing flag and acknowledgement. |
| Destination | The entered secret is written directly to the user-global credential store and appears in no response, event, evidence record, or log. |
| Revocation | Token rotation or revocation invalidates outstanding links. |

Provider and model *selection* carry no secret and are ordinary maintenance
operations.

### `GET /v1/flows`, `GET /v1/flows/{id}`

Read-only Task Manager projection. No route on this surface writes `flow.json`.

## Error contract

Errors are `{"error": {"code": "<stable-slug>", "message": "<safe text>"}}`.
Messages are safe by construction: no absolute paths, no secrets, no PII, no
stack traces, no provider error bodies. Codes are stable so transports can route
on them without parsing prose.

## Bounds

| Bound | Applies to |
|---|---|
| Body size | Every request, enforced before parsing semantics. |
| Prompt length | `POST /v1/turns`. |
| Concurrent turns | Per session and per install. |
| Pending approvals | Per session; the limit is a refusal to accept new turns, never a silent drop of an approval. |
| Event backlog | Retained for re-attachment for a configured window, then the stream is closed with a terminal event rather than truncated silently. |

## Versioning

The surface is versioned in the path (`/v1`). A breaking change to any schema
requires a new path version; transports pin the version they speak.
