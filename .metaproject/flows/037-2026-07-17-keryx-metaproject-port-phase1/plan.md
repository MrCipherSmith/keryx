# Implementation Plan

Status: formalized

## Approach

Port-and-adapter (matching ProviderPort/ToolExecutorPort). Define MetaprojectPort;
back it with the existing gdgraph + memory service facades in-process; make the
agent's metaproject tools port-aware with a subprocess fallback. TDD via
task-implementer; verify via code-verifier.

## Steps

1. `src/harness/tool/metaproject-port.ts`: interface + result types (deterministic,
   content-returning), aligned to docpack schemas.
2. `src/harness/tool/metaproject-adapter.ts`: `createMetaprojectAdapter(cwd, deps?)`
   with INJECTABLE service factories (default: real createGdgraphService /
   createMemoryService) so tests use fakes; readWiki reads wiki files root-confined.
3. `src/harness/tool/builtin/metaproject-tools.ts`: add optional `port` param; when
   present, tools call the port and format structured output; else subprocess.
4. `src/commands/shell.ts`: agent branch builds the adapter and passes it.
5. Tests: adapter (injected fakes), tools (injected port), no-regression.

## Risks

- Determinism: services touch fs; keep the port injected and the harness core
  clock/random-free. Adapter tests use injected fakes (no real graph build).
- Backward compat: the subprocess fallback stays; the existing tests must remain
  green.
