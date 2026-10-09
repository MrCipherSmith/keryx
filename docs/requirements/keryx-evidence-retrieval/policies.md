# Evidence Retrieval Policies
Version: 0.1.1

## Trust
Historical excerpts are untrusted data, never system policy or approval. Preserve
role/time when known, null otherwise. Score does not indicate truth or confidence.
Contradictory evidence may coexist with provenance. No automatic knowledge/Seed/SAC
promotion. Instructions quoted from evidence cannot authorize tools or credentials.

## Scope and privacy
Canonical project/worktree scope is runtime-owned. Deny traversal, symlink escape,
absolute config roots, credentials, .env*, private keys/tokens, .git and dependencies.
Other data stores require a dedicated safe adapter. Deny overrides allowlist.
Checkout containment applies to file roots. Session adapter is confined to
configured session storage and verifies canonical project/worktree ownership;
outside-checkout storage never authorizes unrelated archives. Opaque provider
replay excluded; exception does not broaden file-root permissions.
Existing scanner/redactor runs before indexing/embedding and again at return;
unknown/unavailable scanner fails closed. Never transmit original text before redaction.
Remote embedding requires explicit corpus/provider capability consent and approved
network path; project config/model selection cannot authorize it. Missing consent
may fall back to local lexical only if local policy allows.
No query/text/vector/full-path telemetry. Locators/hashes are sensitive metadata;
logs carry scoped opaque IDs, counts and reason codes. Artifacts owner-only.

## Resources and approvals
Index and clear mutate state and require existing approval gates. Search must not
write/reindex opportunistically. One optional auto recall per user turn. Finite
byte/token/time/source/chunk ceilings; writer rejects oversize generation before
publication. Search timeout/budget refusal returns named outcome, not partial success.
Disable cancels automatic work; clear removes only derived artifacts.

## Honesty
Index missing is not no-match. Unreadable/deleted is not proof of no history.
Changed sources need fresh locators. Do not print secret fragments in diagnostics.
Fixture security gates are not claims of immunity to every attack; usefulness
requires paired measurements. Current source owners remain authoritative.
