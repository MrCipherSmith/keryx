# Specification: Keryx Remote Entry
Version: 1.1.0

## Identity and status

`keryx-remote-entry` specifies a future `keryx serve` command: a loopback-bound
HTTP adapter over the implemented Project Agent Harness. It owns no domain
state, no policy decision, and no Task Manager state. This specification
introduces no runtime module, listener, or dependency; it constrains one.

## Architecture and ownership

| Concern | Owner | Remote Entry responsibility |
|---|---|---|
| Run loop, tool dispatch, provider calls | `src/harness/run` | Invoke it unchanged; never fork a second loop. |
| Session persistence and resume | `src/harness/session` | Address sessions by id; never open a parallel store. |
| allow / ask / deny classification, approval gating, mutation guard | `src/harness/policy`, `src/harness/mutation` | Submit the resolved profile and consume the decision; never reclassify. |
| Containment | OS sandbox | Require it for remote turns; refuse the turn when it cannot be applied. |
| Secret / PII / injection scanning and redaction | `src/security` | Scan every inbound prompt; redact every outbound payload. |
| Managed-flow lifecycle | `src/flow` (Task Manager) | Read a safe projection only; never write `flow.json`. |
| HTTP framing, authentication, session addressing, streaming, pending approvals | Remote Entry | Own only these. |

The adapter depends inward. No HTTP type, header, or framing concept may appear
in harness domain contracts.

## Process and state machine

```text
stopped -> configured -> listening -> stopped
                     \-> refused
listening -> draining -> stopped
```

- `stopped`: no listener, no bound port. This is the state after a fresh
  `keryx init`.
- `configured`: a config and a credential reference resolve, and the bind
  address is loopback or an explicitly acknowledged non-loopback address.
- `refused`: startup preconditions failed — unreadable credential, missing
  sandbox launcher when the profile requires containment, unresolvable policy
  profile, or a non-loopback bind without acknowledgement. The listener does not
  open. This is a terminal startup outcome, never a degraded listen.
- `listening`: accepting authenticated requests.
- `draining`: no new turns accepted; in-flight turns run to a terminal outcome
  and pending approvals resolve or expire.

## Turn lifecycle

```text
HTTP request
  -> size and content-type bound
  -> bearer authentication (constant-time compare)
  -> origin stamped by the server
  -> session resolve or create (identity-first)
  -> security scan of the prompt (untrusted content)
  -> remote policy profile resolution
  -> harness run loop
       |-> policy allow  -> execute
       |-> policy ask    -> pending approval -> answered | expired(deny)
       |-> policy deny   -> terminal denial
  -> evidence written with origin
  -> redaction
  -> stream events and terminal turn result
```

A policy `deny` is final. No transport may present it as approvable, and no
approval may convert it.

## Session addressing

Sessions are addressed by an opaque `sessionId`. Binding is **identity-first**:
a caller declares the project it means, and the server resolves the session
whose project path matches exactly. It never infers a session from recency,
arrival order, or the fact that only one is currently idle.

When no session matches and the request permits creation, a new session is
created for the declared project. When the declared project is unknown to this
install, the request fails; the server does not fall back to "the obvious one".

This rule is not theoretical caution. `helyx` shipped a timing-based pairing
first and had to replace it after transports cross-linked between projects under
concurrent sessions; see [brainstorm.md](brainstorm.md).

## Project registry

Today `keryx init` writes a `.metaproject/` into the project it is run in, and
nothing on the machine knows the set of projects that exist. A transport that
routes to several projects needs that set, so Remote Entry introduces a
**user-global project registry**.

| Property | Rule |
|---|---|
| Location | The existing user-global config directory — the one already holding `auth.json` (0600), `permissions.json`, `sandbox.json` and `sessions/`, resolved cross-platform. |
| Content | Addressing only, per [project-registration.schema.json](schemas/project-registration.schema.json): opaque project id, absolute path, display name, registration state, timestamps. |
| Secrets | None. The schema forbids credential material; credentials stay in the credential store. |
| Not a second source of truth | Project configuration, policy and content remain in each project's own `.metaproject/`. The registry answers "which projects exist and how are they addressed", nothing else. |
| Registration | `keryx init` registers the project. Registration is idempotent: re-running init updates the record rather than creating a second one. |
| Missing path | A registered path that no longer exists is marked `missing`, not deleted. A transport may present it and the operator decides; a registry entry is not silently dropped because a disk was unmounted. |
| Deregistration | Explicit. Removing a project from the registry is an operator action. |

