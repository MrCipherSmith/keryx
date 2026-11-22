---
name: openspec-read
description: |
  Use when browsing OpenSpec requirements, active changes, archived changes,
  or their source evidence in the current checkout.
  NOT for authoring, applying, or archiving OpenSpec changes.
triggers:
  - "browse OpenSpec specs"
  - "search OpenSpec requirements"
  - "read an archived OpenSpec change"
  - "найди требование в OpenSpec"
metadata:
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Read OpenSpec

Use the checkout containing the question as the working directory. The reader is
local and read-only; it does not execute OpenSpec tools or modify source files.

1. Discover entries with `keryx openspec list --kind spec|change|archive --json`.
2. Find a requirement or section with `keryx openspec search "<query>" --json`.
   Use `--scope archive` or `--scope all` to include archived changes.
3. Open an entry with `keryx openspec show <relative-path> --json`; add
   `--artifact <relative-path>`, `--section <id>` and
   `--expected-digest <sha256>` from the search result for exact evidence.
4. Follow `nextCursor` with `--cursor` for additional list or search pages.
   If a cursor is stale, repeat the query from the beginning.

## Verification

Cite the returned checkout-relative source paths and line ranges. Report any
unresolved syntax, missing sources or partial results that limit the answer.
