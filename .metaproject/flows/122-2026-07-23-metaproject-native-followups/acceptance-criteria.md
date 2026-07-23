# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `RunDeps` (src/harness/run/run.ts) exposes an OPTIONAL `metaprojectPort?: MetaprojectPort` that `runOffline` accepts and forwards; a test proves that when it is undefined, run behavior is unchanged (existing run tests pass plus one explicit "no port => unchanged" assertion).
- AC2: a policy decision call-site consults `escalateForBlastRadius` ONLY when the run supplies both a `metaprojectPort` and a configured blast-radius threshold; a unit test proves (a) allow→ask when affected count exceeds the threshold and (b) decisions unchanged when no port or no threshold is provided; no `Date.now()`/`Math.random()` introduced.
- AC3: `wikiBacklinks` is a `MetaprojectPort` method backed by the existing `src/wiki` `backlinksFor`, AND a `METAPROJECT_OPERATIONS` descriptor (module wiki, risk read) present in the agent (`toInteractiveTools`), harness (`toToolDefinitions`), and MCP (`toMcpTools`) projections; its result validates against a JSON schema; a test asserts the adapter method works and the op appears in all three projections.
- AC4: `bunx tsc --noEmit` is clean; targeted `bun test` for the touched suites is green; `package.json` `dependencies` remains `{}` (zero new runtime deps).
- AC5: the three out-of-scope items (flow-transition write op, legacy MCP adapter retirement, in-process search facade) are recorded in `journal.md` with rationale and no partial/broken code is left for them.