The registry is the key set a transport binds to. It is also useful on its own:
it is the first time an install knows where it has been deployed.

## Maintenance operations

Rebuilding a graph, indexing a wiki, running health — these are deterministic
commands. Routing them through the model means paying a model to decide to run
something it was already told to run, and introduces a nondeterministic step
into an operation that had none.

Remote Entry therefore exposes a second, narrower execution path beside
`task.submit`.

### The registry is the surface

The set of invocable operations is **projected from
`src/standard/command-registry.ts`**, which already carries, per command, its
module, its intent phrases, its argument shape, whether it is read-only
(`read`), and whether it costs a model call (`model`). Remote Entry does not
maintain a parallel list, and a transport does not either.

Consequences that are requirements, not conveniences:

- A new operation becomes remotely available by being added to the command
  registry. No transport change, no entry change.
- An operation absent from the registry is not invocable. There is no
  passthrough, no free-form argument, and no way for an argument to turn one
  registry entry into a different command.
- Arguments are validated against the registry entry's declared shape before
  anything runs.

### Classification

Classification derives from the registry rather than being restated:

| Registry flag | Treatment |
|---|---|
| `read: true` | Reads project state only. Eligible for `allow` under the remote profile. |
| `read: false` | Writes to the project — artifacts, wiki pages, flow files. Classified `ask`. |
| `model: true` | Spends tokens. The approval must state that the operation is model-backed, so the operator sees what they are paying for before approving. |

The policy engine remains authoritative. A registry flag is an input to
classification, never a substitute for it, and a `read: true` operation is still
subject to the remote profile.

### Known gap

The curated registry does not currently contain every operation this surface
should expose — `gdgraph build`, for example, is a refresh command and is absent
from the sixteen curated entries. Extending the registry is therefore a
**dependency of this capability**, recorded here so it is planned rather than
discovered during implementation. The correct fix is to extend the registry, not
to special-case a command inside the transport.

## Credential handoff

No route accepts a secret. A caller that needs one set requests a handoff, and
the entry issues a one-time link per
[credential-link.schema.json](schemas/credential-link.schema.json).

| Property | Rule |
|---|---|
| Contents | An opaque single-use identifier and an expiry. No credential material, no provider secret, no path. |
| Binding | The link resolves to a loopback address. Reaching it from elsewhere requires the non-loopback bind, which already demands an explicit flag and acknowledgement. |
| Single use | Consumed atomically on first successful entry. A second use fails and reports expiry. |
| Expiry | Short and explicit. An unused link expires without effect. |
| Destination | The entered secret is written directly to the user-global credential store at mode 0600. It never enters a session, an evidence record, a stream event, a log, or a response body. |
| Revocation | Outstanding links are invalidated on token rotation or revocation. |

Provider and model *selection* carry no secret and are ordinary operations.

## Asynchronous approvals

In the TUI, an `ask` is synchronous: the human is present, and the run loop
blocks on a keypress. Over HTTP the request will usually finish long before a
human answers, so `ask` becomes a durable record.

| Property | Rule |
|---|---|
| Creation | An `ask` raised during a remote turn creates a pending approval with an opaque id, a bounded action summary, its scope, its consequence, an expiry, and a correlation id. |
| Delivery | The transport renders the approval. A delivery failure resolves the approval as **deny immediately**; it does not wait for expiry. |
| Answer | Exactly one answer is accepted, exactly once. A replayed answer returns the original outcome and executes nothing. |
| Expiry | An unanswered approval resolves to **deny** at expiry, and the denial is recorded in evidence. |
| Scope | An answer confirms exactly the pending action. It cannot broaden scope, alter arguments, override a `deny`, revive an expired record, or apply to a different action. |
| Self-grant | A turn cannot answer an approval that its own execution raised. |
| Persistence | Pending approvals survive process restart; a confirmed action is never re-executed on replay. |

