# Metaproject layers in review

Status: draft (PRD and acceptance criteria go to the operator before freeze)
Source: user description (origin: human-request)

## Problem

A managed review is supposed to use the project's own memory of itself: the code graph (what a change reaches), the wiki (why the code is shaped this way), project memory (decisions and past mistakes) and the routed context tools. On the PR 7659 live run (2026-10-12, flows 419/428) the audit asked whether those layers helped. They did not, for reasons that can be fixed mechanically:

1. **The graph is stale and nobody checks.** The graph the shell used was built 2026-10-08 at commit 10a15bb on `fix/7546-dialog-validity`; the review was on another head. `keryx review blast-radius` loads whatever graph is on disk (`src/commands/review.ts`, `runBlastRadius`) and refuses only an EMPTY graph. A graph built for another commit gives a confident, wrong radius. The tracked `.metaproject/data/gdgraph/.provenance.json` on `origin/main` itself names commit 8eaec2e on a flow branch.
2. **A fresh worktree has no graph at all.** `.metaproject/data/**/storage/` is gitignored, so a worktree made for a PR head has the tracked artifacts (summary, module map) but no `nodes.jsonl`. The first graph call there is an empty-graph refusal, or, in the original checkout, a graph of the wrong branch.
3. **The wiki and memory come along stale.** `.metaproject/wiki` (101 tracked files) and the memory index are tracked, so a worktree holds the copy as of that commit; nothing says how old it is relative to the code under review.
4. **Reviewers never reach for the layers.** None of the 18 reviewer skills (`review-logic`, `review-regression`, ...) mentions the graph, the wiki or memory; reviewers reported `graph_context` as unavailable and made zero wiki, memory or graph calls. Tool counts of the shell run: `read_file` 1370, `search_code` 397, `shell_exec` 349, `list_dir` 254, graph/wiki/memory 0. The only consumer of the graph in the whole review path is `blast-radius`.
5. **The blast radius is cut and the cut is never read.** The cap (default 40 files, depth 2) kept 40 of 793 candidate files on PR 7659. The dropped files are recorded, but no pass looks at them and nothing in the report says they were not looked at.
6. **Nobody can tell which layer a reviewer used.** There is no record per reviewer, so "did the graph help" can only be answered by reading transcripts.

## What the layers cost (measured, not assumed)

The operator proposed a cheap model to refresh the graph and the wiki before each review. Checked in this repository (`origin/main`, 3,002 nodes, 10,493 edges):

| Step | Needs a model | Cost |
|---|---|---|
| `keryx gdgraph build` | **No.** File-level graph plus tree-sitter symbols; no provider code in `src/gdgraph/build.ts`, `staleness.ts` or `enrich.ts`. | 17 s wall clock |
| `keryx wiki refresh` | **No.** The module header states "NOTHING HERE CALLS A MODEL"; it repairs the machine-written Reference sections and stamps provenance. | not measured yet (T1) |
| `keryx wiki collect --force` | No (the same renderer as refresh). | not measured yet (T1) |
| `keryx memory index` | No without `--embeddings`; embeddings are optional. | not measured yet (T1) |
| `keryx wiki enrich` | **Yes.** It writes prose and needs a provider credential (`--provider`, `--model`; skips pages without one). | per page, model cost |

So no cheap model is needed for the refresh the operator described: it is deterministic and fast enough to run before every review. The only step that needs a model is prose enrichment of the wiki; it stays out of the automatic path, and the refresh reports how many pages hold stale prose instead of rewriting them.

One side effect to settle before freeze: `gdgraph build` rewrites three TRACKED files (`.provenance.json`, `artifacts/module-map.json`, `artifacts/summary.md`), so a refresh in a review worktree dirties it. The plan keeps the build output of a review outside the tracked files (see Open questions).

## Expected Outcome

Before a managed review starts, the layers are rebuilt or checked at the review head, and the package records exactly which commit each layer describes. A review whose graph describes another commit is refused (or, with an operator quote, run with the mismatch recorded). Each reviewer gets the graph's answer for its own files in its payload (affected files, symbol neighbours, related tests, matching wiki pages and memory entries), is told by its skill when to call the layer tools, and the package records, per reviewer, which layers it actually used, counted from its tool calls. The files the blast radius cut get a second pass or an explicit "not reviewed" record the gate reads.

## Outcome criteria

- Запрос (дословно): «Давай вынесем в отдельный флоу все, что касается использования метапрожекта. Допустим, операция по перестройке графа, она не такая большая, и мы вполне можем на какой-нибудь дешевой модели перед каждым ревью делать, обновлять этот граф. Если, допустим, мы в Work3 созданном или в Вики, доступ должен быть тоже. можем переиндексировать вики, тоже это не сложная операция, вынеси это в отдельный флоу» (source: helyx chat message 199906, 2026-10-12T15:38Z, voice transcript; the audit that preceded it: message 199859 «также еще проверь как используются wiki, graph и другие инструменты именно метапроджекта используются ли они как-то для review и помогают ли они»)
- Эффект (формализация агента): `keryx review` on a pull request first refreshes the graph, the wiki's machine sections and the memory index at the review head with no model call, records a layers file (commit, time, node/edge counts, wiki pages refreshed and stale-prose count, memory entries) in the package, and refuses to dispatch when the graph's commit is not the review head. Every driver payload carries the affected files, related tests, wiki pages and memory entries for that reviewer's files; reviewer skills name the commands to call; the package records graph/wiki/memory/ctx use per reviewer from the tool-call log; the files cut by the blast-radius cap are reviewed in a tail pass or listed as not reviewed, and `review complete` reads that list.
- Как наблюдать (предложение агента): `keryx review layers <package>` prints, for the review head, the commit each layer was built at (equal to the head), per-reviewer layer-use counts, and the number of blast-radius files reviewed versus cut; the `/reviews` modal's Review depth tab and the sidebar panel show the same lines; a rerun on PR 7659 shows non-zero graph and wiki use for the reviewers whose files are in the graph, and the graph commit equal to the PR head.

## Open questions for the operator

1. Refusal or warning when the graph commit differs from the review head: AC2 proposes a refusal with a quote override. Agree?
2. Which `.metaproject` does a review of a PR read: the operator's project (wiki, memory, rules from the working copy) with the graph built at the PR head, or everything from the PR head's checkout? AC3 assumes the first for wiki and memory and the second for the graph.
3. Tail pass (AC7): cap and tier. Proposal: one tier down from the session model, at most 150 files or 400 KB per review, the rest recorded as not reviewed and blocking `complete` without a quote.
4. Should `wiki enrich` ever run automatically before a review (smallest tier, stale pages only, off by default), or stay manual?
5. `layersUsed` for reviewers whose tool-call log is unavailable: record `unknown` (proposal) or refuse the package?

## Out of Scope

- Rewriting wiki prose automatically (`wiki enrich` stays an explicit, credentialed command; the refresh only reports stale prose).
- Changing the blast-radius algorithm (depth 2, edge ranking). The flow changes what happens to the cut files, not how the set is derived.
- The tool surface of the shell (`read_file` windows, `search_code` honesty, `glob`, `edit`): a separate flow.
- Reviewer prompts beyond the layer instructions (depth parity is flow 428, slices and ledger parsing is flow 430).
- Judging whether the layers raise review quality on PR 7840 (control run stays with flow 428 AC10).
