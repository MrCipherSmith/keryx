# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `createMetaprojectAdapter`'s `repomap` no longer calls the writing gdgraph service `repomap`/`writeRepomap`; it computes the map via the PURE `computeRepomap` (over a loaded graph + gdgraph config) and writes NO artifact. The compute path is injectable via `MetaprojectAdapterDeps` (a defaulted `repomapCompute`), defaulting to the non-writing load-graph + load-config + `computeRepomap` implementation. The method stays deterministic and never throws (a backing error → a structured error result).
- AC2: A unit test drives `repomap` with an INJECTED compute fake and asserts the mapped RepomapResult (files/tokens/omitted/budget) is returned, and that no write path is invoked (the fake records that it, not `writeRepomap`, produced the result). No real graph build, subprocess, or filesystem write occurs in the test.
- AC3: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1446 pass / 3 skip / 0 fail with the updated/new tests green and 0 fail; `dependencies` REMAINS `{}`; the `repomap` operation stays risk `read` / mutating false (now truly read-only); the other operations, the port result shapes, the projections, and the chat core are unchanged.