Auto-approval is resolved **only** from the existing policy source. Remote Entry
defines no allowlist of its own, and the transport defines none.

## Remote policy profile

Remote turns run under a named profile resolved through the existing policy
resolution order. Two invariants bind it:

1. **Non-weakening.** The remote profile may never grant anything the local
   profile denies. Resolution that would widen is a startup `refused`, not a
   warning.
2. **Stricter by default.** Absent explicit configuration, a remote turn
   requires OS sandbox containment, sets network to off or restricted, and
   classifies every mutation as `ask`.

Origin is stamped by the server from the authenticated connection. It is never
read from request content, and content that claims an origin is treated as
untrusted text.

## Streaming

Turn progress is exposed as a sequence of provider-neutral events conforming to
[stream-event.schema.json](schemas/stream-event.schema.json). Events are rendered
from structured summary fields; raw provider payloads and raw tool output are
never forwarded. A client may detach and re-attach to a running turn by
`turnId`; re-attachment replays from the durable evidence record and produces no
duplicate side effect.

Transports are responsible for their own rate limits. The core emits events at
the rate the turn produces them and never assumes an unmetered channel.

## Configuration and credentials

[remote-entry-config.schema.json](schemas/remote-entry-config.schema.json) holds
mode, bind address, profile name, timeouts, and a credential reference. The
bearer token itself is stored only in the user-global credential store
(`auth.json`, mode 0600) or an OS credential store, and is referenced by opaque
id.

A raw token is forbidden in configuration, repository files, `.metaproject`
artifacts, prompts, trace output, telemetry, fixtures, schemas, and any
notification text.

## CLI surface

```text
keryx serve [--bind <addr>] [--profile <name>] [--no-tui-conflict-check]
keryx serve status
keryx serve token issue | revoke | rotate
keryx projects list | register <path> | forget <id>
```

`keryx init` registers the project it initializes; `keryx projects` inspects and
maintains that registry. Registration is idempotent and holds no secrets.

`keryx serve` with no configuration prints what is missing and exits without
binding a port. `keryx serve status` reports state, bind address, profile,
whether the bind is non-loopback, and the count of pending approvals — never the
token.

## Data contracts

All JSON contracts use Draft 2020-12 and are versioned:

- [Remote entry configuration](schemas/remote-entry-config.schema.json)
- [Turn request](schemas/turn-request.schema.json)
- [Turn result](schemas/turn-result.schema.json)
- [Stream event](schemas/stream-event.schema.json)
- [Pending approval](schemas/pending-approval.schema.json)
- [Project registration](schemas/project-registration.schema.json)
- [Maintenance request](schemas/maintenance-request.schema.json)
- [Credential link](schemas/credential-link.schema.json)

The HTTP surface that carries them is defined in
[api-protocol.md](api-protocol.md).

## Testability

An offline fake transport is required. It must drive the full lifecycle with no
network and no real token: authenticated and unauthenticated requests, session
create and resume, a turn that raises an `ask`, an approval answered, an
approval replayed, an approval expired, an undeliverable approval, a mid-turn
restart, a detach and re-attach, and secret-bearing tool output.

## Acceptance criteria

