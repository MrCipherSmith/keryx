# geekom activation and read-only Codex test

Date: 2026-10-27. User explicitly authorized activating the verified Hub image, provisioning a project-scoped read-only key and configuring Codex through an SSH tunnel. This follow-up does not accept the implementation Flow or publish Git/npm.

## Deployment

- Running release: `840fb1ba82c7-mcp`, runtime source commit `840fb1ba82c71fd3ee2d68038f76433f250f7da5`.
- Previous release retained: `/home/<user>/keryx-team-hub/releases/0aed6a7da8b0-react`.
- Consistent SQLite backup: `/home/<user>/keryx-team-hub/backups/mcp-20261027T045629Z/hub.sqlite`,14925824 bytes, quick_check ok.
- Reused the independently tested SDK1.32.1 image/source checksums from report.md. Activated only Hub and edge through the existing Compose wrapper, with automatic rollback on failed health/SSO/state checks. No database restore/migration occurred.
- Before/after API metadata matched:2projects and5Flows retained, including exact versions, pinned digests and review subjects. The original bootstrap secrets and human role mapping were not changed.
- Hub health200/healthy; system cloudflared active; startup log contains only the normal listening line.
- Published host bindings remain loopback only: Hub127.0.0.1:8787 and edge127.0.0.1:8788. Anonymous browser-like public request redirects302 to existing Cloudflare Access. An initial generic Python-user-agent request returned403; browser-like verification confirmed the Access redirect. No Access policy, tunnel audience/JWT enforcement or edge assertion guard was modified.

Deployment log: `.metaproject/data/gdctx/raw/2026-10-27T04-59-22-629Z-c16340_run.log`.

## Dedicated read-only identity

Provisioned `agent:aleks-codex-mac-readonly` with only project `fcb56bb6-6eb6-4c2e-b154-1d682432a778` and `readOnly:true`. The server stores only its digest in an owner-only agent configuration directory mounted read-only. The raw key is stored locally outside Git in a protected user configuration directory; it is not in config.toml, process arguments, logs, this document or chat. No existing key was substituted or distributed.

A private SSH control socket forwards127.0.0.1:<local-port> to <server> 127.0.0.1:8787. The local launcher checks/starts this tunnel with batch-mode SSH and host-key checking. No public Cloudflare Service Token is configured or needed for this loopback test.

## Codex configuration and actual protocol checks

Added only `[mcp_servers.keryx_hub_readonly]` to the user Codex configuration, preserving existing servers/settings and keeping a protected backup. The entry launches the verified SDK1.32.1 standalone stdio bridge through a local wrapper and enables only eleven read tools. The wrapper loads the protected key into a dedicated child environment variable, removes inherited Hub/bootstrap/Cloudflare credential variables, and never prints it. It requires no project checkout or root development dependency installation.

A direct HTTP headers-helper configuration was considered initially. The final installed configuration uses stdio for compatibility with the installed Codex CLI0.147.0; `codex mcp get keryx_hub_readonly --json` confirms the final command, read allowlist and enabled status. No literal credential is in that output.

Actual HTTP MCP with the new named key passed: fifteen tools discovered, only keryx visible, fiveFlows and the exact specs/hub-mcp.md digest read, write denied as agent-read-only, other-project read denied as agent-scope-denied, real Flow unchanged. Log: `.metaproject/data/gdctx/raw/2026-10-27T05-01-29-957Z-2380c0_run.log`.

Actual configured launcher/stdout bridge also passed initialization/discovery/scoped reads and write denial; stderr empty and stdout valid MCP. Log: `.metaproject/data/gdctx/raw/2026-10-27T05-03-59-811Z-c68370_run.log`.

## Remaining UI step

The desktop computer-use tool explicitly refused control of app com.openai.codex for safety reasons. The agent did not try another UI automation path. A normal client reload/Restart is needed to refresh the already-open chat catalogue; no native chat attachment is claimed. The owner is controlling the laptop remotely from a phone and cannot use its settings UI now, so setup validation continued through the documented protocol without restarting the existing app or injecting its private stdio channel.

A separate short-lived instance of the actual embedded Codex CLI0.164.0-alpha.11.1 was initialized through the official app-server protocol. mcpServerStatus/list successfully discovered keryx_hub_readonly with exactly11 read tools and no mutation tools. No thread was created, no model request was made and the existing desktop app was not restarted. The standalone system CLI version is0.147.0; both parse the persisted stdio entry. The existing desktop app-server processes expose only private stdio, and the documented default control socket is absent, so config/mcpServer/reload was not sent to a different process and misrepresented as an active-chat refresh.

Testing can continue from the phone through the verified Hub MCP launcher/standard client invoked by the assistant. This is actual MCP transport, but is distinct from native tool attachment to the already-open chat. Keep this key read-only for the first trial. Write-capable client provisioning, Cloudflare Service Auth and implementation-Flow acceptance remain separate owner actions.

## Rollback and revocation

The previous release/image and compatible data volume remain available; switching back does not require restoring an older database. Deployment metadata and backup pointers are under the existing geekom Hub installation. Revoke this client by removing its named entry from the agent credential map; the next request is denied without a restart. Disable/remove only the keryx_hub_readonly MCP entry and close its dedicated SSH control socket to remove the local connection. Preserve unrelated Codex settings and SSH sessions.

Non-secret local verification records: `output/hub-mcp/activation/`. No key/config-backup content is copied there.

Routing: index/deploy skill/deployment docs read; ctx_used; graph/wiki reused from implementation for the unchanged artifact; raw_rg_used:no. Official OpenAI MCP configuration documentation was checked for client setup.
