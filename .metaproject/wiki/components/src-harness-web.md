---
Title: Module src/harness/web
Version: 1.0.0
Type: component
Status: accepted
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

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.

---

## Reference

### Public API

- `WEB_MAX_REDIRECTS`
- `WEB_MAX_TEXT_BYTES`
- `WebPageRequest` (interface)
- `SandboxedWebTransportOptions` (interface)
- `SandboxedWebTransport` (class)
- `WebWorkerRequest` (interface)
- `WebWorkerResponse` (interface)
- `WebWorkerRunner` (interface)
- `SystemWebWorkerRunner` (class)
- `createSystemWebWorkerRunner` (function)

### Key files

| File | Imports | Exports |
|------|---------|---------|
| `src/harness/web/sandboxed-web-transport.ts` | 3 | 5 |
| `src/harness/web/web-worker-runner.ts` | 4 | 3 |
| `src/harness/web/web-content.ts` | 3 | 3 |
| `src/harness/web/web-policy.ts` | 0 | 5 |
| `src/harness/web/sandboxed-web-transport.test.ts` | 1 | 0 |
| `src/harness/web/web-content.test.ts` | 1 | 0 |

### Dependencies

- [src/harness/process/sandbox](src-harness-process-sandbox.md) — process-level sandboxing
- [src/harness/search](src-harness-search.md) — search integration
- [src/security/detect](src-security-detect.md) — security detection
- [src/security](src-security.md) — security utilities

### Dependents

- [src/harness/tool/builtin](src-harness-tool-builtin.md) — 5 imports
- [src/harness/search](src-harness-search.md) — 2 imports

## Related

- [Wiki Index](../index.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/search](src-harness-search.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security](src-security.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
