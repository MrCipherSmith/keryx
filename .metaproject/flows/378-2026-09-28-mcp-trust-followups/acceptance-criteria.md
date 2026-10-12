# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A tool whose catalog entry has `destructiveHint === true` is never offered trust: the TUI approval dock has no "Trust this tool" option, the readline prompt does not offer it, and the approval meta carries a withheld reason that says the tool is marked destructive. A tool with absent or false annotations is offered trust exactly as before. Verify: execution (dock and prompt tests over both cases).
- AC2: A grant already held for a tool is not honoured once the catalog reports `destructiveHint: true` for it: the call asks like an untrusted one and the stale entry is removed from the map. The annotation is resolved at call time through a resolver on `AgentIO`, since annotations are not part of the definition fingerprint. Verify: execution (executeCall test: grant, flip annotation, call asks, map empty).
- AC3: `/mcp trust list` prints every trusted tool with its full name (`server__tool`) and server, or a line saying none are trusted. `/mcp trust revoke <tool>` withdraws that grant, `/mcp trust revoke all` withdraws every grant, an unknown tool name reports so and changes nothing, and a revoked tool asks again on its next call. Verify: execution.
- AC4: `/mcp trust` is present in `AGENT_SLASH_COMMANDS` metadata, the TUI slash dropdown, the readline `/help` and the TUI help modal; the existing pins (`agent-commands.test.ts`, `agent-commands.confusable.test.ts`, `shell-slash-registry.test.ts`) pass with it and `/mcps` stays unknown. Verify: execution.
- AC5: Every place that shows a trusted tool marks it `trusted`: the approval transcript lines, the `/mcp` view, `/mcp trust list`, and the auto-approve line, which also names the tool it auto-approved. Untrusted tools carry no marker. Verify: execution (render tests) plus site-check of the TUI in a live run.
- AC6: `/new` and `/clear` clear `io.trustedMcpTools`; the new test fails on the code at 0.3.33 and passes on the fix. Startup and `/resume` still clear it. Verify: execution.
- AC7: The trust from 0.3.27 is otherwise unchanged: a trusted tool still asks when its definition fingerprint changed, when it came from untrusted content, or when a hook asked, and its untrusted-content floor is kept. The full existing MCP approval suites pass without edits to their assertions. Verify: execution.
- AC8: Docs and release: `docs/docs/guides/permission-modes.md` documents destructiveHint withholding (with the missing-annotation decision), list/revoke, the marker and the `/new` fix; `docs/docs/cli-reference.md` and the README slash lists carry `/mcp trust`; `.metaproject/modules/mcp.md` mentions session trust; CHANGELOG 0.3.34 and package.json 0.3.34. Verify: site-check.
- AC9: Stop: after 0.3.34 is merged, tagged, installed and smoke-tested, work stops until the operator says whether W1 (external agents live) starts. Verify: reasoning (journal entry).
