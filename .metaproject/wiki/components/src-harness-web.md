---
Title: Module src/harness/web
Version: 1.0.1
Type: component
Status: accepted
VerifiedScope: sha256:588ec7ad092a83b6781d86fe1abfd60c1b7f39ad48c3257d4c38726ade7dbd7a
Summary: "`src/harness/web` is the harness's remote-web boundary. Web access goes through `SandboxedWebTransport`, which validates public HTTPS targets and every redirect hop, runs each network request in a sandboxed worker behind an injected `WebWorkerRunner`, and returns only sanitized, size-limited text or a typed failure."
---

# Module src/harness/web

## Summary

`src/harness/web` is the harness's remote-web boundary. Web access goes through `SandboxedWebTransport`, which validates public HTTPS targets and every redirect hop, runs each network request in a sandboxed worker behind an injected `WebWorkerRunner`, and returns only sanitized, size-limited text or a typed failure.

## Overview

`src/harness/web` owns the harness's remote-web boundary: the one path through which harness code fetches public web pages or calls web-backed search providers. Its job is containment. Callers get back sanitized, size-limited text or a typed failure, never raw transport internals or a network client they could use directly.

## How it works

The module has three layers and a policy layer that every network hop passes through.

**Contracts.** `WebPageRequest`, `SandboxedWebTransportOptions`, `WebWorkerRequest`, `WebWorkerResponse` and `WebWorkerRunner` in `sandboxed-web-transport.ts` define the shapes. The runner is a constructor-injected port, so `SandboxedWebTransport` reaches the network only through it.

**Transport.** `SandboxedWebTransport` has two entry points. `fetchPage` serves page reads and returns `SanitizedWebContent`. `request` is the bridge for search providers: it takes the search module's `SandboxedWebRequest` and maps its `capability` onto flags for the same internal `fetchRaw` loop. `fetchRaw` validates each hop before dispatching it. `parsePublicHttpsUrl` in `web-policy.ts` requires an absolute HTTPS URL without credentials and rejects private or loopback IP literals. `validatePublicTarget` resolves every DNS answer, denies the whole set if any answer is non-public, and pins one address (preferring IPv4) for the worker to connect to. Redirects are followed by hand, each re-validated, and capped at `WEB_MAX_REDIRECTS` (3). The caller's credential is forwarded only while the origin matches the original request.

Local search is a separate branch. The `local-search` capability admits only plain `http:` to `localhost`, `127.0.0.1` or `::1`, and refuses redirects.

**Worker.** `SystemWebWorkerRunner` in `web-worker-runner.ts` runs one request per child process. It wraps a `bun --eval` script with `wrapWithSandbox` under a read-only profile with network on, the workspace and home directory read-denied, and an empty environment. It refuses to run when the platform launcher is missing (`sandbox-exec` on darwin, `bwrap` on linux). The request goes in on stdin and the child's JSON result comes back on stdout, with a 10-second timeout and a 192,000-byte output cap. The child installs a custom `lookup` that returns only the pinned address, so it does no DNS of its own. For search, the child can send a browser-like header set; `BROWSER_*` constants are emitted into the worker source as text, so the lists a test checks and the lists the worker sends stay the same.

**Content.** `sanitizeWebContent` in `web-content.ts` is the only route from a worker body to agent-visible text. For `text/html` it strips `script` and `style` blocks and then all tags. It rejects text that `detectInjection` flags or that matches an imperative tool-instruction pattern, redacts with `redactSensitiveText`, and wraps the result in an "UNTRUSTED EXTERNAL CONTENT" header that names the source, provider and retrieval time.

## Key concepts

**Public target.** A `PinnedPublicTarget` (URL, hostname and one validated address) is the only form in which a destination reaches the worker. It is checked once per hop, before dispatch.

**Sandboxed transport.** `SandboxedWebTransport` is the module's entry point. It holds no network client. It holds a lookup function, a `WebWorkerRunner` and a clock.

**Worker runner contract.** `WebWorkerRunner.run` takes a `WebWorkerRequest` and an optional abort signal and returns a `WebPolicyResult<WebWorkerResponse>`. `SystemWebWorkerRunner` is the production implementation, and `createSystemWebWorkerRunner` builds one for the current working directory and home directory.

