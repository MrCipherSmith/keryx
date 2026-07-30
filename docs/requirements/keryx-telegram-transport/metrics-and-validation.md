# Metrics and Validation: Telegram Transport
Version: 2.0.0

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

## Required validation layers

1. **JSON Schema contracts:** validate every example/fixture against Draft
   2020-12; reject raw token fields in transport config fixtures.
2. **Offline fake adapter:** inject updates, callbacks, failures, duplicate and
   reordered `update_id` values, webhook state, and restart checkpoints without
   network access.
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