| ID | Given / when / then |
|---|---|
| AC-01 Off by default | Given a fresh `keryx init`, when nothing is configured, then no port is bound, no token exists, and `keryx serve status` reports `stopped`. |
| AC-02 Authentication | Given the listener is running, when a request presents a missing, malformed, or wrong token, then no session is created, no turn runs, and the response reveals nothing about existing sessions. |
| AC-03 Parity | Given the same prompt, when it is submitted over HTTP and typed into the TUI, then policy decisions and evidence shape are identical except for the recorded origin. |
| AC-04 Non-weakening profile | Given a remote profile that would grant something the local profile denies, when the server starts, then it enters `refused` and binds no port. |
| AC-05 Unforgeable origin | Given a request whose body claims `origin: local-tty`, when the turn is recorded, then evidence shows the remote origin assigned by the server. |
| AC-06 Approval expiry | Given a pending approval that is never answered, when its expiry passes, then it resolves to deny, the action does not execute, and the denial appears in evidence. |
| AC-07 Undeliverable approval | Given the transport cannot deliver an approval, when delivery fails, then the approval resolves to deny immediately rather than waiting for expiry. |
| AC-08 One-time approval | Given an answered approval, when the same answer is replayed, then the original outcome is returned and nothing re-executes. |
| AC-09 No self-grant | Given a turn that raised an `ask`, when that turn attempts to answer it, then the answer is rejected. |
| AC-10 Restart safety | Given a confirmed action and a process restart, when the pending record is replayed, then the action does not run twice. |
| AC-11 Identity-first binding | Given two concurrent sessions for different projects, when a caller declares one project path, then it resolves to that session and never to the other, regardless of arrival order or idleness. |
| AC-12 Containment required | Given a remote profile requiring the sandbox and a host where the launcher is unavailable, when a turn is submitted, then the turn is refused rather than run uncontained. |
| AC-13 Redaction | Given tool output containing token-like strings, absolute paths, or PII fixtures, when stream events and the turn result are produced, then no raw value appears in either, nor in transport notifications. |
| AC-14 Task Manager read-only | Given any route on the surface, when it is exercised, then `flow.json` is never written. |
| AC-15 Single writer | Given a remote turn and a concurrent TUI turn on the same session, when both run, then the append-only session store remains the single writer and no parallel store is created. |
| AC-16 Non-loopback is explicit | Given a non-loopback bind address without the explicit acknowledgement, when the server starts, then it enters `refused`; when acknowledged, the non-loopback bind is reported in `keryx serve status`. |
| AC-17 Registration on init | Given `keryx init` in a new project, when it completes, then the project appears once in the user-global registry; and when init is re-run, then the existing record is updated rather than duplicated. |
| AC-18 Registry holds no secrets | Given any registry state, when it is serialized, then it validates against the registration schema and contains no credential material. |
| AC-19 Missing project is marked, not dropped | Given a registered project whose path no longer exists, when the registry is read, then the entry is present and marked `missing`, and no entry is deleted without an explicit operator action. |
| AC-20 Registry-bounded maintenance | Given an operation absent from the command registry, when it is requested, then it is refused; and given a registry entry with crafted arguments intended to reach a different command, then argument validation refuses it. |
| AC-21 Maintenance runs no model | Given a registry entry with `model: false`, when it runs, then no provider call is made and no prompt is constructed. |
| AC-22 Maintenance classification | Given `read: true`, when the remote profile permits, then it may run under `allow`; given `read: false`, then it is classified `ask`; given `model: true`, then the approval states that the operation is model-backed. |
| AC-23 Registry is the single list | Given a new command added to the command registry, when the surface is enumerated, then the command appears without any change to Remote Entry or to a transport. |
| AC-24 No secret over the wire | Given any route on the surface, when a request carries credential-like material, then it is not accepted as a credential and no route writes it to the credential store. |
| AC-25 Handoff link carries nothing | Given an issued credential link, when it is inspected, then it contains only an opaque identifier and an expiry — no credential material, no provider secret, no filesystem path. |
| AC-26 Handoff is one-time and expiring | Given a consumed link, when it is used again, then it fails and reports expiry; and given an unused link past its expiry, then it cannot be used and no credential is set. |
| AC-27 Handoff destination | Given a secret entered through a valid link, when it is stored, then it is written to the user-global credential store at mode 0600 and appears in no session, evidence record, stream event, log, or response body. |
| AC-28 Handoff revocation | Given token rotation or revocation, when it completes, then outstanding credential links are invalidated. |
| AC-29 Selection is not a secret | Given a provider or model selection request, when it runs, then it succeeds remotely without any handoff, because it carries no secret. |