**Policy result.** `WebPolicyResult<T>` is a union of `{ ok: true, value }` and `{ ok: false, reason }`. Policy and transport failures are returned as values rather than thrown. The search bridge maps them to `policy-denied`, `transport-failed` or `cancelled`.

**Limits.** `WEB_MAX_REDIRECTS` (3) and `WEB_MAX_TEXT_BYTES` (128,000) are exported from `sandboxed-web-transport.ts`. The byte cap is applied to the decoded body in `fetchRaw`. The worker applies its own `maxBytes` of 128,000, written as a literal in `web-worker-runner.ts` and not imported from the constant, so the two values appear to have to be kept in step by hand.

## Main flows

### Flow: page fetch through `fetchPage`

1. The caller builds a `WebPageRequest` with a URL and a provider ID.
2. `fetchRaw` parses the URL with `parsePublicHttpsUrl` and runs `validatePublicTarget` against the injected lookup.
3. `SandboxedWebTransport` calls `WebWorkerRunner.run`. The worker returns a status, content type, body and optional `location`.
4. On a 3xx response the loop re-validates the `location` and continues, failing with "too many redirects" past the cap. On a final response the content type must be readable text and the body within `WEB_MAX_TEXT_BYTES`.
5. `fetchPage` requires a 2xx status and passes the body to `sanitizeWebContent`, which returns the untrusted-content envelope or a prompt-injection rejection.

### Flow: search provider request through `request`

1. A search provider adapter in `src/harness/search` (which imports `SandboxedWebRequest` from its types) passes a request. Its `capability` selects `localOnly` (`local-search`) or `browserHeaders` (`public-search`).
2. `request` runs the same `fetchRaw` loop. It does not sanitize: the adapter receives the raw status, final URL, content type and text.
3. Any failure becomes a response with status 0 and an error code (`cancelled`, `policy-denied` or `transport-failed`), so the adapter does not have to handle exceptions.

### Flow: system worker execution

1. `SystemWebWorkerRunner.run` checks for the platform launcher. If it is absent, the call returns "web sandbox launcher is unavailable".
2. It wraps the `bun --eval` child with `wrapWithSandbox`, spawns it with an empty environment and piped stdin and stdout, and writes the request JSON.
3. An abort signal or the 10-second timer kills the process. Output over 192,000 bytes kills it too and returns an "oversized output" failure.
4. A non-zero exit or unparseable stdout becomes a failure result. Otherwise the parsed `WebPolicyResult` is returned.

## Changelog

- 1.0.1 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.

---

<!-- keryx:reference:begin v=1 hash=640a7c0706c1692f7470ce8d12d60174cf4d71eb1953fced2d9db2a68adcaa0e -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `WEB_MAX_REDIRECTS`
- `WEB_MAX_TEXT_BYTES`
- `WebWorkerRequest`
- `WebWorkerResponse`
- `WebWorkerRunner`
- `WebPageRequest`
- `SandboxedWebTransportOptions`
- `SandboxedWebTransport`
- `BROWSER_USER_AGENTS`
- `BROWSER_ACCEPT_LANGUAGES`
- `BROWSER_ACCEPT`
- `BROWSER_STATIC_HEADERS`
- `BROWSER_HEADERS_SOURCE`
- `SystemWebWorkerRunner`
- `createSystemWebWorkerRunner`

### Key files

- `src/harness/web/sandboxed-web-transport.ts` - imported by 5, imports 3
- `src/harness/web/web-worker-runner.ts` - imported by 3, imports 4
- `src/harness/web/web-content.ts` - imported by 3, imports 3
- `src/harness/web/outbound-secret.ts` - imported by 4, imports 1
- `src/harness/web/web-policy.ts` - imported by 5, imports 0
- `src/harness/web/outbound-secret.ordinary-fixture.test.ts` - imported by 0, imports 2

### Depends on

- `src/security` - 2 import(s)
- `src/harness/process/sandbox` - 2 import(s)
- `src/harness/search` - 1 import(s)
- `src/security/detect` - 1 import(s)

### Depended on by

- `src/harness/tool/builtin` - 6 import(s)
- `src/harness/search` - 2 import(s)

### Dependency basis

- Production imports only: 3 import(s) from test file(s) (e.g. `src/harness/tool/builtin/web-fetch-tool.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 11
- Cross-module imports: 6
<!-- keryx:reference:end -->

## Related

- [Wiki Index](../index.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/search](src-harness-search.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security](src-security.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
