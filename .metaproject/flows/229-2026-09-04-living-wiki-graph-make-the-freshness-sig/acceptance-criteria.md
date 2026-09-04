# Acceptance Criteria

- AC1: `wiki freshness`, `wiki refresh`, `wiki verify` and
  `wiki migrate-markers` appear in `keryx commands --json` with accurate
  `read`, `json` and `sideEffects`.

- AC2: `wiki freshness` is registered `read: true` with no side effects; the
  other three are `read: false` and name what they write.

- AC3: An MCP surface returns the last freshness report including its
  `limitations`, so an agent sees "the graph was not built" rather than an
  empty finding list.

- AC4: With no report on disk, the MCP surface returns the not-measured
  status and its reason — never a fabricated clean result.

- AC5: The MCP path writes nothing, proven by comparing the project tree
  before and after a call.

- AC6: `skills/gdwiki/SKILL.md` instructs a reader to consult the freshness
  report before treating a page as context, and to carry the caveat when the
  page is `stale-*`.

- AC7: `bun test` passes with no new failures relative to the merge-base,
  compared in a worktree rather than asserted.
