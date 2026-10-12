# MCP trust follow-ups: destructiveHint tools never offer trust; /mcp trust list and revoke

Status: ready
Source: user description (follow-up recorded in flow 359 AC6, confirmed by the operator)

## Problem

Since 0.3.27 an operator can answer "Trust this tool (this session)" on the approval prompt of an MCP `use_tool` call; later calls of that exact tool run without asking while its definition is unchanged. Four gaps remain:

1. A tool that declares `destructiveHint: true` is offered the same trust as a read-only one. Annotations exist only as `CatalogEntry.annotations` and are read by the advisory `classifyToolRisk`; they never reach the prompt or `executeCall`.
2. The operator cannot see which tools are trusted, and cannot withdraw a grant without ending the session.
3. Where a tool is shown (approval dock, transcript, auto-approve line) nothing says it is trusted, so a silent run is indistinguishable from a normal approved one.
4. `/new` and `/clear` do not clear `io.trustedMcpTools` (only startup and `/resume` do, in `applyOpened`), although `docs/docs/guides/permission-modes.md` says `/new` clears it. A grant survives into a session the operator believes is fresh.

## Expected Outcome

- A tool whose catalog entry has `destructiveHint === true` never gets a trust option, in the TUI dock or the readline prompt, and a grant that exists for a tool that later reports `destructiveHint: true` is dropped, not honoured. Missing or `false` annotations behave as today: the MCP default for `destructiveHint` is `true`, but annotations are server-supplied and advisory, and treating "absent" as destructive would remove the feature for almost every server. The decision is stated in the docs.
- `/mcp trust list` shows every trusted tool (full name, server); `/mcp trust revoke <tool>` and `/mcp trust revoke all` withdraw grants. Both are visible in the TUI and in the readline `/help`.
- Wherever a trusted tool is shown, it carries a `trusted` marker, including the auto-approve line, which also names the tool.
- `/new` and `/clear` clear the grants, pinned by a test that fails on the old code.

## Out of Scope

- Persisting trust across sessions or to disk.
- Any change to the definition fingerprint (annotations stay out of it on purpose).
- Any change to the untrusted-content floor of 0.3.27.
- Trust for non-MCP tools.
