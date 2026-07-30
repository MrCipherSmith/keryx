# Metrics and Validation: Telegram Transport
Version: 2.1.0

## Status

Metrics in this document are release validation targets for a future transport.
They are not performance claims and do not report execution statistics for this
documentation run.

## Product and safety metrics

| Metric | Target / evidence |
|---|---|
| Pairing completion | A fake-adapter scenario completes token validation, one-time deep-link pairing, chat binding, and test notification. |
| Authorization containment | 100% of unbound/unauthorized-chat fixtures produce no intent or privileged side effect. |
| Replay containment | 100% of duplicate `update_id`, callback nonce, and pairing nonce fixtures produce no duplicate action. |
| Approval integrity | 100% of expired/replayed callbacks and policy-`deny` fixtures cannot confirm an action. |
| Secret redaction | 100% of token/PII/path/sensitive-output fixtures are absent from rendered notifications and persisted fixture evidence. |
| Reliability visibility | Every simulated timeout, polling failure, send failure, cancellation, and webhook conflict produces a correlated terminal or retrying status locally. |
| Submission containment (2.0.0) | 100% of free-text fixtures in an **unbound** chat produce no `task.submit` and no turn. |
| Declared project (2.0.0) | 100% of `task.submit` fixtures declare the bound project path; none derive it from message content. |
| Prompt is not a tool call (2.0.0) | 100% of prompts naming a shell command are classified by the policy engine identically to the equivalent TUI turn; none execute on the strength of the message. |
| Delegated semantics (2.0.0) | The transport defines no allowlist, no auto-approve rule, no approval timeout, and no session-addressing rule of its own; a static check asserts this against [keryx-remote-entry](../keryx-remote-entry/README.md). |
| Cross-project delivery (2.1.0) | **Zero tolerance.** ≥4 concurrent sessions across ≥2 projects with interleaved arrival; no message reaches a session other than the one its binding names. |
| Unmapped-topic refusal (2.1.0) | 100% of updates in topics mapped to no project are refused; none fall back to a private-chat binding or an active session. |
| Membership containment (2.1.0) | 100% of updates from unauthorized members of an authorized supergroup produce no privileged effect and no acknowledgement. |
| Binding validation safety (2.1.0) | **Zero tolerance.** No inconclusive validation result ever clears a binding; deleted-topic fixtures clear exactly the affected binding. |
| Queue behaviour (2.1.0) | Two updates for one binding run in order; updates for different bindings run concurrently; every queued update reports its position at queueing time; every over-bound update is explicitly refused, none silently dropped. |
| Voice default-off (2.1.0) | **Zero tolerance.** A fresh configuration, and a configuration carrying a credential but no opt-in, both contact zero voice services. |
| Voice egress containment (2.1.0) | **Zero tolerance.** Every remote voice call passes the egress policy; a denial produces zero bytes of audio leaving the process in either direction. |
| Voice loss (2.1.0) | 100% of transcription failures degrade to file delivery; zero messages discarded. |
| Voice idempotency (2.1.0) | Duplicate audio delivery produces exactly one transcription and one turn. |
| Speech redaction (2.1.0) | **Zero tolerance.** No secret, path, or PII fixture is audible in synthesized output; synthesis input is always post-redaction text. |
| Speech qualification (2.1.0) | Short, mostly-code and diff fixtures produce no speech; markdown bullet fixtures are not classified as diffs; no clip exceeds the duration cap; no split falls mid-word. |

## Required validation layers

1. **JSON Schema contracts:** validate every example/fixture against Draft
   2020-12; reject raw token fields in transport config fixtures.
2. **Offline fake adapter:** inject updates, callbacks, failures, duplicate and
   reordered `update_id` values, webhook state, and restart checkpoints without
   network access. It must additionally simulate forum topics — including
   unmapped topics, deleted topics, and validation that fails transiently —
   unauthorized supergroup members, interleaved arrival across ≥2 projects, and
   both voice directions with a fake local engine and a fake remote service that
   can be denied by policy. No real audio service is contacted.
3. **Security tests:** cover injection scanning, binding/allowlist, redaction,
   `deny` containment, and no-secret/no-absolute-path output.
4. **Lifecycle scenarios:** cover the acceptance criteria in
   [specification.md](specification.md) with fake Harness, policy, evidence, and
   Task Manager projection ports.
5. **Operational checks:** assert bounded retry/backoff, timeouts,
   cancellation, rate limits, retention cleanup, and correlation IDs.

## Evidence required before implementation readiness

- A contract matrix mapping each schema to producer, consumer, and negative
  fixture.
- Fake-adapter transcript for each acceptance criterion.
- Security scan report showing sanitized fixture/output artifacts.
- Idempotency/restart report for update, pairing, approval, and notification
  delivery receipts.
- Explicit local-polling/webhook-conflict test result.
- Desktop/UI usability evidence for pairing, revoke, and degraded recovery.

## Explicit gaps to resolve before implementation

- Harness port names and stable typed-intent/evidence shapes are future work.
- OS credential-store abstraction and supported operating systems are undecided.
- Numeric retry, rate-limit, timeout, message-size, and retention values require
  implementation-era threat modeling and operational measurement.
- Server/headless webhook deployment has separate infrastructure and security
  requirements and is not validated by Release 0 local polling scenarios.
- The Bot API cannot enumerate a forum's topics. Synchronization can create
  missing topics but cannot discover topics belonging to no project, so orphan
  detection is limited to bindings the transport already knows about. This is a
  platform limitation, not a gap to close by implementation effort.
- Concrete voice engines, their licences, model sizes, and offline availability
  per operating system are undecided. The specification commits only to
  local-first ordering and an explicit remote opt-in, not to any particular
  engine.
- Speaking-rate estimation used to size clips is a heuristic and must be
  calibratable without a code change; no accuracy claim is made for it.
