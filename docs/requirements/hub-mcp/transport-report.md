# T2: Hub MCP transport and fixed tools

Status: implementation and scoped verification complete; coordinator owns final independent gate and Hub submission.

## Result

Added `src/hub/mcp.ts` and `src/hub/mcp-tools.ts`: authenticated-agent-only adapter interface, request-scoped stateless SDK Server/transport with JSON responses, bounded JSON body parsing, explicit POST-only transport and accepted notifications, a closed fifteen-tool catalogue, and same-application REST dispatch retaining the original incoming Bearer token. SDK imports are lazy and the existing global no-static-SDK-import boundary passes unchanged.

The outer Hub application remains responsible for authenticating the actual key, validating Origin and resolving current named-agent permissions; each tool call re-enters its ordinary REST boundary. The adapter additionally refuses human context and missing Bearer headers. Domain mutation/serialization/idempotency remains in the existing application. No approval, token administration, selection, delivery or generic HTTP tool is exposed. Mutations require caller operation IDs. Revision lists return summaries; exact revision reads include bytes. Errors expose fixed messages and safe error codes, never raw exception details. Known incoming authorization/Cloudflare secrets are redacted from JSON responses, including escaped key text.

## Tests and API truth

Verified against installed `@modelcontextprotocol/sdk@1.30.0` package metadata and its shipped `Server`, `WebStandardStreamableHTTPServerTransport`, `Client` and `StreamableHTTPClientTransport` declarations; real HTTP SDK round trips exercise the same calls. Unverified dependency calls: none. Installed SDK differs from the previous root optional range; packaging ownership addresses pinning rather than silently installing into the shared dependency tree.

Eight transport/API tests plus three existing MCP import-boundary tests pass: eleven tests, 76 assertions. Tests cover initialization/discovery/read/context/history, full ready->start->revision->Evidence->submit lifecycle, exact-subject provenance, operation replay/conflict, forbidden/invalid arguments and traversal, cross-project IDs, unexpected error redaction, notification/method/body/protocol failures, concurrent clients and escaped secret redaction. The SDK accepted legacy JSON-RPC batches despite current single-message HTTP semantics; a failing regression led to an explicit batch rejection before SDK dispatch. The source test uses a typed `Omit<..., "sessionId">` view for the SDK1.30 getter's incompatibility with exactOptionalPropertyTypes; runtime transport remains unchanged and no unsafe cast/TypeScript relaxation was introduced.

Logs under `.metaproject/data/gdctx/raw/`:

- RED missing implementation: `2026-10-26T22-04-18-673Z-4c0e84_run.log`.
- Final transport/boundary tests: `2026-10-26T22-08-46-767Z-b06803_run.log`.
- Final scoped ESLint: `2026-10-26T22-08-47-709Z-47ea21_run.log`.
- Root TypeScript: `2026-10-26T22-08-28-180Z-1d68da_run.log` (PASS; subsequent change only adds tested batch rejection).

No credentials files, Hub mutations, public Cloudflare setup, deployment, publication or owner acceptance were performed by this worker.

Routing: graph_used (affected Hub server); wiki_used (inherited index/design); testing context/related discovery used; ctx_used (read/rg/run); raw_rg_used: no. SDK declarations were read directly to settle exact installed signatures.

## Independent review fix F-MCP-001

The independent reviewer reproduced invalid nested JSON when a valid opaque credential ends with a backslash. The previous raw-string substitution could match part of a serialized escape sequence. Reproduced RED in `2026-10-26T22-15-42-359Z-e8e040_run.log`.

Fixed the serialization boundary rather than only reversing replacements over already-serialized JSON: redact decoded string values, then JSON-encode them. Decode SDK protocol envelopes before final redaction. Within decoded strings, replace escaped credential representations before plain representations. This preserves both the outer MCP JSON envelope and the JSON API data inside content text. Ordinary request IDs remain exact; credential-bearing IDs are explicitly rejected before any operation with a fixed HTTP400 error, avoiding either credential echo or a silently changed correlation ID.

Added regressions for trailing one/two backslashes, quotes, nested API string values, direct protocol errors, ordinary IDs, sensitive-ID rejection and real official SDK callTool results. Final focused transport/boundary run: fourteen tests, 104 assertions, PASS (`2026-10-26T22-16-33-761Z-75e67e_run.log`). ESLint PASS (`2026-10-26T22-16-34-744Z-786246_run.log`). The reviewer's original probe now returns valid inner JSON. Coordinator must regenerate release artifacts and independently recheck the final candidate after this fix; earlier packaging output does not include it.
