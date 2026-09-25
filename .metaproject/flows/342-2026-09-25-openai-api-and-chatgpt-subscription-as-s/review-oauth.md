# OAuth independent review

Scope: working tree changes on `codex/openai-subscription`, base `0a5d23eb0`; OAuth device flow, token parsing/storage/refresh, auth catalog and auth CLI. Reviewed against flow342 AC1, AC2, AC4 and AC5 using local review-logic and review-security-code guidance.

## Stage 1 — specification

Separate authentication identities, legacy grant fallback, token rotation, canonical logout and safe credential errors are implemented. Device authorization displays browser URL/user code, supports cancellation and a bounded overall timeout. The cancellation lifecycle defect found in the first pass (F-001) is repaired and independently verified. Final scoped verdict: APPROVE.

## Findings

### F-001 — cancellation leaves the polling timer alive

- Severity: major; logic/lifecycle, not a security exploit.
- Location: `src/lib/oauth/openai-codex.ts:138` (`abortableSleep`) and its default timer at the start of `pollCodexDeviceToken`.
- Trigger: CLI Ctrl+C while device authorization is sleeping between pending polls.
- Outcome: authorization rejects promptly, but the referenced default `setTimeout` survives. The new CLI SIGINT handler suppresses normal process termination, so the CLI remains alive for the rest of the interval. Long server intervals can keep a cancelled command alive for minutes.
- Reproduction: separate Bun process, pending HTTP403 mock, `intervalMs: 2000`, abort after10ms. It printed `cancelled` immediately but exited after2.03s. No network or credentials involved.
- Existing cancellation test injects a never-resolving promise, so it proves promise rejection but cannot observe the default timer keeping the process alive.
- Suggested fix: clear the default timer when aborted; retain injected sleep seam and add subprocess lifecycle regression.
- Class scope: one affected default sleep implementation. Enumerated `pollCodexDeviceToken` and `abortableSleep` call sites; RFC8628 helper is unchanged and outside this finding.
- Status: CLOSED. OAuth implementer now clears the owned timer on abort; independent regression run on the corrected source exits in28.23ms.

## Checked without findings

- In-process refresh sharing and cross-process file lock; existing two-process test confirms one rotation.
- Re-read of credentials before persistence prevents a logout during refresh from resurrecting the grant.
- Changed-account refresh rejection and JWT metadata fallback; token authenticity remains server-validated.
- Expired tokens produce actionable login errors; missing refresh/account metadata fails safely.
- Legacy and canonical grant deletion preserves independent API-key credentials.
- No subscription token export to `OPENAI_API_KEY`; status metadata omits secrets.
- Fixed HTTPS issuer/verification URL; user-code control characters rejected.
- Refresh transport/remote errors do not echo tokens or response bodies.
- Request and overall device-login timeouts are present.

Validation:22 auth/status/lifecycle/device tests passed after correction; cancelled-default-wait subprocess regression passed in28.23ms. Initial process reproduction independently confirmed F-001 before repair. No live Pro-account test performed.

Routing: graph_used yes (cached graph used for initial bounded scope; predates new files), wiki_used yes, ctx_used yes, raw_rg_used no.
