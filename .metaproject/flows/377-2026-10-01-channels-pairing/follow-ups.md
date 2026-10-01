# Flow 377: deferred review findings

Review round `2026-10-01-ingest-823`. Findings F-001, F-101, F-103, F-104, F-105, F-106, F-108 and F-110 were fixed in PR #826 (0.3.51, merge 5ab21a26). The four below were deferred by the implementer; no operator decision is recorded for them.

- F-002 (minor, security, verifier: confirmed): the shell trusts whatever answers on the serve endpoint port. Suggested fix: a nonce/HMAC over the shell token. Local-only (loopback) exposure.
- F-102 (minor, correctness, verifier: unverifiable): `migrate_to_chat_id` is not handled when Topics is turned on for a paired group, so the stored chat id goes stale.
- F-107 (minor, correctness, verifier: confirmed): a pairing that reached `ready` is not resumed when the modal is closed and reopened.
- F-109 (minor, correctness, verifier: confirmed): `pair()` cancels the existing pairing before validating the new token.

Next step if picked up: one small flow covering all four.
