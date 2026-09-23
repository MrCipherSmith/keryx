# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: When `keryx shell` — or any other surface that starts MCP servers through the shared MCP runtime — launches a server, every environment variable keryx loaded from its saved configuration is removed by name before the server's own configured environment is applied, whatever the variable is called. A test saves a provider key under a custom name that contains none of KEY, TOKEN or SECRET and asserts the launched server does not see it.
- AC2: A server whose own configuration names a variable explicitly still receives it: explicit configuration wins over the strip, and a test shows it.
- AC3: The ACP path, which already strips saved keys, and the shell path use one shared function rather than two copies, and the existing name-pattern strip keeps working.
- AC4: The documentation of MCP servers states which environment a launched server receives and which it does not.
- AC5: CI is green on the PR and `keryx health run` gate is pass.
