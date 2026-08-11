# Context

## Agent Findings

- Agent tools are assembled in `src/commands/shell.ts`: filesystem reads,
  Metaproject tools, `shell_exec`, `ask_user`, and subagents.
- `shell_exec` can make network requests, but always needs approval and is not
  appropriate for automatic research.
- `src/harness/mutation/guard.ts` has lexical private-egress protections. This
  feature must add DNS-aware validation and validate every redirect.
- External output is untrusted: it must be bounded and labelled so it cannot be
  mistaken for trusted project instructions.
- The next flow will add web-search providers (including user-configured local
  SearXNG); it is deliberately outside this flow.
- Brainstorm chose a native read-only tool over the existing shell proxy: it is
  smaller, testable, and gives a single auditable external-content boundary.
  It will allow HTTPS only, validate every redirect, and fail closed when DNS
  is unavailable or returns any non-public address.
