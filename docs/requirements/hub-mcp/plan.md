# Hub MCP implementation plan

Canonical state: Team Hub project keryx. Use the Hub cycle rather than creating a duplicate local legacy Flow. Baseline: d6a187db1ba0304046b9b598e1aa868a232b29f9. Owner freezes the specification and criteria before implementation starts. Outcome: verified Hub handoff, owner acceptance pending; no PR/npm publication in this task.

## Tasks and ownership

- T1 — named agent credential validation/reload and REST scope enforcement, preserving legacy auth; failure/concurrency tests.
- T2 — stateless remote MCP transport and fixed tool schemas/dispatch delegating to existing REST application operations using the same agent Bearer, never an operator credential; SDK interoperability and domain-guard tests.
- T3 — local stdio bridge CLI, secure environment-backed remote connection, client examples and CLI reference; actual subprocess SDK tests.
- T4 — runtime packaging/container integration, isolated reproducible dependency handling and local/container smoke; no shared root dependency install.
- T5 — independent correctness/security review and verifier; repair confirmed findings up to three implementation attempts per approach, then escalate with evidence.
- T6 — exact-candidate Code Revision/Evidence and submit-for-review. Full repository is above snapshot quota, so use technically non-deliverable review bundle with Git base and patch. Do not modify integration line or accept result.

## Boundary contracts

Workers coordinate ownership of server.ts/commands/hub.ts; one owner integrates each shared file. Endpoint transport is stateless per request to avoid principal/session mixing. Named-agent scopes must run in the common REST authorization boundary so in-process MCP dispatch and direct REST have identical restrictions. Client names never prove identity; the validated key resolves the principal.

State × event matrix: no UI changes. Credentials: valid -> allow scoped request; revoked -> deny next request; unreadable/malformed configured file -> fail closed with sanitized service error; client switch -> independently authenticate without prior-client state. Mutations: fresh operation -> domain guard then commit; unchanged retry -> replay; changed payload same key -> conflict; uncertain network result -> return error, caller can repeat the same key. Bridge: starting -> initialize remote or sanitized failure; connected -> forward; remote auth loss -> error without credential fallback; EOF/signal -> close and exit boundedly. Each row maps to AC2/3/5/7/8/10.

## Deployment boundary

Prepare packaging and operator instructions. Preserve existing Cloudflare browser SSO, tunnel audience enforcement and edge assertion guard. Public machine connectivity depends on a scoped Service Auth policy and keys; security-sensitive external changes require concrete review before activation. If unavailable, verify local and container operation and retain public setup as pending. Do not claim this chat has tools until client configuration/reload and actual tool discovery succeed.

## Routing

graph_used: affected server/find MCP; wiki_used: index (local MCP context distinct from Hub); memory_used: no match; ctx_used: read/rg/run; raw_rg_used: no. Installed SDK APIs are verified locally and against primary transport documentation. No applicable Hub-specific project skill exists; use local flow-orchestrator with bounded implementer/verifier/review workers, adapted to the already chosen canonical Hub lifecycle.
