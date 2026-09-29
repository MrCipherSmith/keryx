# PR #789 security review (flow359-pr789-review)

No exploitable bypass found. Two minor findings, both on the readline surface and both fail-closed.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow359-pr789-review",
    "severity": "minor",
    "problem": "The readline fingerprint resolver and trust-offer resolver read deps.mcpRuntime, but the readline agentDeps never set mcpRuntime (only the TUI makeAgentDeps did). The resolvers therefore always returned undefined.",
    "impact": "On the readline surface the T=trust option is never offered and no grant can be stored. It fails closed, so it is not a bypass, but the readline trust path is dead.",
    "suggested_fix": "Add `mcpRuntime: () => mcpRuntime,` to the readline agentDepsBase in shellCommand.",
    "evidence": "src/commands/shell.ts:2120 reads deps.mcpRuntime; the readline agentDepsBase contained no mcpRuntime, only `mcp: mcpRuntime` for the tool roster.",
    "confidence": "medium",
    "file": "src/commands/shell.ts",
    "line": 2120,
    "quote": "agentIo.mcpToolFingerprint = (fqn) => catalogFingerprintResolver(deps.mcpRuntime?.()?.catalog())(fqn);",
    "class_scope": {
      "sites": [
        "src/commands/shell.ts:runAgentRepl (mcpToolFingerprint and the requestApproval catalogResolver call)",
        "src/commands/shell.ts:shellCommand agentDepsBase"
      ],
      "enumeration_method": "rg -n mcpRuntime src/commands/shell.ts, compared the fields set on the TUI and readline deps objects"
    }
  },
  {
    "id": "F-002",
    "reviewer": "flow359-pr789-review",
    "severity": "minor",
    "problem": "The readline /new and /clear cleared trustedMcpTools only inside switchNewSession, which runs only when sessions are on. With sessions off the branch reset history but left the trust map intact.",
    "impact": "In a sessions-off readline shell, an MCP tool trusted before /new keeps skipping approval after the conversation is cleared. Still bound to the definition fingerprint, the untrusted floor and read-only.",
    "suggested_fix": "Call agentIo.trustedMcpTools?.clear() in the sessions-off branch of /new and /clear.",
    "evidence": "src/commands/shell.ts:2231 clears the map inside switchNewSession; the else-branch at 2672-2676 did not.",
    "confidence": "medium",
    "file": "src/commands/shell.ts",
    "line": 2231,
    "quote": "agentIo.trustedMcpTools?.clear();",
    "class_scope": {
      "sites": ["src/commands/shell.ts:runAgentRepl /new,/clear sessions-off branch"],
      "enumeration_method": "Read every readline command branch that resets history in runAgentRepl"
    }
  }
]
```
