# Connecting clients to Hub MCP

Status: implementation examples. Release SDK1.32.1 HTTP and actual stdio subprocess interoperability passed with Bun1.3.14, including compiled npm and standalone clients. The existing shared development SDK1.30.0 was used for initial development only, not release artifacts. The named product UIs, their installed versions and the public Cloudflare machine route have not been exercised by these examples. Do not interpret an example URL as proof that public access is enabled.

## Shared prerequisites

Use a release of Keryx containing `hub mcp`, or the source/standalone client from the corresponding Hub release. Older global installations may not contain the command. The optional MCP SDK must be available when running the npm/source bridge. Runtime installation/bundling is described by the release packaging instructions.

The server administrator provisions a separate named, project-scoped agent key for each client. A read-only key may list and inspect but cannot submit work. Configure the following environment variables in the actual MCP client's launch environment or supported secure credential mechanism:

- `KERYX_HUB_TOKEN`: Hub agent credential. The bridge also accepts `--token-env NAME` to read a different environment variable.
- `KERYX_CF_ACCESS_CLIENT_ID` and `KERYX_CF_ACCESS_CLIENT_SECRET`: both Cloudflare Service Token fields when Access protects the route. Omit both for a local Hub without Cloudflare. Empty or partial pairs are rejected.

Do not use an operator/reviewer token as an agent key. The Cloudflare service token does not confer a Hub role and is not a Cloudflare account-management API key. Never commit literal credentials or send them to an assistant in chat. Do not add secrets to URL query strings.

The administrator must configure the scoped Cloudflare Service Auth policy and verify the existing tunnel audience/JWT and edge assertion guards. Browser email-code SSO stays separate. No Access bypass is required. Until machine setup is complete, use a local loopback test or keep public integration pending.

## Direct HTTP and local bridge

Direct HTTP clients send the Hub token as `Authorization: Bearer ...` and the two Cloudflare headers separately. The Hub endpoint uses stateless Streamable HTTP with JSON responses; clients must support the protocol versions negotiated by the tested SDK (latest 2025-11-25; compatibility versions 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07). It does not implement OAuth enrollment, long-running tasks or resource/prompt subscriptions.

The bridge exposes the same remote tools over local stdio:

```sh
keryx hub mcp --url https://hub.example.com/mcp
```

It does not need a Git checkout, `.metaproject`, binding or SSH tunnel. For source testing use the absolute entry path and omit the `hub` prefix:

```sh
bun --no-env-file --config=/dev/null /absolute/path/to/keryx/src/hub/client-main.ts mcp --url http://127.0.0.1:8787/mcp
```

Remote plaintext HTTP, credential-bearing URLs, query/fragment suffixes and redirects are rejected. Requests/initialization time out after 30 seconds. EOF or a termination signal closes the bridge; stdout is reserved for MCP protocol messages. An uncertain write result reports a sanitized error. Inspect Hub or repeat the same operationId; do not invent a new operation key just because the response was lost.

## Codex

Direct HTTP example for user configuration:

```toml
[mcp_servers.keryx_hub]
url = "https://hub.example.com/mcp"
bearer_token_env_var = "KERYX_HUB_TOKEN"

[mcp_servers.keryx_hub.env_http_headers]
CF-Access-Client-Id = "KERYX_CF_ACCESS_CLIENT_ID"
CF-Access-Client-Secret = "KERYX_CF_ACCESS_CLIENT_SECRET"
```

For local stdio use this entry instead, with variables forwarded to the child:

```toml
[mcp_servers.keryx_hub]
command = "keryx"
args = ["hub", "mcp", "--url", "https://hub.example.com/mcp"]
env_vars = ["KERYX_HUB_TOKEN", "KERYX_CF_ACCESS_CLIENT_ID", "KERYX_CF_ACCESS_CLIENT_SECRET"]
```

The HTTP header/environment and stdio settings follow the [official OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp). A desktop app does not inherit exports made in an unrelated SSH shell; reconnect/restart through the client's supported mechanism after setting its actual launch environment. Configuring this file does not itself add tools to an already-running chat.

## Claude Code

HTTP `.mcp.json` example with environment references:

```json
{
  "mcpServers": {
    "keryx-hub": {
      "type": "http",
      "url": "https://hub.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${KERYX_HUB_TOKEN}",
        "CF-Access-Client-Id": "${KERYX_CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${KERYX_CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

A stdio alternative is `{"type":"stdio","command":"keryx","args":["hub","mcp","--url","https://hub.example.com/mcp"]}` under the same server name. Its process must inherit the required variables. Follow [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for user/project scope, trust prompts and environment expansion; no client settings are changed automatically by Hub.

## Keryx Shell

Keryx's native MCP configuration uses a `servers` object. Example entry for the user `mcp-servers.json` under the Keryx configuration directory:

```json
{
  "schemaVersion": 1,
  "servers": {
    "keryx-hub": {
      "type": "stdio",
      "command": "keryx",
      "args": ["hub", "mcp", "--url", "https://hub.example.com/mcp"],
      "env": {
        "KERYX_HUB_TOKEN": "${KERYX_HUB_TOKEN}",
        "KERYX_CF_ACCESS_CLIENT_ID": "${KERYX_CF_ACCESS_CLIENT_ID}",
        "KERYX_CF_ACCESS_CLIENT_SECRET": "${KERYX_CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

The shape and `${NAME}` expansion are verified against this checkout's MCP configuration parser. Do not overwrite an existing `servers` object; merge only the desired entry. Use Keryx's MCP inspection/reconnect workflow to verify actual availability before asking an agent to act. A local Hub without Access must omit both Cloudflare variables rather than expand missing ones to empty strings.

## OpenCode

The current official V2 format nests servers under `mcp.servers`, unlike older V1 examples. Direct HTTP example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "keryx-hub": {
        "type": "remote",
        "url": "https://hub.example.com/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:KERYX_HUB_TOKEN}",
          "CF-Access-Client-Id": "{env:KERYX_CF_ACCESS_CLIENT_ID}",
          "CF-Access-Client-Secret": "{env:KERYX_CF_ACCESS_CLIENT_SECRET}"
        }
      }
    }
  }
}
```

For stdio, replace that server object with `{"type":"local","command":["keryx","hub","mcp","--url","https://hub.example.com/mcp"]}`; the command inherits the client environment. See [OpenCode V2 MCP documentation](https://dev.opencode.ai/v2/docs/mcp-servers/) for version-specific configuration. This project has not run OpenCode V1 or V2 against the endpoint; use the installed version's documented legacy-compatible negotiation when needed, rather than assuming its newest protocol is supported.

## Verification before real work

Initialize and list tools with a read-only named key first. Verify the visible projects and a known Flow/specification. Test revocation and read-only denial in a disposable project. Then configure a separately scoped write-capable client if needed. Freeze and final acceptance remain human actions; a successful tool response or self-reported Evidence is not approval.

Examples are configuration guidance only, not a request to weaken Access or enable every client simultaneously. Each installation gets its own named key, rotation/revocation and project permissions.
