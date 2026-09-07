# T15 Security Review — MCP HTTP loopback transport

## Scope and Stage 1 result

Branch: `codex/agent-first-core`; base commit: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`.

Reviewed the root-authored MCP HTTP transport files and requested context. Stage 1 passes for numeric IPv4/IPv6 parsing, wildcard/public rejection, hostname resolution timeout/error handling, one-address ambiguity checks, verified numeric bind, invalid-port refusal before SDK import/connect/listen, lazy SDK import, listener failure propagation, and generic request error responses. Existing SAC HTTP denials were not changed.

Targeted local tests: 19 pass, 0 fail across `src/mcp/transport/http-sse.loopback.test.ts` and `src/mcp/boundary.test.ts`. No external sockets or model calls.

## Finding

- **F-001 (major): DNS-rebinding same-origin bypass for configured hostnames.** `startHttpTransport` passes `[host, options.host, "localhost"]` to `isTrustedMcpHttpRequest` (`src/mcp/transport/http-sse.ts:65`). The guard accepts a request when Host equals any allowed host and Origin is the matching HTTP authority (`src/mcp/transport/http-sse.ts:32-37`). For an arbitrary configured DNS name that resolved once to the verified loopback address, an attacker-controlled DNS/origin can send matching Host and Origin headers with `sec-fetch-site: same-origin`; the predicate returns true and unauthenticated `transport.handleRequest` runs. The direct deterministic reproduction with a configured arbitrary host returned `{"accepted":true}`. This violates the policy's Host/Origin DNS-rebinding guard; loopback binding does not prove browser origin trust and the transport explicitly has no auth (`http-sse.ts:6`). Prefer allowing only the pinned numeric bind address plus reserved localhost, or revalidate the hostname to the pinned address on each request.

## Scoped assessment

No blocker found. Stage 1 is otherwise compliant with the HTTP spec and policies. The finding is limited to the request-origin allowlist for non-literal configured hostnames; invalid/wildcard/public binds remain refused before SDK connection/listening.

Routing audit: graph used for target discovery/affected context; wiki/spec pages read from T15 context; ctx used for all searches/reads/test logs; raw_rg_used: no.
