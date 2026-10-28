# Hub MCP architecture contract

Status: implementation design; subordinate to the frozen Hub specification.

## Server integration

One Hub application owns SQLite, serialization, version/spec checks, receipts and idempotency. MCP handlers call the same in-process REST application with the validated incoming agent Bearer header. No loopback network proxy and no shared operator token. Request-scoped SDK Server/transport instances are stateless and use JSON responses; no identity-bearing mutable singleton or session reuse.

MCP adapter input: Request plus a same-application `(Request) => Promise<Response>` operation callback. Authentication and Origin validation happen before initialization/discovery. The callback cannot be selected by tool input; routes and methods come from the fixed tool catalogue. Body limits and sanitized transport/tool errors apply before/after the SDK respectively.

## Named credentials boundary

Optional `agentCredentialsFile` in HubConfig, loaded through `KERYX_HUB_AGENT_CREDENTIALS_FILE`. Proposed file shape: `{ "agents": [{ "id": "aleks-codex-mac", "tokenDigest": "<sha256>", "projectIds": ["<project-id>"], "readOnly": false }] }`. Validate a bounded regular file, unique IDs/digests, identifier/project syntax, boolean permissions and no collision with reserved bootstrap credentials. Key values are never stored in this file. Re-read for each authenticated request; configuration failures produce fixed errors, no token/JSON/path echo.

Resolved principal: kind/role agent, stable `agent:<id>` and optional projectIds/readOnly scope fields. Legacy agent:connector keeps compatibility, documented as unscoped. Common REST gate filters projects, denies out-of-scope project paths and project creation, and denies mutations for read-only principals. Existing domain scope checks still validate cross-project entity references. Do not cache permissions in MCP sessions. Current bearer value is redacted from Evidence submission/output without persisting it in state.

## Tool naming and writes

Prefer `hub_list_projects`, `hub_get_project`, `hub_list_flows`, `hub_get_flow`, `hub_list_documents`, `hub_get_document`, `hub_list_revisions`, `hub_get_revision`, `hub_get_evidence`, `hub_get_events`, `hub_get_context`, `hub_start_flow`, `hub_create_revision`, `hub_add_evidence`, `hub_submit_for_review`.

Each tool has a closed input schema. Tool catalogue annotations distinguish read and mutation operations. Writes require `operationId`; expectedVersion and subjectRevisionId are explicit where the existing API requires them. A returned successful tool call is not trusted CI, human approval or publication.

## Bridge

`keryx hub mcp --url <endpoint>` is a local stdio SDK Server backed by an SDK Client connected to the remote endpoint. Forward listed tools and call results, with no human approval tools added locally. A malformed or changed remote tool schema is not an instruction to read credentials or execute shell code. Read secrets only from named environment variables. Bind process lifetime to stdin EOF/signals; do not emit logs to stdout or dump raw transport errors. Reject non-HTTP(S), URL credentials/query/fragment, non-loopback plaintext HTTP, unsafe redirects, missing token and partial Cloudflare pairs before connecting.

## Runtime packaging

The installed SDK is 1.30.0, while the root optional dependency range currently differs. Implementation must choose and pin the actually tested SDK in isolated runtime build inputs; do not update/install the shared root node_modules. Hub Docker/source/standalone distribution must work without the developer dependency tree, either through a built bundle or explicit isolated install. npm CLI retains lazy optional SDK loading. Document any changed source-install steps and compile targets honestly.

## Verification matrix

- HTTP SDK client: initialize/list/call; unsupported methods, invalid Origin, malformed/oversized bodies and auth rejection.
- Concurrent clients: distinct principals/replay keys, project filtering and exact-subject Evidence attribution.
- Credential reload: revoke/downgrade/change scope; no cached successful permission across calls; malformed file fails closed.
- Mutations: full disposable project ready->start->revision->Evidence->submit; no real project acceptance/publication.
- Stdio subprocess: same discovery/calls; protocol-only stdout, auth/EOF/error handling, no secret echo or unsafe retry.
- Packaging: independent runtime image and extracted source/standalone smoke; no dependence on shared root modules.
- Compatibility: existing Hub/SSO/connector and CLI reference tests, root TypeScript/lint/build.

Cloudflare live Service Auth setup remains a separate operator-controlled deployment step. Never weaken the tunnel audience/JWT verification or edge assertion guard. All external setup not actually executed must remain pending.

## Implemented runtime selection

Release runtime is pinned to SDK1.32.1 with an isolated lock compatible with minimum Bun1.3.14. Audit of the existing development SDK1.30.0 found vulnerabilities, so it is not shipped in the new runtime. Container/source installs use the isolated frozen lock; standalone compilation stages the same sources/runtime first. Root optional SDK declaration is exact1.32.1, while the shared root node_modules has deliberately not been modified. Independent release HTTP/stdio, SDK-facing strict TypeScript and compiled client checks passed against1.32.1.
