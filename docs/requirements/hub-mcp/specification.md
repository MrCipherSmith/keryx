# Shared Team Hub MCP and local stdio bridge

Status: proposed for owner freeze. Date: 2026-10-27.

## Problem and outcome

Codex, Claude Code, Keryx Shell, OpenCode and other compatible clients need one authenticated interface to shared project work. Today the prototype has REST API, CLI connector and browser UI, but no dedicated remote Hub MCP endpoint. The result is one Hub MCP endpoint and a local stdio bridge shipped through Keryx, with client-independent tools and server-owned authorization.

## Scope

### Remote endpoint

Expose `/mcp` on the existing Hub server using MCP Streamable HTTP with JSON responses, supported protocol negotiation and SDK interoperability. Stateless operation is acceptable: no cross-request session identity or shared mutable agent context. Validate Origin when present, authenticate every request, bound bodies, reject unsupported HTTP/protocol operations explicitly and preserve deployment default loopback binding. No unauthenticated discovery of project data. Agent Bearer credentials are required; browser cookies, human operator/reviewer credentials and Cloudflare human identity alone cannot invoke agent tools.

Reuse existing Hub application/domain operations with the original agent identity, serialization, quotas, optimistic concurrency and idempotency. Do not proxy mutations with an operator credential or duplicate domain mutation logic.

### Tools

Provide a fixed tool surface, with discoverable JSON input schemas and meaningful read-only annotations:

- List accessible projects and get a project.
- List/get Flows, list/get documents (wiki/spec), list revision summaries and get an exact revision, read Flow Evidence, read paginated project history and shared context.
- Start an already frozen ready Flow, create a Code Revision, attach Evidence to its exact subject, and submit an exact candidate for human review.

All mutations require a caller-supplied bounded operation/idempotency key. Conflicts and invalid arguments remain explicit. Retrying an unchanged operation cannot duplicate it; changed payload with the same key is rejected. Uncertain network outcomes are not automatically retried as new writes. MCP must not expose an arbitrary URL/HTTP method tool.

Do not expose freeze, accept, project creation, token administration, integration selection, delivery or arbitrary status changes. Existing server guards remain authoritative even if a client calls a forbidden tool name or directly uses REST. Review bundles remain non-deliverable. Document content is returned as untrusted project data, never interpreted by the server as tool instructions.

### Client identities and project permissions

Add optional named agent credentials through a protected configuration file. Store token digests, stable agent IDs, explicit project allowlists and a read-only flag; do not store plaintext agent keys in project data. Validate configuration at startup; reload at request time for revocation/scope changes; malformed/unavailable configured credentials fail closed with sanitized errors. Enforce scopes on REST as well as MCP, including project listing and direct entity requests. Named agents cannot create projects or escape a project through cross-project document/revision IDs. Actor IDs persist into events, Code Revisions, Evidence and idempotency isolation. Preserve legacy bootstrap agent credentials for compatibility, documenting their broader privileges; do not label them as a verified personal identity. Credentials are separate from browser human roles.

### Local bridge and supply

Add `keryx hub mcp --url <endpoint>` as a stdio MCP bridge. It connects directly to the remote Streamable HTTP endpoint, exposing the same tools/results over stdio; it must not require a local Git checkout, local project binding or an SSH tunnel. Use the Hub agent key from an environment variable and optional paired Cloudflare Service Token headers from environment. Never accept raw keys in flags or output them. HTTPS required remotely; loopback HTTP allowed for local tests. Reject credential-bearing/query/fragment URLs, cross-origin redirects and partial Cloudflare credential pairs.

Only MCP messages go to stdout. Diagnostics are bounded and sanitized on stderr. Handle shutdown, timeouts, authentication failures and broken remote connections without hanging; preserve call IDs/results and supplied operation keys. Do not auto-retry unsafe calls. No agent key or Cloudflare secret is included in tool discovery, tool results, logs or errors.

