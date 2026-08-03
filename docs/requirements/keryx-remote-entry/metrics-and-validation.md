# Metrics and Validation: Keryx Remote Entry
Version: 1.1.0

## Status

Future validation plan. No measurement in this document has been taken, and no
performance or reliability claim is made by this package.

## Success metrics

| ID | Metric | Target | Source |
|---|---|---|---|
| M-01 | Parity: policy decisions identical between an HTTP turn and the same TUI turn | 100% of the parity corpus | Paired fixture runs, diffed on decisions and evidence shape |
| M-02 | Unauthenticated requests producing any agent side effect | 0 | Offline fake-transport suite |
| M-03 | Approvals resolved without an explicit human answer that resolved to anything other than deny | 0 | Pending-approval records |
| M-04 | Confirmed actions re-executed after a restart or replay | 0 | Restart and replay scenarios |
| M-05 | Redaction escapes: secret, path, or PII fixtures appearing in an event, result, error body, or notification | 0 | Secret-leak corpus |
| M-06 | Session mis-binding under concurrent projects | 0 | Concurrency scenario, ≥4 sessions across ≥2 projects |
| M-07 | Turns run without required containment | 0 | Sandbox-unavailable scenario |
| M-08 | Startup with a widening remote profile | 0 (must be `refused`) | Profile-resolution fixtures |
| M-09 | Invocations reaching a command outside the registry, or reaching a different command than the one named | 0 | Registry-bounding fixtures |
| M-10 | Provider calls made by operations the registry declares `model: false` | 0 | Maintenance fixtures |
| M-11 | Credential material accepted, stored, or echoed by any route on the surface | 0 | Credential fixtures |
| M-12 | Credential links usable twice, usable after expiry, or surviving token rotation | 0 | Link-lifecycle fixtures |
| M-13 | Secrets appearing in a registry serialization | 0 | Registry fixtures |
| M-14 | Registry entries deleted by anything other than an explicit operator action | 0 | Missing-path fixtures |
| M-15 | New command registry entries requiring a Remote Entry or transport change to appear | 0 | Registry-projection test |

M-02 through M-15 are zero-tolerance: any non-zero result is a release blocker,
not a trend to watch.

## Offline fake transport

A fake transport is required before any real listener is written. It must drive
the whole lifecycle with no network, no real token, and no bound port:

| Capability | Purpose |
|---|---|
| Inject authenticated and unauthenticated requests | AC-02, M-02 |
| Create and resume sessions across concurrent projects | AC-11, M-06 |
| Raise a policy `ask` mid-turn | AC-06 through AC-09 |
| Answer, replay, expire, and fail to deliver an approval | AC-06, AC-07, AC-08, M-03 |
| Attempt a self-grant | AC-09 |
| Forge an `origin` field in a request body | AC-05 |
| Simulate a mid-turn process restart | AC-10, M-04 |
| Detach and re-attach an event stream | Streaming re-attachment |
| Emit tool output seeded with secret, path, and PII fixtures | AC-13, M-05 |
| Report an unavailable sandbox launcher | AC-12, M-07 |
| Resolve a widening remote profile | AC-04, M-08 |
| Register, re-register, and lose the path of a project | AC-17, AC-18, AC-19, M-13, M-14 |
| Request an operation outside the registry, and craft arguments toward another command | AC-20, M-09 |
| Run a `model: false` operation and assert no provider call | AC-21, M-10 |
| Add a registry entry and assert it surfaces unchanged | AC-23, M-15 |
| Send credential-shaped material to every route | AC-24, M-11 |
| Issue, replay, expire, and rotate-through a credential link | AC-25, AC-26, AC-27, AC-28, M-12 |

## Test layers

| Layer | Scope |
|---|---|
| Contract | Every schema validates its fixtures; every documented error code is emitted by some path. |
| Scenario | Each acceptance criterion in [specification.md](specification.md) has at least one scenario test against fake harness, policy, security, and Task Manager projection ports. |
| Parity | A shared corpus of prompts is run through the TUI adapter and the HTTP adapter; decisions and evidence shape are diffed. |
| Security corpus | The fixtures listed in [security-policy.md](security-policy.md) §Security validation, run as a gate. |
| Concurrency | ≥4 concurrent sessions across ≥2 projects, asserting identity-first binding under interleaved arrival. |

## Release evidence

A release of this capability must publish:

- the parity diff for M-01, including the corpus size;
- the zero-tolerance results for M-02 through M-08, each naming the scenario
  that proved it;
- the security-corpus result;
- an explicit statement of what was **not** measured — in particular, no latency
  or throughput claim is authorized by this package;
- the health gate result at the merge commit.

## Explicit non-claims

- No latency, throughput, or concurrency-ceiling claim.
- No claim that the surface is safe on a non-loopback interface; Release 0
  provides no TLS and assumes loopback.
- No claim about behaviour under a hostile local user, who already has the
  operator's filesystem access.
- The curated command registry does not yet cover every maintenance operation
  this surface should expose — `gdgraph build`, for instance, is a refresh
  command outside the sixteen curated entries. Extending the registry is a
  **dependency** of this capability. No claim is made that today's registry is
  sufficient, and the fix is to extend the registry rather than special-case a
  command inside Remote Entry or a transport.
- The credential handoff protects the secret from the transport. It does not
  protect it from a compromised local machine, which already holds the
  credential store.
