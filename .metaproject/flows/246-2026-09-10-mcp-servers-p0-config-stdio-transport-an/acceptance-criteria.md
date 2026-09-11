# Acceptance Criteria

P0 of `docs/requirements/keryx-mcp-servers/implementation-plan.md`. The ten the
plan assigns to this phase, restated here so the flow is checkable on its own,
with the specification's numbering kept in brackets so neither document has to
be read through the other.

Every criterion is verified by RUNNING the thing it describes. Where a criterion
can only be met by a real subprocess it says so, and that test is flag-gated the
way `keryx-mcp-client` already gates its live tests — flag-gated is not the same
as unverified, and a criterion nobody ran is not met.

- AC1: [spec AC1] A user `mcp-servers.json` and a project `.keryx/mcp-servers.json` that both define `github` resolve to the project entry only, and the disable overlay and `${VAR}` expansion are applied at load. Verified on the merge function directly, and the project walk from cwd to git root is asserted with a fixture nested two directories deep.
- AC2: [spec AC2] `keryx mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem <dir>` followed by `keryx mcp doctor filesystem` reports `connected` and a non-zero tool count against a REAL process. Flag-gated behind `KERYX_ALLOW_REAL_SUBPROCESS=1` and excluded from CI, matching the `keryx-mcp-client` precedent; the gating is recorded rather than the criterion quietly dropped.
- AC3: [spec AC4] A tool whose qualified name fails the 64-character regex is absent from the catalog AND listed as skipped by `doctor`. Both halves asserted: a name that is merely absent, with nothing saying why, is the silent-skip failure this repository keeps finding.
- AC4: [spec AC5] With N MCP tools connected, the interactive agent's advertised tool definitions contain `search_tool` and `use_tool` and contain none of the N fully-qualified names. Asserted against the definitions the agent actually advertises, not against the catalog.
- AC5: [spec AC6] `search_tool` with a query matching a connected tool returns that tool's FQN, and `use_tool` with that FQN performs `tools/call` and returns its content. Driven against a fixture MCP server over stdio, no network.
- AC6: [spec AC7] A tool result larger than the cap is truncated in the model-visible output, and the test asserts the cap constant itself so a silently raised cap fails rather than passes.
- AC7: [spec AC11] `use_tool` on a write-shaped MCP tool in `ask` mode reaches `resolveApprovalDecision`/`requestApproval`. Under `trust`, a classifier-marked destructive call still asks. Headless, with `requestApproval` undefined, it fails CLOSED. All three arms asserted, because the third is the one that turns a prompt into a bypass.
- AC8: [spec AC15] With two servers configured and one command missing, the good server reports `connected`, the bad one `failed`, and the session still starts. A partial failure that takes the session down is worse than the server that failed.
- AC9: [spec AC16] `keryx mcp disable <name>` leaves the native config file intact, reports status `disabled`, and starts no child process. The absence of the process is asserted, not assumed from the status.
- AC10: [spec AC18] `CAPABILITY_REGISTRY` in `src/capability/registry.ts` gains no entry for this package, and no new capability flag is introduced. Pinned by a test so a later phase cannot add one without the decision being visible.
- AC11: The constraints the plan carries into every phase hold, each checked rather than asserted: no static `@modelcontextprotocol/sdk` import on any path `keryx --help` loads; no writes to `.metaproject/core/mcp/mcp.config.json`, `.cursor/mcp.json` or Claude configs outside the existing installer; `connectCodexMcpClient` and `gatedSuperviseCodexMcpRun` still green; and bare `keryx mcp` still serves.
- AC12: `bun test`, `tsc --noEmit`, `bun run lint` and `keryx skills verify --bundled` are clean, all run FROM SOURCE. The installed binary predates this work by construction, and this flow has already been bitten once by trusting it.
