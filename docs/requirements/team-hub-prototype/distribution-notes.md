# Distribution and agent connectivity — working notes

Recorded: 2026-10-27. Status: proposed product direction, not a release specification or an implementation claim. The owner requested that the distribution discussion be retained. No release, cloud access policy, credentials or client configuration is changed by this note.

## Distribution proposal

Keep one source repository, with two installation paths:

| Component | Distribution | Audience |
|---|---|---|
| Keryx CLI, shell and Hub connector | npm package `@mrciphersmith/keryx` | Every developer |
| Team Hub server and prebuilt React UI | Versioned Docker image and minimal Docker Compose file | Once per team, on a workstation or server |
| Hosted Hub | Possible later service | Teams that do not want to administer a server |

The existing prototype npm bundle currently contains both the Hub server and embedded web assets. Separating client and server distribution is a proposed release design, not something already completed.

### Intended new-user journey

1. Install Keryx using one documented path that checks Bun and other prerequisites.
2. Start a prebuilt Hub image from Compose without cloning source, building React or installing application dependencies.
3. Complete a first-run wizard: establish an administrator, choose authentication, create a project.
4. Connect a local checkout through `keryx hub connect` with a supported enrollment flow.
5. Import wiki/OpenSpec content or begin with an empty project.

The first-run wizard and simplified enrollment remain future work. Local application environments, Docker dependencies and agent execution stay on developer machines; shared project context and coordination live in Hub.

### Initial public release deliverables

- npm CLI/connector package and versioned Hub container, with a documented compatibility policy.
- Minimal Compose file with persistent storage and startup diagnostics.
- Separate guides: local trial and team server deployment.
- Backup, restore, upgrade and rollback procedures.
- Optional Cloudflare Tunnel/Access setup, or a documented HTTPS reverse-proxy deployment with supported authentication. Local trial must not require Cloudflare.
- Bind locally by default; external exposure is an explicit deployment step.

Release readiness: a new user on a clean machine can connect their first project by following the README, without repository internals, manually supplied maintainer credentials or undocumented configuration edits. The current geekom deployment is a working prototype, not evidence that this onboarding path is complete.

## MCP access — follow-up design proposal

The owner asked whether an assistant could connect to the existing Cloudflare-protected Hub using MCP and a configured key. Yes: implement a dedicated Hub MCP adapter with a Streamable HTTP endpoint, backed by existing Hub operations and authorization. The current Hub HTTP API and the existing local Keryx MCP server are not by themselves this dedicated remote endpoint.

Proposed topology:

```text
Codex / other MCP client
  -> HTTPS + Cloudflare Access machine authentication
  -> Hub MCP adapter
  -> existing Hub application/domain operations and storage
```

### Authentication and authorization

- Cloudflare Service Token admits the machine through Access; it is not a Cloudflare management API key and does not grant a human Hub role.
- An independent Hub agent credential identifies the agent to Hub. Existing prototype agent credentials are shared and not project-scoped: per-client identities, project scopes, rotation and revocation are additional work, not existing guarantees.
- Preserve the Hub agent principal through every operation. Do not implement a proxy that calls the operator API on an agent's behalf.
- Use a Service Auth policy restricted to the MCP/API surface. Retain the browser's human SSO policy. Check the deployed tunnel audience/JWT enforcement and edge assertion guard against service-auth requests before activation; do not bypass or disable them to make MCP connect.
- Keep all values outside repository config and chat; reference environment variables or a client-supported secure credential mechanism. Only the MCP client process needs access to the secrets; model-facing tool arguments/results must not include them.
- Use separate headers for Access and Hub authorization, without overwriting the Hub Bearer header. Validate origin, authentication, session handling and transport behavior server-side. No secrets in URLs, redirects, errors or logs.

### Proposed first tool surface

Read project/Flow/specification/document/revision/Evidence/history; start an already frozen ready Flow; submit a Code Revision; attach immutable Evidence; submit an exact candidate for review. These are proposed capabilities, not existing MCP tool names.

Retain expected-version/digest checks, immutable subject binding, idempotency and review-bundle delivery restrictions. Freeze and final acceptance remain human-only. Git selection/publication is not part of the initial agent tool surface. Prefer a read-only first connectivity check before enabling mutations.

### Illustrative future Codex configuration

This is a proposed endpoint, not a currently available URL or an instruction to install credentials now:

```toml
[mcp_servers.keryx_hub]
url = "https://hub.example.com/mcp"
bearer_token_env_var = "KERYX_HUB_AGENT_TOKEN"

[mcp_servers.keryx_hub.env_http_headers]
CF-Access-Client-Id = "KERYX_CF_ACCESS_CLIENT_ID"
CF-Access-Client-Secret = "KERYX_CF_ACCESS_CLIENT_SECRET"
```

The variables must be available to the actual MCP client process; exporting them in an unrelated SSH shell does not populate a desktop process. Client support and reconnection behavior must be checked against the installed client version before setup. A local stdio bridge is a possible fallback for clients that cannot send the needed HTTP headers. OAuth enrollment can be considered later for reducing manual key distribution.

### Sources and routing

- [OpenAI MCP client configuration](https://learn.chatgpt.com/docs/extend/mcp): HTTP endpoints, Bearer environment variables and environment-backed headers.
- [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): machine credentials, Service Auth policies and request headers.
- Local source inspection: `src/commands/hub.ts`, `src/hub/server.ts`, `deploy/team-hub/geekom/edge.conf`, existing MCP routing.

Routing: graph_used (find/affected; pre-existing graph, untracked output artifacts excluded from conclusions); wiki_used (index); memory_used (no matching entry); ctx_used (read/rg/run); raw_rg_used: no.