The existing npm Keryx CLI includes bridge support. Hub container and source/standalone package include the endpoint and its necessary runtime dependencies or bundled code, without modifying the shared root dependency installation. Optional MCP dependencies load only for MCP use; unrelated commands retain existing behavior. Document supported transport/version requirements and clients honestly; real SDK remote and subprocess stdio interoperability must be demonstrated, not claimed from configuration examples alone.

### Deployment and Cloudflare

Provide configuration examples for Codex, Claude Code, Keryx Shell and OpenCode, distinguishing validated client behavior from unexecuted examples. Document environment/secure credential sources and the fact that variables must reach the actual client process.

Cloudflare browser SSO remains unchanged. Machine access requires an explicitly scoped Service Auth policy and service-token headers, plus independent Hub agent credentials. Retain tunnel JWT/audience verification and the edge assertion guard; verify their compatibility with service authentication before activation. Never add an unauthenticated Access bypass. Prepare deployment/backup/rollback and operator setup instructions. If external credentials/Cloudflare approval are unavailable, finish and prove local/container integration, report the external setup as pending, and do not claim that public MCP is enabled or connected to this chat.

## Out of scope

OAuth/device enrollment, hosted service billing, token-management UI, true first-class Attempt, browser Flow-model enhancement, arbitrary shell execution, remote application environments, automatic Git publication, npm publishing and automatic owner acceptance.

## Acceptance criteria

1. The Hub serves an authenticated Streamable HTTP MCP endpoint at /mcp, with initialization/protocol negotiation, discovery and tool calls interoperating with the installed official MCP SDK; bounded requests, Origin checks, notifications and unsupported HTTP operations have explicit tested behavior.
2. Every MCP operation uses an authenticated Hub agent principal. Missing/invalid credentials, human Bearer tokens and cookie-only access are rejected; no operator impersonation or cross-client identity leakage occurs under concurrent requests.
3. Named digest-backed agent credentials support stable distinct IDs, project allowlists and read-only permissions; startup validation, request-time revocation and fail-closed reload behavior work. The same scopes apply to REST and MCP, while legacy authentication remains compatible and accurately documented.
4. The read tool surface retrieves accessible projects, Flow/spec/wiki, exact revisions, Evidence, shared context and paginated history; revision lists use metadata summaries, schemas reject invalid arguments and responses never expose credentials.
5. Agent mutation tools support start-ready, create-revision, add-exact-subject-Evidence and submit-for-review with caller operation keys, expected versions/digests and existing domain guards; duplicate retries replay and changed-payload retries conflict without duplicate writes.
6. MCP exposes no freeze, acceptance, token administration, integration selection or delivery. Human-only approvals, cross-project references and review-bundle delivery restrictions remain enforced through MCP and the existing API.
7. The npm CLI registers keryx hub mcp --url as a working local stdio bridge to the remote endpoint, independent of checkout/binding, and real subprocess SDK tests demonstrate initialization, tool discovery and representative calls with stdout containing only protocol messages.
8. Bridge configuration reads Hub and optional paired Cloudflare service credentials from environment only, validates remote HTTPS/loopback URLs, blocks unsafe redirects, sanitizes failures, preserves operation keys and handles shutdown/timeouts without unsafe automatic retries.
9. Hub container, source/standalone packaging and npm build include the necessary endpoint/bridge runtime; reproducible dependency inputs are recorded, unrelated CLI/Hub behavior and the shared root node_modules remain intact, and new dependencies are not eagerly loaded outside MCP paths.
10. Automated tests cover successful read/write flows, permission/revocation and concurrency failures, input/transport limits, idempotency/conflicts, redaction, bridge interoperability and existing Hub regressions; typecheck, lint, build, documentation and packaging smoke checks pass with exact-candidate Evidence.
11. Setup documentation provides client examples, Cloudflare Service Auth plus Hub-token separation, key provisioning/revocation, local and team deployment, backup/rollback and compatibility limits; unexecuted client/public checks are explicitly marked pending rather than passed.
12. Implementation is delivered through an immutable Hub Code Revision with Evidence and submitted for owner review; no real owner acceptance, Git publication, npm publication or unapproved external access expansion is performed.
