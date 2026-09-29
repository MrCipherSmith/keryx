# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A session-trusted MCP tool no longer bypasses the untrusted-content floor: in a turn where untrusted content has been seen (a web result or any MCP tool result, including one from the trusted tool itself), a `use_tool` call for that tool asks for approval with `untrustedOrigin` set, in `src/commands/agent.ts` executeCall. The test named "a trusted MCP FQN bypasses the untrusted-result latch later in the same turn" is rewritten to assert the opposite, and a second test asserts the trust applies again in the next turn.
- AC2: While the untrusted-content floor is on, the approval prompt never offers the trust option (`mcpTrustAvailable` is not sent), so a tainted turn cannot induce a lasting grant; a test asserts the meta passed to `requestApproval`, and the readline prompt and the TUI dock both omit the option in that case.
- AC3: A trust grant is bound to the tool's definition, not only its qualified name: the session set maps the name to a fingerprint of the definition (name, description and input schema as the catalog reports them). A call whose current definition fingerprint differs from the granted one asks again, and the stale grant is dropped. Tests cover an unchanged definition (no prompt), a changed description (prompt), and a changed input schema (prompt).
- AC4: The trust set and the fingerprint resolution stay session-local and non-persistent: nothing is written to disk, the model cannot add to the set, `/new` and session resume still clear it, and the set is shared with the foreground facade as before. Existing tests for these properties pass unchanged.
- AC5: CHANGELOG documents the hardening as part of the trust feature it modifies, `keryx help` and the README/docs mention the untrusted-content floor and the definition binding wherever the trust option is described, and the TUI dock and readline prompt text says why the option is missing when the floor is on.
- AC6: Follow-ups explicitly out of this flow are recorded as a new flow request in the final report, not silently dropped: `destructiveHint` tools never offering trust, and a `/mcp trust` list/revoke command with a `trusted` marker on the call row in the TUI.
