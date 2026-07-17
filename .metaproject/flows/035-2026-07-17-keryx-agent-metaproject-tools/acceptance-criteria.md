# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Metaproject tools defined — `src/harness/tool/builtin/metaproject-tools.ts` exports `builtinMetaprojectTools(root, run?)` returning three `InteractiveTool`s, all risk `read`, with valid input JSON Schemas: `search_code` ({ pattern: string, path?: string }), `graph_affected` ({ file: string }), and `memory_search` ({ query: string }). Each maps its validated input to a FIXED keryx argv (`["ctx","rg",pattern,...]` / `["gdgraph","affected",file]` / `["memory","search",query]`) and delegates to the injected `run(args)`; no tool ever builds a shell string.
- AC2: Injectable, safe runner — `run` defaults to a real subprocess runner that invokes `keryx` via an argv array (Bun.spawn, never a shell string), with `cwd` = the project root, captures stdout bounded to a cap, and returns `{ isError: true }` (never throws) when the process fails or is unavailable. The runner is injectable so unit tests supply a deterministic fake (no real subprocess/network in tests).
- AC3: Wired into agent mode — `shellCommand`'s agent branch registers the metaproject tools alongside the flow-033 read-only builtins (registry = `[...builtinReadOnlyTools(cwd), ...builtinMetaprojectTools(cwd)]`), so the agent can call them; the flow-033 read-only risk gate auto-allows them (risk `read`). The chat `runShell` core is unchanged.
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1381 pass / 3 skip / 0 fail with the new tests green and 0 fail; the entire suite is OFFLINE/deterministic (tools tested via an injected fake `run`; no real keryx subprocess or network). Unit tests cover: the three definitions (names, risk `read`, schema), correct argv mapping per tool via the fake `run`, and error propagation (`run` failure → `isError`). No new dependency (`dependencies` stays `{}`). A live smoke (`bun src/cli.ts shell --agent`, tool-capable model) shows the agent using `search_code`/`graph_affected`/`memory_search` on the real project — journaled; not a CI gate.
