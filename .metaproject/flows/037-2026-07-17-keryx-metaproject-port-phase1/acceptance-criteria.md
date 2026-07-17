# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/harness/tool/metaproject-port.ts` defines a `MetaprojectPort` interface with content-returning methods `searchCode({pattern,path?})`, `graphAffected({target,depth?,ranked?})`, `graphQuery({query})`, `memorySearch({query,module?,status?,limit?})`, `readWiki({path})`, and `describeContext()`, plus their result types, aligned with the docpack schemas (graph-affected-result / memory-search-result). Pure type/interface module (no side effects).
- AC2: `src/harness/tool/metaproject-adapter.ts` exports `createMetaprojectAdapter(cwd, deps?)` returning a `MetaprojectPort` whose `graphAffected`/`graphQuery` delegate to `createGdgraphService()` and `memorySearch` delegates to `createMemoryService()` IN-PROCESS, and whose `readWiki` reads files under `.metaproject/wiki/` confined to the project root (rejecting `..`/absolute escapes). The service factories are INJECTABLE via `deps` so unit tests use fakes (no real graph build, no subprocess, no network). The adapter is deterministic (no `Date.now`/`Math.random`). Unit tests cover graphAffected + memorySearch via injected fakes and a readWiki path-escape rejection.
- AC3: `builtinMetaprojectTools(root, port?)` (src/harness/tool/builtin/metaproject-tools.ts) uses the injected `port` IN-PROCESS when provided — `search_code`/`graph_affected`/`memory_search` return structured content from the port — and falls back to the existing subprocess runner when `port` is omitted (backward compatible). `src/commands/shell.ts`'s agent branch constructs `createMetaprojectAdapter(cwd)` and passes it. Unit test: with an injected fake port, the tool invokes the port (not a subprocess) and returns its formatted output.
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1394 pass / 3 skip / 0 fail with new tests green and 0 fail; the whole suite is OFFLINE/deterministic (injected fakes; no real subprocess/graph/network); `dependencies` REMAINS `{}`; the chat `runShell` core, the subprocess fallback path, and the existing metaproject-tools tests are unchanged. A live smoke (`bun src/cli.ts shell --agent`, tool-capable model) shows the agent using the in-process metaproject tools — journaled; not a CI gate.
