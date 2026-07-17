# Implementation Plan

Status: formalized

## Approach

Reuse the flow-033 `InteractiveTool` interface. A new
`src/harness/tool/builtin/metaproject-tools.ts` exports
`builtinMetaprojectTools(root, run?)` where `run(args) => Promise<{output,isError}>`
defaults to a real keryx subprocess runner (Bun.spawn `["keryx", ...args]`, argv
array, cwd=root, bounded stdout) and is INJECTABLE so tests are deterministic
(no real subprocess). Wire the tools into the agent registry in `shellCommand`.

## Steps

1. `metaproject-tools.ts`: `search_code`/`graph_affected`/`memory_search` tools
   (risk `read`), each mapping validated input → fixed argv → `run(args)`.
2. Injectable `run` (real = Bun.spawn keryx, bounded, errors→isError).
3. `shellCommand` agent branch: registry = builtinReadOnlyTools + metaproject.
4. Tests: definitions (names/risk/schema) + invoke with a fake `run` (arg mapping,
   error propagation). tsc + full bun test; live smoke.

## Risks

- Subprocess safety — argv array (never a shell string) blocks injection; command
  + subcommand are fixed, only args vary. Documented as constrained-read.
- keryx binary/data availability — tools return the CLI's error/empty gracefully
  (no throw); a stale global keryx still operates on the cwd's .metaproject.
