# Flow 377: deferred review findings

Review round `2026-10-01-ingest-823`. Findings F-001, F-101, F-103, F-104, F-105, F-106, F-108 and F-110 were fixed in PR #826 (0.3.51, merge 5ab21a26). The four below were deferred by the implementer; no operator decision is recorded for them.

- F-002 (minor, security, verifier: confirmed): the shell trusts whatever answers on the serve endpoint port. Suggested fix: a nonce/HMAC over the shell token. Local-only (loopback) exposure.
- F-102 (minor, correctness, verifier: unverifiable): `migrate_to_chat_id` is not handled when Topics is turned on for a paired group, so the stored chat id goes stale.
- F-107 (minor, correctness, verifier: confirmed): a pairing that reached `ready` is not resumed when the modal is closed and reopened.
- F-109 (minor, correctness, verifier: confirmed): `pair()` cancels the existing pairing before validating the new token.

Next step if picked up: one small flow covering all four.

Round `2026-10-01-ingest-pr830-head` (PR #830 head fd937144, 0.3.52): F-002, F-102, F-107 and F-109 were fixed in 0.3.52. Five new findings.

Closing round `2026-10-02-ingest-final-pr830` (evidence gathered on main 40ecaf07): F-110 (docs, 5ab21a26), F-201, F-202 and F-203 (PR #840, commit e4837ffe, merge 4ba4a568, 0.3.55) are fixed and verified `refuted`. F-204 and F-205 still reproduce (verifier: confirmed) and stay open below. They are recorded as `dismissed-deprioritised` with `decided-by: altsay` taken from the standing instruction in message 176698 ("Дальше делай все сам до релиза, закрывай все фло"). That is the supervisor's inference, not a per-finding decision by the operator; poll 34 on the flow 377 closure was unanswered when the flow was closed.

Fixed (kept for the record):

- F-202 (major): `ChannelsClient.startPairing` restored the token file on `no-answer` and `superseded` too. Fixed in 0.3.55.
- F-203 (minor): `pair()` bumped `generation` before the token validated. Fixed in 0.3.55.
- F-201 (minor): `ChannelsController.stop()` neither bumped `generation` nor ran under `exclusive`. Fixed in 0.3.55.

Open:


- F-204 (minor): the 503 draining, 404/405, 429 and 500 answers carry no identity proof, so the shell reports them as `unverified-serve` and sends the operator after a non-existent substitution.
- F-205 (minor): a `ready` pairing never expires and is not re-checked before Resume.
