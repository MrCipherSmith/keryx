# Grading key — group A, `helyx` at `bfad745b`

The oracle each group-A answer is graded against. Computed **from a worktree of
the pinned commit** with the same 267-node, 656-edge graph every leg is handed —
not from the target's live checkout, which has moved since.

Written down because grading from memory, a day later, is how a benchmark
quietly starts scoring what the grader expects instead of what the case asked.

## A1 — blast radius of `config.ts`

`keryx gdgraph affected config.ts` → **24 direct dependents**:

`bot/access.ts`, `bot/bot.ts`, `bot/callbacks.ts`, `bot/commands/admin.ts`,
`bot/commands/forum.ts`, `bot/commands/model.ts`, `bot/commands/project-add.ts`,
`bot/text-handler.ts`, `claude/client.ts`, `cleanup/jobs.ts`,
`dashboard/auth.ts`, `main.ts`, `mcp/dashboard-api.ts`, `mcp/server.ts`,
`memory/db.ts`, `memory/embeddings.ts`, `memory/long-term.ts`,
`memory/short-term.ts`, `memory/summarizer.ts`, `services/provider-service.ts`,
`tests/unit/summary-normalize.test.ts`, `utils/files.ts`, `utils/transcribe.ts`,
`utils/tts.ts`

Transitive closure: **106** at depth 10 (104 at depth 3 — only `channel.ts` and
`tests/unit/chunk-markdown.test.ts` appear beyond hop 3, so depth 3 is
effectively complete).

## A3 — import cycles

`keryx gdgraph query cycles` → **8 cycles, all inside `bot/`**, hubs
`bot/handlers.ts` and `bot/callbacks.ts`:

1. `handlers → callbacks → commands/menu → commands/codex → text-handler → handlers`
2. `handlers → callbacks → commands/menu → commands/memory → handlers`
3. `handlers → callbacks → commands/menu → commands/project-add → commands/providers → handlers`
4. `handlers → callbacks → commands/menu → commands/project-add → handlers`
5. `handlers → callbacks → commands/menu → commands/session → handlers`
6. `handlers → callbacks → handlers`
7. `handlers → commands/add → handlers`
8. `handlers → media → handlers`

(paths above are relative to `bot/`)

**A "none" answer is wrong here** — unlike A4, where the catalog's honesty note
applies. An agent that declines to compute cycles by hand scores `correctness: 1`
per the catalog; one that asserts there are none does not.

## A4 — orphans (unreachable from any entry point)

`keryx gdgraph query orphans` → **14 files**:

`dashboard/eslint.config.js`, `dashboard/vite.config.ts`,
`dashboard/webapp/vite.config.ts`, `scripts/coverage-summary.ts`,
`tests/e2e/auth.setup.ts`, `tests/global-setup.ts`,
`tests/playwright.config.ts`, `tests/unit/aux-llm-prompt.test.ts`,
`tests/unit/curator-prompt.test.ts`, `tests/unit/forum-topics.test.ts`,
`tests/unit/memory-reconciliation.test.ts`, `tests/unit/permission-flow.test.ts`,
`tests/unit/session-lifecycle.test.ts`, `utils/stream-json-parser.ts`

Note what the set is made of: build configs and test entry points, which are
"orphaned" only in the sense that nothing *imports* them. An answer that says so
is better than one that lists them without the caveat.

## A5 — the memory subsystem, from the project's own documentation

Evidence required: the wiki page **by path** — `.metaproject/wiki/components/memory.md`,
tracked at the pinned commit. An answer reconstructed from `memory/*.ts` is
`plausible`, not `grounded`, however accurate it is: the case asks explicitly for
the documentation, and reconstruct-from-source is exactly what it discriminates
against.

## A12 — dependency path `main.ts` → `orchestrator/gate.ts`

`keryx gdgraph path main.ts orchestrator/gate.ts` → **3 hops**:

`main.ts → mcp/server.ts → mcp/tools.ts → orchestrator/gate.ts`

Any other chain whose consecutive pairs are all real import edges also scores
`grounded` (see the catalog's note on A12). Endpoints without the files between
them is `plausible` — that is what a text search yields.
