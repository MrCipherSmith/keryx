# Implementation Plan

Status: ready to execute

## Approach

Create one standalone `web_fetch` interactive tool and register it alongside
the existing built-ins. It receives injectable `fetch` and DNS lookup
dependencies, making its safety and HTTP behavior deterministic in tests.

Only an HTTPS URL is accepted. It follows a small explicit redirect budget; each
destination must have no credentials and resolve only to public
addresses. The response is capped, decoded as text, made readable where
possible, and prefixed as untrusted external content. It never forwards
environment data, API keys, cookies, or caller-defined headers.

## Steps

1. Write RED tests for a public response, URL validation, private/DNS-denied
   targets, redirects, timeout, response cap, and registration.
2. Implement the isolated `web_fetch` tool with injectable I/O.
3. Register it in agent mode and document its purpose in the system prompt.
4. Run focused tests, changed scope, typecheck, and security-focused review.

## Risks

- DNS rebinding is reduced by resolving before every hop and disabling automatic
  redirects; a future hardened transport can pin validated addresses.
- Pages can contain hostile instructions. Fetched text is marked as untrusted.
