# Graph freshness is not routed: index.md, the entrypoint block and the post-commit hook never tell an agent to rebuild

Status: formalized
Source: user description

## Problem

The code graph goes stale silently, and nothing in the agent-facing routing surface says so.

- `.metaproject/index.md` mentions refresh twice, both generic: workflow item "Run module CLI
  commands when generated data is stale", and a `## Refresh` code block. Neither says *when* the
  graph is stale, nor that a graph answer computed after the agent itself added/renamed/deleted
  files is wrong.
- The `<!-- keryx:index -->` block in `AGENTS.md` / `CLAUDE.md` routes navigation to gdgraph but
  never mentions rebuilding. graphify, by contrast, writes an always-on rule into the project
  entrypoint that tells the agent to rebuild after code changes, and installs a post-commit hook
  that actually rebuilds.
- `modules/gdgraph.md` documents commands and data, but has no freshness contract: what invalidates
  the graph, how staleness is observed, how it is repaired.
- The freshness signal that *does* exist is buried: `keryx gdgraph context` / `keryx orient` print
  `freshness: N uncommitted code file(s) may not be reflected` from `src/ctx/orient.ts:127`.
  Nothing routes an agent to it.
- The gdgraph post-commit hook is non-mutating: it only prints "gdgraph may be stale; run
  'keryx gdgraph build'". `skills/gdgraph/SKILL.md` "Refresh Policy" states the opposite —
  "Git `post-commit` hook refreshes graph after relevant file changes" — a claim the hook body
  does not support.

## Expected Outcome

- `modules/gdgraph.md` carries a `## Freshness & Refresh` section: what invalidates the graph, how
  staleness is observed, how it is repaired, and what an agent must do before trusting a graph
  answer.
- `.metaproject/index.md` routes graph staleness explicitly: an Agent Workflow item and an Intent
  Router row, both pointing at that section.
- The `<!-- keryx:index -->` block in `AGENTS.md` / `CLAUDE.md` carries the same rule, so it is in
  front of the agent without opening the index.
- The gdgraph post-commit hook actually rebuilds the graph after a graph-relevant commit, instead of
  printing a reminder, and stays non-blocking (always exit 0) and opt-out-able.
- `skills/gdgraph/SKILL.md` "Refresh Policy" describes what the hook really does.
- This repository's own generated `.metaproject` files are regenerated from the local source, not
  from the stale keryx on PATH.

## Out of Scope

- The wiki freshness machinery of flow 226 (change classification, impact propagation, freshness
  queue). This flow only routes the *graph* refresh that already exists.
- Incremental/partial graph rebuild. The hook calls the existing full `keryx gdgraph build`.
- Symbol-layer defaults; the opt-in stays opt-in.
