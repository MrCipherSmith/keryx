# Hub MCP runtime, deployment and recovery

Status: implementation setup guide. Public Cloudflare Service Auth activation, actual third-party client configuration and owner acceptance are separate operator steps; this document does not claim they have occurred.

## Runtime version and dependencies

The release runtime pins `@modelcontextprotocol/sdk` **1.32.1** with an isolated `deploy/team-hub/runtime/package.json` and `bun.lock`. The initial local API reconnaissance used the existing shared development SDK1.30.0; that installation is not a release dependency. An isolated audit found five advisories in1.30.0, including three high-severity findings, so the shipped runtime uses1.32.1. The isolated1.32.1 audit returned no findings. Root optional SDK declaration is pinned to1.32.1; shared root node_modules is not installed into, replaced or upgraded by this work.

The Hub Docker image installs only the isolated production runtime with its frozen lockfile. The source archive carries the same runtime package and lockfile at its root. Standalone packaging compiles from a temporary isolated source tree with that frozen runtime, never from the developer checkout's stale SDK. Ordinary non-MCP Hub requests keep SDK loading lazy; an SDK-free source checkout may serve health/UI/API, but `/mcp` requires the SDK and returns a sanitized unavailable error if missing.

## Local source release

After verifying the supplied archive checksum, extract to a new directory:

```sh
sha256sum -c SHA256SUMS
tar -xzf team-hub-prototype-source.tar.gz
cd team-hub-prototype
bun install --frozen-lockfile --production --ignore-scripts
bun scripts/smoke/team-hub.ts
```

Bun1.3.14 or newer is required. The install is inside the extracted release, not the main Keryx checkout or shared development node_modules. Supply independent Hub bootstrap tokens and a data directory through environment as documented in the [prototype guide](../team-hub-prototype/README.md). Then run `bun src/hub/main.ts`. Local machine access uses loopback HTTP; remote access requires HTTPS and deployment authentication.

The root npm Keryx package exposes the bridge as `keryx hub mcp --url <endpoint>`. The source-release equivalent is `bun src/hub/client-main.ts mcp --url <endpoint>`. It requires no local Git repository or checkout binding. Bridge/client examples and environment variable names are documented in [client configuration](clients.md); only environment-backed secrets are accepted, never raw key flags.

## Named agent credentials

Set `KERYX_HUB_AGENT_CREDENTIALS_FILE` to an owner-only regular JSON file. Its schema is:

```json
{
  "agents": [
    {
      "id": "aleks-codex-mac",
      "tokenDigest": "<lowercase SHA256 of a strong agent key>",
      "projectIds": ["<allowed Hub project ID>"],
      "readOnly": false
    }
  ]
}
```

The placeholders are not valid provisioned credentials. Generate a separate random key for each client using a local secret manager; give the raw key only to that client's environment and place its SHA256 digest in this file. The file contains no plaintext key. IDs must be lowercase identifiers, project IDs explicit, the reserved `connector` ID and duplicate/bootstrap digests are rejected. `projectIds: []` grants no project access. `readOnly: true` allows reads through MCP's POST transport but blocks underlying REST mutations. An absent readOnly field means a scoped writer.

On POSIX systems the file must have no group/other permissions, for example0600, be no larger than64KiB and have at most128 entries. Symlinks/FIFOs/directories and malformed/unreadable files are rejected. In a container use a read-only directory mount with files readable by the container's `bun` user; mounting the parent directory allows atomic file replacement during rotation. An example deployment override, with paths chosen by the operator:

```yaml
services:
  hub:
    environment:
      KERYX_HUB_AGENT_CREDENTIALS_FILE: /run/keryx-agents/agents.json
    volumes:
      - /absolute/protected/agent-directory:/run/keryx-agents:ro
```

A configured invalid file refuses startup. Changes are re-read for requests, including before a queued mutation commits: removing an entry revokes its key, editing projects/readOnly changes authorization without restarting. Runtime file failure denies agent access with a sanitized error; independent human recovery authentication remains available. Rotate by replacing an entry's digest while keeping its stable ID: existing idempotency identity is preserved. Replace the client environment key and reconnect. Different client IDs have separate idempotency namespaces. Legacy bootstrap `agent:connector` remains compatible and unscoped; do not distribute it when per-client/project restrictions are required.

## Cloudflare machine access

Keep browser email/SSO policies unchanged. Provision a Cloudflare Service Token for the MCP/API surface with a narrowly scoped **Service Auth** policy. It is separate from the Hub agent key and does not grant any human role. Requests carry `CF-Access-Client-Id`, `CF-Access-Client-Secret` and independent `Authorization: Bearer <Hub agent key>` headers.

Do not substitute a Cloudflare account-management API key. Do not reuse the operator/reviewer token for an agent. Keep credentials out of chat, URLs, repository configuration and logs. Environment variables must reach the actual MCP client process; setting them in an unrelated SSH shell does not configure a desktop application.

Before activating public MCP, verify the real Service Token request against the existing tunnel JWT/audience verification and nginx assertion guard. The edge currently requires `Cf-Access-Jwt-Assertion`; service identity must satisfy the deployed Access path without becoming a human identity. Do not disable the guard, add a public bypass, weaken audience checks or replace browser SSO to make the request work. If policy/credentials are not available, leave public activation pending and use a controlled loopback/SSH test path. No external policy change is implied by building the image.

## Release and rollback

```sh
bun scripts/package-team-hub.ts --out /absolute/release-directory --linux-x64
```

Packaging verifies frontend freshness and outputs source, Linux x64 standalone server/client and SHA256SUMS. Compilation installs the pinned runtime in a disposable directory and can require registry and official Bun cross-target downloads. Git remains a system dependency for existing delivery behavior. Source archive bytes are deterministic for identical inputs and SOURCE_DATE_EPOCH; executables are not claimed byte-reproducible across Bun versions.

Before upgrading an existing Hub: preserve the current release/configuration and make a consistent SQLite backup using the established deployment backup procedure. Test the candidate against disposable data first, then switch the release while retaining the old image. This feature adds configuration and transports, not a SQLite schema migration. To roll back, restore the previous runtime/config and keep the current compatible data volume; restoring an older database discards later project work and is a separate operator decision. Do not overwrite a working release or delete its persistent data to test MCP.

## Verification claims

Only successful automated/client/container checks recorded in exact-candidate Hub Evidence count as executed checks. Real Codex/Claude/OpenCode/Keryx Shell installation and public Cloudflare service-auth checks remain pending unless individually documented as executed. SDK interoperability demonstrates protocol behavior, not a guarantee for every client version. No owner approval, Git delivery or npm publication is performed by these setup examples.
