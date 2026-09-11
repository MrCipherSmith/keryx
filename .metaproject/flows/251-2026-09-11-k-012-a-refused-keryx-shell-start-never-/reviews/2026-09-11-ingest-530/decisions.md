# Decisions

- F-001: acted-on — commit d57ecbec7dd43075cae17c0e4153fbdb24e31f2a: within() clears its timer when the wait resolves (cleared, not unref'd, so the process cannot exit mid-finally); close() returns one shared promise (valid_followup, post_flow_feedback).
- F-002: acted-on — commit d57ecbec7dd43075cae17c0e4153fbdb24e31f2a: src/mcp-servers/runtime-close.test.ts proves a connected fixture server is torn down; the shell test's comment and the changelog now say what actually happens (valid_followup, post_flow_feedback).
