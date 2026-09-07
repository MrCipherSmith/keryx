# Контекст этапа 3
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 2. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

---

# Implementation inventory — phase 3 (AC1..AC9)

Recorded 2026-09-07. Read-only survey. Every "measured" line below was driven
through a live surface on this checkout at main@0bc6418 + the working tree of
`codex/agent-first-core`; every "inferred" line is marked as such. Historical
PASS is not evidence here and none is cited.

Normative sources read in full: `docs/requirements/keryx-agent-first-core/prd.md`
(AFC table rows 07/12/14/30/M03/M04/W01/W02/W04),
`specification.md` §3 (envelope + M03 codes), §5 (graph/repomap), §6 (ctx,
budget, loss manifest, continuation), `wiki-specification.md` §2 (W01 section
identity), §3 (W01/M04 retrieval), §4 (W02 templates), §6 (W04 evidence),
`decision-traceability.md` (the frozen AC text).

## 0. How the surfaces were enumerated

Not by guessing. Three registries were listed:

1. **CLI** — `bun src/cli.ts <module> --help` for `wiki`, `ctx`, `gdgraph`.
   Gives the complete user-facing subcommand list for each module.
2. **MCP** — the tool registry in `src/mcp/tools.ts` (23 entries, listed by
   name) plus the unified projection `toMcpTools()` in
   `src/mcp/metaproject-tools.ts`, which was *executed* to print the live
   projected names (16 entries).
3. **Agent / harness** — `METAPROJECT_OPERATIONS` in
   `src/harness/tool/metaproject-operations.ts` (16 named ops), the single
   source projected into three consumers: the interactive agent
   (`toInteractiveTools`), the harness `ToolRegistry` (`toToolDefinitions`),
   and MCP (`toMcpTools`). The typed contract is
   `src/harness/tool/metaproject-port.ts`; the reference implementation is
   `src/harness/tool/metaproject-adapter.ts`.

Live projected agent/MCP operation names (measured, printed from
`toMcpTools()`):
`search_code, graph_affected, graph_query, memory_search, read_wiki,
wiki_freshness, graph_path, test_related, health_status, graph_symbol,
repomap, wiki_ask, wiki_backlinks, flow_status, skills_catalog, skill_load`.

MCP-only tools relevant to this phase (from `src/mcp/tools.ts`):
`wiki.query`, `wiki.ask`, `gdgraph.affected`, `gdgraph.cycles`,
`gdgraph.orphans`, `memory.search`.

**Surfaces that do NOT exist** (measured absence — this matters more than the
list above):

- No `graph_find` / `gdgraph.find` operation on any agent or MCP surface.
  `keryx gdgraph find` is CLI-only. The description-only query path AC6 names
  has no agent surface at all.
- No `ctx.*` operation on any agent or MCP surface. `keryx ctx read` /
  `ctx run` / `ctx diff` / `ctx show` are CLI-only. The only agent path to
  compact context is `search_code`, which is `keryx ctx rg` behind a
  subprocess fallback.
- `MetaprojectPort.repomap` accepts `{ budget?: number }` **only** — no
  `seed`, no `mode`. Verified against the op's own `inputSchema`, printed
  live: `{"type":"object","properties":{"budget":{"type":"integer","minimum":1}},"additionalProperties":false}`.
  Seeds exist only on `keryx gdgraph repomap --seed` (CLI).

## 0b. Two cross-cutting findings that change the shape of the whole phase

**(A) A live capability that no live path calls — the recurring class, found
again, and this time on the tool the project's own routing tells agents to
use.**

`src/mcp/metaproject-tools.ts::toMcpTools()` builds its port with
`createMetaprojectAdapter(cwd)`. That adapter's `searchCode`
(`src/harness/tool/metaproject-adapter.ts:308-315`) is a permanent stub:

```
output: "search_code has no in-process backing (use the subprocess runner)."
isError: true
```

The interactive/harness path wraps the port with `withSearchFallback`
(`src/harness/tool/builtin/metaproject-tools.ts:121-154`) which retries via
`keryx ctx rg`. **MCP does not wrap it.** Measured on the live projection:
`search_code` over MCP returns `isError: true` for every pattern, including
one with real matches (`wikiAsk`). Code search over MCP is dead.

**(B) The required-item / mandatory-overflow / loss-manifest primitive AC2 and
AC4 ask for already exists, is tested, and is unreachable from any surface in
this phase.**

`src/ctx/assembly.ts` (60 lines) implements exactly the contract: `required`
vs optional candidates, `ContextOverflow = { code: "context_overflow",
requiredId }`, `omittedOptional` as the manifest, a `partial` flag, and a
persisted metadata-only trace. Its only callers (measured) are
`src/sac/fwk-service.ts`, `src/sac/fwk-explain.ts` and `src/session/slate.ts`
— and slate.ts's own comment records that it passes no `required` candidate,
so even that consumer never exercises the overflow branch. Neither `ctx`,
nor `repomap`, nor `wiki ask` imports it, despite it living under `src/ctx/`.

Consequence for planning: AC2's and AC4's overflow requirements are a
**wiring plus required-set-definition** problem, not an invention problem.
Budget the design of "what counts as required", not the primitive.

---

## AC1 — AFC-07: full-text baseline

**Norm.** `prd.md`: wiki searches locally *within Markdown sections*;
sources/versions/budget mandatory; a weak signal yields
`insufficient-evidence`; embeddings not required.
`wiki-specification.md` §2: the index covers "Details, Main flows,
Constraints and arbitrary substantive sections", page/section titles, exact
identifiers, logical paths and explicit aliases.

**Surfaces (all three reach one implementation, `src/wiki/ask.ts::wikiAsk`).**

| Surface | Entry | Enumerated via |
|---|---|---|
| CLI | `keryx wiki ask "<q>" [--k] [--rerank] [--as-of] [--json]` | `bun src/cli.ts wiki --help` |
| MCP | `wiki.ask` → `createGdWikiService().ask` | `src/mcp/tools.ts:718` |
| Agent/harness/MCP-unified | op `wiki_ask` → `MetaprojectPort.wikiAsk` → `src/harness/tool/metaproject-adapter.ts:651` → `wikiAsk` | `METAPROJECT_OPERATIONS` listing |

**Measured current behaviour.**

- **The corpus is title + the first paragraph of `## Summary`. Nothing else.**
  `wikiCandidates` (`src/wiki/ask.ts:442-446`) scores over
  `` `${page.title} ${page.summary}` ``; `summary` comes from
  `extractSummary` (`src/wiki/collect.ts:172-195`), which reads only the
  lines between `## Summary` and the next heading. Details / Main flows /
  Constraints are never indexed.
- Measured: `keryx wiki ask "spawnSync"` → `citations: []`. The term appears
  in the Details section of `.metaproject/wiki/architecture/os-sandbox.md`.
  `keryx wiki ask "bubblewrap"` DOES hit that page — because "bubblewrap"
  happens to appear in its Summary. This is the AC1 condition failing
  exactly as written.
- **A meaningless query gets a confident answer.** Measured:
  `keryx wiki ask "the of and is a"` returns 8 citations, top score `0.154`
  — the *highest* score observed in this corpus, above any real term query
  (`"bubblewrap"` scores `0.015`). `scoreByQuestion`
  (`src/wiki/ask.ts:158-170`) is raw Jaccard over unfiltered token sets with
  no stopword list and no IDF, so common function words score highest. The
  rendered answer is ordinary confident prose: "Based on the project's own
  wiki and memory: 1. **Project Map** — …". No caveat, no code, exit 0.
  Note `src/gdgraph/find.ts:27-29` already has a `STOP` set; `ask.ts` does
  not import it.
- A pure-nonsense query (`"zorblax frimbulator quixnark"`) does return
  `citations: []` — so the failure is specifically **stopword/common-token
  inflation**, not "everything matches".
- RU/EN: there is a hardcoded 36-entry RU→EN table (`RUSSIAN_TO_ENGLISH`,
  `src/wiki/ask.ts:40-75`) plus a heuristic suffix stripper, used only as a
  fallback when the Russian query scored zero. Measured on
  `"какая политика безопасности"` it produced `"which policy безопасности"`
  — a partial mistranslation — and **persisted it** (see AC4).
- No `insufficient-evidence`, no `no-match`, no budget, no source versions
  anywhere in the result type (`WikiAskResult` = question/citations/answer).

**Already holds:** nothing in AC1. The nonsense-query half is *half* right
(pure nonsense yields empty) but fails on the realistic case.

**Files that would change (Lane A).** `src/wiki/ask.ts`,
`src/wiki/collect.ts`, `src/wiki/types.ts`, plus new
`src/wiki/section-index.ts`; tests `src/wiki/ask.test.ts`,
`src/wiki/collect.test.ts`.

**Defect-class exposure.**
- *Helper nothing calls:* yes — the stopword set in `src/gdgraph/find.ts`.
- *Failure indistinguishable from empty success:* yes, and inverted: a
  zero-information query is rendered as a high-confidence hit list. This is
  the worse direction of the same class.

---

## AC2 — AFC-12: repomap

**Norm.** `prd.md`: dependency/impact/balanced with an explainable choice;
default **impact** for a change intent; score-zero does not fill the budget;
mandatory seeds protected. `specification.md` §5: selection is deterministic
and shows a `reason` (`seed`, `dependency`, `consumer`, `test`,
`wiki-binding`); fixtures/generated do not by default displace production;
"если [seed и обязательные ограничения] не помещаются целиком,
`budget-exceeded`, а не успех с урезанным обязательным контекстом".

**Surfaces.**

| Surface | Entry | Note |
|---|---|---|
| CLI | `keryx gdgraph repomap [--budget N] [--seed <path>...] [--changed]` | `src/commands/gdgraph.ts` → `writeRepomap` |
| Agent/harness/MCP | op `repomap` → `MetaprojectPort.repomap({budget})` → `repomapCompute` | **no seed, no mode** |
| MCP (bespoke) | none | `src/mcp/tools.ts` has no repomap entry |

**Caution for implementers: `keryx gdgraph repomap` WRITES a tracked file**
(`.metaproject/data/gdgraph/artifacts/repomap.md`, via `writeRepomap`). The
agent op uses the non-writing `computeRepomap`. This asymmetry was hit during
this survey and the artifact had to be restored from HEAD. Drive measurements
through `computeRepomap` / the port, not the CLI.

**Measured current behaviour** (all via `computeRepomap` on the live graph,
1197 file nodes).

- **No modes at all.** There is no dependency/impact/balanced switch anywhere
  in `src/gdgraph/repomap.ts`. Rank flows `from → to`
  (`src/gdgraph/pagerank.ts` header comment), i.e. the map surfaces
  widely-**depended-on** files. The impact direction AC2 wants as the default
  is not implemented.
- **No `reason` field.** Measured: entry keys are exactly
  `["path","score","symbols"]`.
- **A single seed survives; multiple seeds are silently evicted.** Measured
  with 6 explicit seeds:
  - budget 200 → 1 entry kept, **5 of 6 seeds dropped**, result is an
    ordinary success with `omitted: 1196`.
  - budget 400 → 3 of 6 seeds dropped.
  - budget 800 → all 6 present.
  There is no `budget-exceeded`, no mandatory-overflow, and nothing in the
  result distinguishes "a required seed was dropped" from "the tail was
  trimmed".
- **A seed that matches no node is silently ignored.** Measured with
  `seed: ["does/not/exist.ts"]` → 3 entries, `omitted: 1194`, no diagnostic.
  `computeRepomap` line 125 does a `find(...)` and simply skips a miss.
- **Known consumers of the seed are absent.** Measured for seed
  `src/wiki/ask.ts` at budget 4000 (76 entries): the graph knows 7
  dependents (`keryx gdgraph affected` returns all 7 correctly), and
  **1 of 7** is present in the map — `scripts/benchmark/run-gdwiki-oracle.ts`.
  The live consumers `src/commands/wiki.ts`, `src/wiki/service.ts`,
  `src/harness/tool/metaproject-adapter.ts` and the related test
  `src/wiki/ask.test.ts` are all missing, while a benchmark script is kept.
  That is simultaneously the "consumers/tests evicted" failure and the
  "fixtures/generated displace production" failure.
- **Zero ballast:** no entry scores exactly 0 (uniform teleport floor). But
  the tail is a long block of *identical* scores (`0.00033882180488760915`
  across the whole `vscode-extension/` tree), and `personalizedPageRank`
  documents its tie-break as "score desc, then **id asc**". So at any budget
  the cut runs through a tied block ordered alphabetically. Alphabetical
  eviction is real; "zero ballast" is technically satisfied by a floor value
  that carries no information, which is the same defect under a different
  number.

**Already holds:** determinism; a single seed at a workable budget; the
`omitted` count exists as a scalar.

**Files that would change (Lane B).** `src/gdgraph/repomap.ts`,
`src/gdgraph/pagerank.ts`, `src/gdgraph/repomap.test.ts`; the `repomap`
descriptor in `src/harness/tool/metaproject-operations.ts` (contended, see
§Contention); the repomap branch of `src/commands/gdgraph.ts` (contended with
Lane E). Consumes `src/ctx/assembly.ts` **read-only**.

**Defect-class exposure.**
- *Helper nothing calls:* yes, twice — `src/ctx/assembly.ts`'s overflow
  primitive, and `gdgraph affected`, which already returns the correct
  consumer set that repomap does not use.
- *Failure indistinguishable from empty success:* yes — a dropped required
  seed and an unresolvable seed are both plain `ok` with a bigger `omitted`.

---

## AC3 — AFC-14: ctx preservation

**Norm.** `prd.md`: strategy by format, question and budget; critical fields
preserved; disclosure addressable; delta only from a known consumer
snapshot. `specification.md` §6: JSON → *schema-valid* summary; critical
structural fields (`exitCode`, failed-test count, error records, mandatory
contract keys) compared before/after, and on loss compression is relaxed,
then an error/partial is returned; a small input within budget is returned
without extra wrapping; no base → ordinary view **with a reason**.

**Surfaces.** CLI only: `keryx ctx read <file> [--mode outline|compact|full]`,
`keryx ctx run -- <cmd>`, `keryx ctx rg`, `keryx ctx diff`,
`keryx ctx show latest [--raw]`, and the routing hook `keryx ctx hook
<runtime>` (which is what actually intercepts agent commands — see
`src/ctx/hook.ts`, `src/ctx/hook-classify.ts`). There is no agent/MCP `ctx`
operation; the hook is therefore the highest-traffic consumer.

**Measured current behaviour.**

- **Exit code is preserved.** `keryx ctx run -- bash -c 'exit 7'` → process
  exit 7; `exit 0` → 0. The rendered summary also prints `Exit code: 7`.
  **This half of AC3 already holds.**
- **A failure in the middle of a large log is silently lost.** Measured:
  a 5002-line log with `not ok 2501 - THE MIDDLE FAILURE` and
  `FAIL src/mid.test.ts` at line ~2501, read with
  `keryx ctx read <file> --mode compact` → the failure lines appear **0
  times** in the output. The footer says `compacted: 172,847 → 3,917 bytes
  (98% saved)` and nothing says a `not ok`/`FAIL` line was dropped.
  The same content through `keryx ctx run -- cat <file>` **does** preserve
  it. So failure-aware extraction exists on `ctx run` and not on `ctx read`
  — an agent told to "read the test log" loses the failure; an agent told to
  "run the tests" does not.
- **Compacted JSON is not valid JSON.** Measured on a 1,073,591-byte JSON
  file: `keryx ctx read --mode compact` emits a fenced body of 3,951 bytes
  that *starts and ends* like the original object but
  `JSON.parse` fails with `Expected ']'` — the `records` array is cut
  mid-stream with no elision marker inside the structure and no `truncated`
  flag. Top-level `exitCode`/`failedTests`/`errors` did survive, but by
  accident of position (head and tail), not by any before/after field check.
  A consumer that parses gets a hard error; a consumer that eyeballs it
  believes it read the file.
- **A short input is inflated.** Measured: a 33-byte JSON file rendered
  through `ctx read --mode compact` produces ~330 bytes — a 10× expansion by
  boilerplate. AC3's "короткий ввод не раздувается" fails.
- **There is no delta/base concept at all.** Searched `src/commands/ctx.ts`
  and `src/ctx/*.ts` for `baseSnapshot|delta|--base|consumerSnapshot` — 0
  matches. AC3's "неверная база возвращает full-view с причиной" therefore
  qualifies a feature that does not exist. The phase must decide explicitly
  between (a) building delta-from-base, or (b) recording that no delta mode
  is offered and that a `--base` argument is rejected with a stated reason.
  Do not let this be closed silently.

**Already holds:** exit-code propagation (`ctx run`), and mid-stream failure
preservation on `ctx run` specifically.

**Files that would change (Lane C).** `src/commands/ctx.ts` (1248 lines —
holds read/run/rg/diff/show/hook dispatch in one file), `src/commands/ctx.test.ts`,
`src/ctx/hook.ts`, `src/ctx/hook-classify.ts`, plus new
`src/ctx/preserve.ts` (critical-field before/after) and `src/ctx/manifest.ts`.

**Defect-class exposure.**
- *Helper nothing calls:* yes — `ctx run`'s failure-aware extraction is not
  shared with `ctx read`; `src/ctx/assembly.ts` is not used by either.
- *Failure indistinguishable from empty success:* yes, in its purest form —
  a log with failures reads as a clean log, and a truncated JSON reads as a
  complete document.

---

## AC4 — AFC-30: loss manifest

**Norm.** `prd.md`: included/omitted ranges, versions, reasons and
continuation bounded by the shared budget; consumer history opt-in; denied
does not reveal IDs. `specification.md` §6: if the manifest itself is
shortened, `truncated=true`; a forbidden source never appears in it as an ID
or as a count of concrete objects; a continuation binds operation + opaque
handle + `sourceVersion` + scope + expiry; drift → `version-conflict`, never
a silent read of a different version; **"чистое чтение не пишет"** consumer
history.

**Surfaces.** `keryx ctx read` / `ctx run` / `ctx rg` (manifest + footer),
`keryx ctx show latest [--raw]` (the only expansion path), and — for the
"pure search does not write" clause — `keryx wiki ask` / MCP `wiki.ask` /
agent op `wiki_ask`.

**Measured current behaviour.**

- **A pure search writes persistent state, on all three wiki surfaces.**
  Measured: `keryx wiki ask "какая политика безопасности"` created
  `.metaproject/runtime/wiki-ask/translations.json` containing the **user's
  query text**, its derived translation and a timestamp:
  `{"phrases":{"какая политика безопасности":"which policy безопасности"},…,"updatedAt":"2026-09-07T12:10:37.804Z"}`.
  The writer is `upsertDynamicTranslation` (`src/wiki/ask.ts:309-347`),
  reached from `wikiAsk` itself, so it fires from the CLI, from MCP
  `wiki.ask`, and from the agent `wiki_ask` op. The MCP tool declares
  `mutating: false` and the agent op declares `risk: "read"`. That is a
  contract violation at the tool boundary as well as an AC-30 violation.
  (The probe directory was removed after measuring; the path is gitignored.)
- **No continuation exists.** Searched `src/commands/ctx.ts` for
  `continuation|--from|--range|--offset|handle` — the only hits are
  `handleInstallHook`/`handleUninstallHook`. The sole expansion path is
  `keryx ctx show latest --raw`, which dumps the entire raw log: not
  addressed, not versioned, not scoped, and the opposite of bounded
  disclosure. There is no opaque handle, no `sourceVersion`, no expiry, and
  therefore no `version-conflict` on drift.
- **The manifest is a scalar, not a manifest.** What exists is the footer
  `compacted: A → B bytes (N% saved; full output in raw)` plus a path to the
  raw log. No omitted ranges, no reasons, no `truncated` flag on the manifest
  itself.
- **A closed object reveals its existence and its full path.** Measured:
  `keryx ctx read /etc/master.passwd` → `EACCES: permission denied, open
  '/etc/master.passwd'` (exit 1);
  `keryx ctx read <missing>` → `ENOENT: no such file or directory, open
  '<abs path>'` (exit 1). Raw Node errno strings, identical exit codes, and
  `EACCES` positively confirms existence. `specification.md` §3 requires
  denied and unknown-hidden-object to normalise identically.
- Positive note for the same clause on a different surface: `read_wiki`
  *does* separate escape from missing (`"wiki path is outside its root"` vs
  `"wiki page is unavailable"`), though both are `isError: true` with no code.

**Already holds:** nothing in AC4. The `read_wiki` containment message is the
closest partial.

**Files that would change (Lane C, with one item in Lane A).**
`src/commands/ctx.ts`, `src/ctx/assembly.ts` (extend the existing
required/overflow primitive rather than writing a second one), new
`src/ctx/manifest.ts` and `src/ctx/continuation.ts`.
The "pure search does not write" fix lands in `src/wiki/ask.ts`
(**Lane A owns that file** — do not split it).

**Defect-class exposure.**
- *Helper nothing calls:* yes — `src/ctx/assembly.ts` again; it already has
  `omittedOptional` + `partial` + `context_overflow`.
- *Failure indistinguishable from empty success:* yes — a denied read and a
  missing read are the same exit code with a leaky message; a truncated
  manifest is indistinguishable from a complete one.

---

## AC5 — AFC-M03: cheap failure

**Norm.** `specification.md` §3, verbatim: `target-not-indexed` (target not
found in the permitted snapshot), `index-incomplete` (the index cannot
answer), `no-match` (a completed supported search with no hits),
`insufficient-evidence` (candidates exist but are not sufficient for the
stated context), plus `version-conflict`, `snapshot-unavailable`,
`capability-unavailable`, `budget-exceeded`, `handle-invalid`,
`handle-expired`, `format-unsafe`, `invalid-input`. The transport normaliser
preserves codes. A numeric lexical score is called a **ranking score**, never
a probability. Next action is bounded — no forced full tour of every layer.

**Surfaces.** Every retrieval surface in this phase: `wiki ask`/`wiki.ask`/
`wiki_ask`; `gdgraph find`/`affected`/`symbol` + `graph_affected`/
`graph_symbol`/`graph_path`; `search_code`; `read_wiki`; `ctx read`/`rg`.

**Measured current behaviour.**

- **Ten of the twelve codes do not exist in `src/` in any spelling.**
  Searched hyphenated and snake_case for each:
  `target-not-indexed 0, index-incomplete 0, no-match 0,
  insufficient-evidence 0, snapshot-unavailable 0, capability-unavailable 0,
  handle-invalid 0, handle-expired 0, version-conflict 0,
  configuration-incomplete 0`. Present: `format-unsafe` (33 hits, security
  module) and `budget_exceeded`/`context_overflow` (SAC/provider/slate only,
  30 hits).
- **`graph_affected` already makes the AC5 distinction — in prose.** Measured
  at both the structured and formatted agent surfaces:
  `{"target":"src/does/not/exist.ts","affected":[],"error":"gdgraph: … is not
  a node in the built graph (never indexed, or the path/symbol does not
  exist) — this is not the same as an indexed target with zero edges. …"}`,
  formatted as `isError: true`, CLI exit 1. An indexed target with zero
  dependents returns a normal populated/empty result. **The semantics of
  `target-not-indexed` are implemented; only the stable machine code is
  missing.** Record this as substantially already holding.
- **`wiki_ask` makes no distinction whatsoever.** Measured: nonsense query →
  `{"output":"# … _No matching wiki pages or memory entries were found._",
  "isError": false}`. That single result is what an empty wiki, an unbuilt
  index, an unsupported query and a genuine no-match all produce.
- **`ctx rg` distinguishes by exit code but lies in the summary.** Measured:
  no-match → exit 1; invalid regex `([unclosed` → exit 2 (rg's own
  convention, correctly propagated). But the rendered summary for the
  invalid regex reads `Matches: 4 / Files: 1` — it counted ripgrep's *error
  lines* as matches. A syntax failure is rendered in the shape of a
  successful search.
- **`ctx read` uses raw Node errno strings** with a uniform exit 1 (see AC4).
- Score naming: `WikiAskCitation.score` and `RepomapFile.score` are already
  named `score`, and `formatRepomap` prints `score 0.0403`. Nothing calls a
  score a probability. **This sub-clause already holds.**

**Already holds:** the `target-not-indexed` *semantics* on
`gdgraph affected` / `graph_affected`; `ctx rg` exit-code separation; the
"score is not a probability" naming rule.

**Files that would change (Lane D).** New `src/lib/retrieval-codes.ts` (the
closed vocabulary + a normaliser), `src/harness/tool/metaproject-port.ts`
(add a `code` to the result types), `src/harness/tool/metaproject-operations.ts`
(descriptors + formatters), `src/harness/tool/metaproject-adapter.ts`,
`src/mcp/metaproject-tools.ts`, `src/mcp/tools.ts`.
**Lane D must also fix the dead MCP `search_code`** (finding 0b-A): either
wrap the MCP projection with `withSearchFallback`, or give the adapter a
real backing. It is a one-line class of fix with a large blast radius on
agent behaviour and it belongs with the code work because both change the
same files.

**Defect-class exposure.**
- *Helper nothing calls:* yes, severely — MCP `search_code` is a live tool
  wired to a permanent stub while the working implementation sits one wrapper
  away.
- *Failure indistinguishable from empty success:* yes — this criterion **is**
  that defect class stated as a requirement.

---

## AC6 — AFC-M04: description → impact

**Norm.** `prd.md`: extend `gdgraph find` over name/path/symbol; add wiki
sections → code → bounded affected through coordination; **no new search
engine**. `wiki-specification.md` §3 step 6: confirmed section bindings are
used as seeds into the existing `gdgraph find/affected`; graph-derived
candidates never become confirmed business rules. `decision-traceability.md`
AC-M04: separate description-only, symbol and impact fixtures each have
explainable candidates; important related code does not lose to irrelevant
global popularity.

**Surfaces.**

| Fixture | Surface | Reachability |
|---|---|---|
| description-only | `keryx gdgraph find "<terms>"` | **CLI only** — no agent/MCP op |
| symbol | `keryx gdgraph symbol "<name>" [--json]`; agent/MCP op `graph_symbol` | both |
| impact | `keryx gdgraph affected <t> [--depth] [--ranked] [--json]`; agent/MCP op `graph_affected`; MCP `gdgraph.affected` | all three |
| wiki→code binding | `keryx wiki backlinks <file>`; agent/MCP op `wiki_backlinks`; the `describes` layer in `src/gdgraph/wiki-layer.ts` | both |

**Measured current behaviour.**

- **`find` matches file *paths* only.** `findNodes`
  (`src/gdgraph/find.ts:75-107`) tests query terms against `node.path` — never
  file content, never contained symbols, never wiki bindings. `findSymbols`
  matches symbol names only.
- **Measured on a realistic description-only query**,
  `keryx gdgraph find "wiki search ranking by section"`: the single most
  relevant file, `src/wiki/ask.ts`, **is absent from the result**. Twenty
  files come back, ten of them tied at `score 15`, headed by
  `src/memory/search.ts (dependents 12)`; also present are
  `docs/requirements/.../probe-wiki-drift.py`,
  `scripts/benchmark/run-gdwiki-oracle.ts` and `src/commands/wiki.test.ts`.
  `src/wiki/ask.ts` matched only the term "wiki" (score 10, no basename hit)
  and fell below the 20-item cut, while global fan-in floated less relevant
  files to the top. That is precisely "важный связанный код уступает
  нерелевантной глобальной популярности".
- **The reason is computed and then thrown away.** `FindResult` carries
  `matched: string[]` (which terms hit). The CLI renders only
  `(score 15, dependents 12)`. The explainability AC6 asks for exists in the
  data structure and dies in the renderer.
- **Symbol fixture: resolution works, disambiguation does not.** Measured
  `keryx gdgraph symbol "wikiAsk"` → 3 definitions correctly found
  (`metaproject-adapter.ts:651`, `metaproject-port.ts:429`, `wiki/ask.ts:91`)
  with no domain/owner disambiguation, and the callee list includes
  `test (src/harness/search/controller.ts:40)` — a same-name capture of a
  regex `.test(` call. Same-name hijack is live.
- **Impact fixture already works.** Measured `keryx gdgraph affected
  src/wiki/ask.ts --ranked` → all 12 dependencies and all 7 dependents,
  correctly separated, and an unknown target is correctly refused (see AC5).
  **This is the one AC6 fixture that substantially already holds** — and it
  is what AC2's impact mode should be built on.
- **Wiki→code binding is page-level and resolves only to generated pages.**
  Measured `keryx wiki backlinks src/wiki/ask.ts` → 1 wiki page,
  `components/src-wiki.md` (an auto-generated module page). `wikiPageId`
  (`src/gdgraph/wiki-layer.ts:32-34`) is `` `wiki:${relativePath}` `` — the
  id *is* the path (see AC7). There are no section-level bindings, so the
  "wiki section → code → bounded affected" path M04 specifies has no
  section end to start from.

**Already holds:** the impact fixture (`gdgraph affected`) end to end,
including the unknown-target refusal.

**Files that would change (Lane E).** `src/gdgraph/find.ts`,
`src/gdgraph/symbol.ts`, `src/gdgraph/affected.ts`, the find/symbol branches
of `src/commands/gdgraph.ts`, and their `.test.ts` siblings. A new
`graph_find` descriptor in `src/harness/tool/metaproject-operations.ts`
(contended — see §Contention). Depends on Lane A for wiki-binding seeds.

**Defect-class exposure.**
- *Helper nothing calls:* yes — `FindResult.matched` is computed and dropped;
  `gdgraph find` has no agent surface, so an agent cannot reach it at all.
- *Failure indistinguishable from empty success:* moderate — a `find` that
  returns 20 irrelevant files reads exactly like a `find` that worked.

---

## AC7 — AFC-W01: section search

**Norm.** `wiki-specification.md` §2 in full. A `WikiSection` entity: owner
page ID, **stable section ID**, title, domain, language, body range,
pageVersion, section content digest, lifecycle/freshness, evidence links.
The ID is stored in a Markdown marker
(`<!-- keryx:section id="rule-retry" --> … <!-- /keryx:section -->`), is
**not derived from the heading**, survives a heading rename, and a duplicate
ID inside an owner namespace is a validation error. Deletion leaves a missing
binding / tombstone with **no automatic redirect** to a same-named section.
Legacy pages may use a provisional
`pageVersion + heading occurrence + range` locator with
`stability=version-bound`. Add/edit/delete/rename invalidates the affected
index part; a query must not mix old offsets with a new body.

**Surfaces.** `keryx wiki ask` (retrieval), `keryx wiki validate` /
`wiki check-links` (identity validation), `keryx wiki migrate-markers`
(migration), MCP `wiki.query` (mode `validate`), agent op `read_wiki`,
`wiki_backlinks`. Section addressing would need a new `wiki.readSection`
surface, which does not exist.

**Measured current behaviour.**

- **No section entity exists.** Searched the whole repo for `keryx:section`
  — 2 hits, both inside the specification document itself. Zero in `src/`,
  zero in `.metaproject/wiki/`.
- The marker machinery that *does* exist is `src/wiki/managed-block.ts`,
  which handles `<!-- keryx:reference:begin v=1 hash=… -->` for
  **generated Reference blocks only**. `keryx wiki migrate-markers` wraps
  existing Reference sections; it authors no section identity.
- **The "stable id" that exists is the path.** `wikiPageId` returns
  `` `wiki:${relativePath}` `` and is commented `/** Stable id for a page
  node. */`. A rename produces a new id and silently orphans the old one.
  Nothing anywhere issues a tombstone. Inferred (not measured — measuring
  would require renaming a tracked wiki page): a rename cannot preserve an id
  that is a pure function of the path.
- Retrieval consequence, measured under AC1: the indexed unit is
  title + `## Summary`. Duplicate headings across domains cannot be
  distinguished because headings are not indexed as anything.

**Already holds:** nothing. This criterion is greenfield.

**Files that would change (Lane A).** New: `src/wiki/section-marker.ts`
(parse/emit/validate markers), `src/wiki/section-index.ts` (build,
invalidate, query), `src/wiki/section-tombstone.ts`. Changed:
`src/wiki/collect.ts`, `src/wiki/types.ts`, `src/wiki/ask.ts`,
`src/gdgraph/wiki-layer.ts` (section-level `describes`), the
`validate`/`migrate-markers` branches of `src/commands/wiki.ts`, plus
`.metaproject/wiki/` fixture pages.

**Size warning — this is the largest criterion in the phase and it does not
read that way.** AC7 is one line and is in substance: a new persisted entity,
a Markdown marker syntax with a version, a migration command that must
preserve content and CAS, a duplicate-ID validator, a rename-preserving
identity, a delete-leaves-tombstone rule, a provisional locator for legacy
pages, an index keyed on pageVersion + content digest, and partial
invalidation on edit. Treat it as its own multi-task lane and expect it to
dominate the phase's critical path. **AC1, AC6's wiki-binding half, AC8 and
AC9 all sit downstream of it.**

**Defect-class exposure.**
- *Helper nothing calls:* pre-emptively yes — the obvious failure mode here
  is building a section index that `wikiAsk` does not read. The RED tests
  must be written against `keryx wiki ask` / `wiki_ask` / MCP `wiki.ask`,
  never against the index module in isolation. This is the failure that
  occurred five times in phase 1.
- *Failure indistinguishable from empty success:* yes — a deleted section id
  silently redirecting to a same-named heading is exactly that shape.

---

## AC8 — AFC-W02: substantive wiki

**Norm.** `wiki-specification.md` §4. Four templates with mandatory content:
**Scenario** (trigger, inputs/preconditions, result, sequence, side effects,
exceptions/errors, code/test refs); **Rule** (scope, the rule, applicability,
exceptions, authority/acceptance basis, enforcement refs); **Decision**
(problem, chosen option, rejected alternatives and known reasons,
consequences, constraints, supersession); **Change guide** (before/after
behaviour, owner/boundary, change points, consumers/tests, invariants,
rollback/compatibility). An unknown reason is explicitly `unknown`, never
reconstructed from code. Boilerplate/empty placeholders/Reference-only
sections get `contentClass=scaffold|reference` and do not satisfy a "why"
query on a title match alone. Before a page is written, the questions it must
close and its evidence are fixed; each question is then `covered | partial |
unknown | not-applicable` with a reason, and **"количество заполненных
headings не заменяет проверку ответа"**.

**Surfaces.** `keryx wiki new <type> <slug>` (templating),
`keryx wiki validate` / MCP `wiki.query mode=validate` (structure),
`keryx wiki status` / MCP `wiki.query mode=status` (the completeness claim),
`keryx wiki ask` (the answer being verified).

**Measured current behaviour.**

- **One generic template, not four.** `src/wiki/templates.ts` renders a
  single shape for every one of the 8 page types:
  `## Summary / ## Details / ## Related Code / ## Related Wiki / ## Changelog`,
  with the body literals `"One paragraph summary."` and `"Main content."`.
  None of the mandatory fields above has a slot. There is no `unknown`
  reason field, no `contentClass`, no authority/acceptance basis, no
  rejected-alternatives section.
- **The only scaffold detector is one hardcoded string.** `extractSummary`
  (`src/wiki/collect.ts:194`) returns `""` when the summary is exactly
  `"One paragraph summary."`. Any other placeholder text is indexed as
  substantive content.
- **A page count is the completeness claim.** Measured
  `keryx wiki status`:
  `total pages: 50` with a per-type breakdown of
  `architecture 7, component 42, decision 1`, and
  **`business-rule 0, user-scenario 0, domain-model 0, service 0,
  integration 0`**. 42 of 50 pages are auto-generated `src-<module>` component
  pages. So the corpus contains essentially **no** rule or scenario content —
  the exact content AC8's "why/rule question" fixture needs — and nothing in
  the output says so. `total pages: 50` is presented as the state of the
  wiki. This is AC8's final clause failing verbatim.
- There is no per-question coverage record anywhere: no
  `covered/partial/unknown/not-applicable` vocabulary in `src/`.

**Already holds:** nothing.

**Files that would change (Lane F).** `src/wiki/templates.ts`,
`src/wiki/classify.ts` (contentClass), the `status`/`validate`/`new`
branches of `src/commands/wiki.ts` (contended with Lane A),
`src/wiki/service.ts` (contended with Lane G), plus **new authored content**
under `.metaproject/wiki/business-rules/` and
`.metaproject/wiki/user-scenarios/`.

**Size and risk warning.** AC8 is only partly a code task. Its acceptance
requires *a synthetic page that actually answers a pre-registered why/rule
question*, and the corpus has zero pages of that kind today. Writing that
page is authoring, not implementation, and the questions it must close have
to be fixed **before** it is written (the spec is explicit, and equally
explicit that the page must not contain the answer to a current benchmark's
gold). Assign an owner for the content, separately from the code, or this
criterion will be closed with a template that nobody filled in.

**Defect-class exposure.**
- *Helper nothing calls:* likely — a `contentClass` classifier that
  `wikiAsk` does not consult would reproduce it exactly.
- *Failure indistinguishable from empty success:* yes, and it is already
  live: an empty rule corpus reports as a 50-page wiki.

---

## AC9 — AFC-W04: compact evidence

**Norm.** `wiki-specification.md` §6. Evidence carries section
identity/version, excerpt/range, `contentClass`, lifecycle, freshness,
claimType/provenance, **mandatory caveats**, code/test links and a
continuation address. A fragment, its live caveat and its exception form one
**indivisible evidence item** — if the text says "the update is agreed" and a
linked caveat says "implementation deferred", the caveat is mandatory
regardless of ranking, and the first half must never be returned alone. A
missing caveat source yields `insufficient-evidence`. If the unit does not
fit, **`budget-exceeded`** plus a safe suggestion — not a shortened rule.
Conflicting sources are returned as separate items with `conflictRefs` and
source versions, never merged into one confident summary. Stale-accepted is
shown for reference with a reason; unknown is "not verified"; draft/history
are explicitly not confirmed constraints. A continuation is bound to
`sourceVersion`; a source change between search and expand gives
conflict/new snapshot, not the old quote under a new version number.

**Surfaces.** `keryx wiki ask` (+ `--json`), MCP `wiki.ask`, agent op
`wiki_ask`. A `wiki.readSection` surface is specified and does not exist.

**Measured current behaviour.**

- **The contract is fully written and has zero consumers.**
  `docs/requirements/keryx-agent-first-core/schemas/wiki-evidence.schema.json`
  exists (145 lines) with `pageRef`, `pageVersion`, `sectionId`,
  `sectionVersion`, `contentClass` (`substantive|scaffold|reference`),
  `excerpt {text,startLine,endLine}`, `lifecycle`, `provenance`,
  **`caveats`**, **`conflictRefs`**, and a positive example in
  `examples/wiki-evidence.json`. Searched `src/**/*.ts` for
  `wiki-evidence|operation-response|change-set.schema|handoff.schema|batch.schema`
  — **0 matches**. No runtime code reads or produces any of these envelopes.
- **What the surfaces actually return** is
  `{ question, citations: [{path,title,excerpt,score,source}], answer }`
  (`WikiAskResult`). No section id, no version, no range, no contentClass, no
  provenance, no caveats, no conflictRefs, no continuation, no budget.
- **Lifecycle marks are dropped at the agent boundary.** The CLI's
  `WikiAskCitation` does carry `historical` / `lifecycleState` /
  `lifecycleReasons` (added under AFC-06 in phase 2), and `assembleAnswer`
  renders a `**[HISTORICAL — not current: …]**` marker. But the adapter's
  `wikiAsk` (`src/harness/tool/metaproject-adapter.ts:651-668`) re-maps
  citations to exactly `{path,title,excerpt,score,source}` and **drops
  those three fields**. The agent and MCP surfaces therefore lose the
  "not verified / not current" signal the CLI has. This is a phase-2
  guarantee leaking at a phase-3 surface and it should be fixed here, in the
  same file AC9 touches.
- Excerpts are truncated to 240 chars with an ellipsis
  (`EXCERPT_MAX`, `src/wiki/ask.ts:23`) with no range, no `truncated` flag
  and no continuation — a shortened rule returned as if whole, which is the
  precise thing AC9's last clause forbids.

**Already holds:** the schema and its positive example (spec-side only). No
runtime behaviour.

**Files that would change (Lane G).** New `src/wiki/evidence.ts` (the
envelope + the indivisible-item rule + conflict pairing), `src/wiki/ask.ts`
(**owned by Lane A — sequence, do not parallelise**),
`src/harness/tool/metaproject-adapter.ts` (contended with Lane D),
`src/harness/tool/metaproject-port.ts` (contended with Lane D),
`src/wiki/service.ts`, the `wiki.ask` entry in `src/mcp/tools.ts`
(contended with Lane D).

**Defect-class exposure.**
- *Helper nothing calls:* **already true today** — a complete, versioned
  evidence schema with a worked example that no code path produces or
  validates against. The obvious repeat is writing `src/wiki/evidence.ts`
  and leaving `wikiAsk` returning the old shape.
- *Failure indistinguishable from empty success:* yes — a fragment returned
  without its mandatory caveat is a confident answer that is wrong, and the
  240-char excerpt cut is a silent truncation.

---

## Proposed lanes

Seven lanes. Each owns a disjoint file set; the contended files are named
below and are assigned to exactly one owner.

### Lane D0 — failure-code vocabulary (foundation, must land first)
Closes: the vocabulary half of **AC5**.
Owns (new, uncontended): `src/lib/retrieval-codes.ts`,
`src/lib/retrieval-codes.test.ts`.
Done when: the closed union from `specification.md` §3 exists with a
normaliser that preserves a code across a transport boundary, and it is
imported by at least one live path. Tiny (a union + a mapper). Every other
lane imports it read-only, so it must merge before they emit codes.

### Lane A — wiki section identity, index and retrieval corpus
Closes: **AC7**, **AC1**, and AC4's "pure search does not write history".
Owns: `src/wiki/section-marker.ts` (new), `src/wiki/section-index.ts` (new),
`src/wiki/section-tombstone.ts` (new), `src/wiki/ask.ts`,
`src/wiki/collect.ts`, `src/wiki/types.ts`, `src/gdgraph/wiki-layer.ts`,
`src/commands/wiki.ts`, and the co-located tests for each.
Done when: (i) a term present only in a Details / Main flows / Constraints
section is returned by `keryx wiki ask`, MCP `wiki.ask` **and** agent
`wiki_ask`; (ii) a stopword-only query returns `no-match` or
`insufficient-evidence` rather than ranked citations; (iii) a heading rename
preserves the section id and a delete leaves a tombstone with no silent
redirect; (iv) duplicate ids inside an owner namespace fail validation;
(v) `wiki ask` performs **no** filesystem write — assert on the absence of
`.metaproject/runtime/wiki-ask/`.
**Largest lane. On the critical path.** Split internally into
marker+identity, index+invalidation, and retrieval-swap tasks.

### Lane B — repomap selection, reasons and required-set overflow
Closes: **AC2**.
Owns: `src/gdgraph/repomap.ts`, `src/gdgraph/pagerank.ts`,
`src/gdgraph/repomap.test.ts`, `src/gdgraph/pagerank.test.ts`.
Consumes read-only: `src/ctx/assembly.ts`, `src/gdgraph/affected.ts`.
Done when: `dependency|impact|balanced` modes exist with `impact` the default
for a change intent; every entry carries a `reason` from the closed set
(`seed|dependency|consumer|test|wiki-binding`); an unresolvable seed returns
`target-not-indexed`; a required seed that does not fit returns
`budget-exceeded` (via `assembleContext`, not a second primitive); and the
seed's known consumers/tests from `gdgraph affected` are present before any
tied-score tail entry. Verify through the **agent op**, which means the
`repomap` descriptor must gain `seed`/`mode` — see contention.

### Lane C — ctx preservation, loss manifest and continuation
Closes: **AC3**, **AC4** (except the wiki-write item, which is Lane A's).
Owns: `src/commands/ctx.ts`, `src/commands/ctx.test.ts`, `src/ctx/hook.ts`,
`src/ctx/hook-classify.ts`, `src/ctx/assembly.ts`,
`src/ctx/preserve.ts` (new), `src/ctx/manifest.ts` (new),
`src/ctx/continuation.ts` (new).
Done when: a `not ok`/`FAIL` line anywhere in a large log survives
`ctx read --mode compact` or the result is downgraded to partial with a
stated reason; compacted JSON either `JSON.parse`s or is not presented as
JSON; an input already within budget is returned without the wrapper; the
manifest names omitted ranges with reasons and sets `truncated` when it is
itself cut; an addressed continuation re-reads a bounded range without a
re-search and returns `version-conflict` on drift; and denied vs missing
normalise to indistinguishable errors that do not leak the absolute path.
Also required: an explicit, recorded decision on the delta/base clause.
**Second-largest lane** — `src/commands/ctx.ts` is 1248 lines and holds every
subcommand.

### Lane D — failure codes across the agent/MCP surface, and the dead search_code
Closes: the rest of **AC5**.
Owns: `src/harness/tool/metaproject-port.ts`,
`src/harness/tool/metaproject-operations.ts`,
`src/harness/tool/metaproject-adapter.ts`,
`src/mcp/metaproject-tools.ts`, `src/mcp/tools.ts`, and their tests.
Done when: `target-not-indexed`, `index-incomplete`, `no-match` and
`insufficient-evidence` are distinguishable **as codes** on every retrieval
op; the code survives the CLI, MCP and interactive-agent renderings; a
bounded `nextAction` is present and does not require a full layer tour;
**and MCP `search_code` returns real results** rather than
"no in-process backing".
Note: Lane D owns the three surface files that every other lane needs to
touch. See contention.

### Lane E — candidate explainability for description-only and symbol queries
Closes: **AC6**.
Owns: `src/gdgraph/find.ts`, `src/gdgraph/symbol.ts`,
`src/gdgraph/affected.ts`, `src/commands/gdgraph.ts`, and their tests.
Done when: a description-only fixture returns `src/wiki/ask.ts`-class results
(content/symbol/wiki-binding evidence, not path substrings) with the
`matched` reason rendered, not dropped; a same-name symbol does not capture
an unrelated reference; important related code outranks globally popular
unrelated code on a fixed fixture; and the description-only path is reachable
from an agent surface at all.
Depends on Lane A for wiki-binding seeds; the content/symbol halves do not.

### Lane F — explanation templates and honest completeness
Closes: **AC8**.
Owns: `src/wiki/templates.ts`, `src/wiki/classify.ts`,
`src/wiki/validate-structure.test.ts` and the structure validator it needs,
plus new authored pages under `.metaproject/wiki/business-rules/` and
`.metaproject/wiki/user-scenarios/`.
Done when: scenario/rule/decision/change-guide templates carry every
mandatory field; an unknown reason is representable as `unknown` and is not
reconstructed; `contentClass=scaffold|reference` is assigned and a scaffold
does not satisfy a "why" query on a title match; a per-question
`covered/partial/unknown/not-applicable` record exists; and `wiki status`
stops presenting a page count as completeness.
**Carries an authoring dependency, not only a code one.** Needs an owner for
the synthetic page and its pre-registered questions.

### Lane G — evidence envelope
Closes: **AC9**.
Owns: `src/wiki/evidence.ts` (new), `src/wiki/service.ts`, and the
evidence-shape tests.
Done when: `wiki ask`/`wiki.ask`/`wiki_ask` return the
`wiki-evidence.schema.json` envelope; a fragment with a live caveat is
indivisible and never returned alone; a missing caveat source yields
`insufficient-evidence`; conflicting sources come back as separate items with
`conflictRefs` and versions; stale/draft/unknown are not rendered as
verified; an item that does not fit yields `budget-exceeded` rather than a
shortened rule; and the `historical`/`lifecycleState` fields stop being
dropped at the adapter boundary.
**Sequenced after Lane A** (shares `src/wiki/ask.ts`) and after Lane D
(shares the port/adapter/MCP files).

## Contended files — must be serialised

| File | Wanted by | Owner | Resolution |
|---|---|---|---|
| `src/harness/tool/metaproject-operations.ts` | D (codes), B (repomap `seed`/`mode`), E (new `graph_find`), G (wiki_ask output) | **D** | The single most contended file in the phase. B/E/G do **not** edit it. Land Lane D first with every descriptor/schema delta the other lanes need, agreed up front; the other lanes then change only their own module files. |
| `src/harness/tool/metaproject-adapter.ts` | D (codes, search_code), G (evidence, lifecycle fields) | **D** | Same rule: D lands the shape, G fills the wiki mapping afterwards. |
| `src/harness/tool/metaproject-port.ts` | D, G | **D** | Types-only; D lands all result-type additions in one change. |
| `src/mcp/tools.ts` | D (codes), G (`wiki.ask`) | **D** | G's `wiki.ask` change is a one-line result mapping; fold it into D's change or sequence after. |
| `src/wiki/ask.ts` | A (corpus, no-write), G (evidence envelope) | **A** | Strict sequence A → G. Do not run them concurrently; this file is the hinge of four criteria. |
| `src/commands/wiki.ts` | A (`ask`/`validate`/`migrate-markers`), F (`status`/`new`) | **A** | F's `status` change is small; sequence F after A, or have A land a `status` seam F fills. |
| `src/commands/gdgraph.ts` | B (`repomap`), E (`find`/`symbol`) | **E** | Disjoint subcommand branches, but one file. E owns it; B's repomap CLI change is a few lines — hand it to E or sequence B after E. |
| `src/ctx/assembly.ts` | C (owner), B (read-only consumer) | **C** | B imports, never edits. |
| `src/wiki/service.ts` | F, G | **G** | F's needs there are minor; sequence F after G, or keep F's changes in `templates.ts`/`classify.ts`. |
| `src/gdgraph/wiki-layer.ts` | A (section-level describes), E (binding seeds) | **A** | E consumes the layer read-only. |

## Dependency order

```
D0 (retrieval-codes)  ──┬──> D (surface codes + search_code fix) ──> G (evidence)
                        │                                            ^
A (sections+corpus) ────┼────────────────────────────────────────────┘
   │                    │
   ├──> F (templates + completeness)
   └──> E (wiki-binding half of AC6)

B (repomap)  — needs D0 and D's descriptor delta; otherwise independent
C (ctx)      — needs D0; otherwise fully independent
E (content/symbol half) — needs D0; otherwise independent of A
```

Fully parallel after D0 merges: **C**, **B**, and the content/symbol half of
**E**. Everything on the wiki side queues behind **A**.

## What already holds (do not re-implement)

- `keryx ctx run` propagates the child's exit code, and preserves a
  mid-stream `FAIL`/`not ok` line. (AC3, partial)
- `gdgraph affected` / agent `graph_affected` correctly separate
  "not a node in the built graph" from "indexed with zero edges", with a
  non-zero CLI exit and an `isError` agent result. Only the stable code is
  missing. (AC5, AC6 — substantial)
- `keryx ctx rg` separates no-match (exit 1) from an rg error (exit 2),
  though the rendered summary miscounts error lines as matches.
- Ranking numbers are already named `score` and never presented as a
  probability. (AC5, closed)
- `read_wiki` separates a containment escape from an unavailable page.
- Repomap ranking is deterministic and a single seed at a workable budget
  survives.
- `src/ctx/assembly.ts` already implements required-vs-optional,
  `context_overflow{requiredId}`, `omittedOptional` and `partial`. Reuse it.
- `wiki-evidence.schema.json` and its positive example are complete and
  agreed. Do not redesign the envelope; implement it.

## Criteria that are much larger than they read

1. **AC7 (W01)** — by a wide margin. One line of frozen text; in substance a
   new entity, a versioned Markdown marker syntax, a content-preserving
   migration, duplicate-id validation, rename-stable identity, delete
   tombstones, a legacy provisional locator, and a digest-keyed index with
   partial invalidation. It blocks AC1, AC6 (partly), AC8 and AC9.
2. **AC8 (W02)** — carries a **content-authoring** dependency the criterion
   does not mention. The corpus has zero business-rule and zero user-scenario
   pages (measured); the "synthetic page answering a pre-registered why/rule
   question" cannot be produced by code alone, and its questions must be
   fixed before it is written.
3. **AC3 (W14)** — the JSON clause requires a real structural summariser, not
   a smarter truncator, and it lands in a 1248-line file that holds every
   `ctx` subcommand. Its delta/base sub-clause qualifies a feature that does
   not exist and needs an explicit decision rather than a silent pass.
4. **AC5 (M03)** — small per surface, but it touches every retrieval surface
   in the phase and owns the three most contended files. Its real content is
   the coordination, not the code.

## Standing risks for this phase

- **Do not accept a criterion on a helper.** Five phase-1 defects were
  capabilities implemented where no live path called them. Two are live in
  this phase's code right now: `src/ctx/assembly.ts` (reachable only from
  SAC) and `wiki-evidence.schema.json` (reachable from nothing). Every RED
  test for AC1/AC2/AC6/AC9 must be written against a **named surface** from
  §0 — the CLI command, the MCP tool, or the agent op — not against the
  module under test.
- **MCP `search_code` is dead today.** Any measurement an implementing agent
  takes through MCP code search will return "no in-process backing" and must
  not be read as "no matches".
- **`keryx gdgraph repomap` writes a tracked artifact.** Measure through
  `computeRepomap` or the agent port.
- **`keryx wiki ask` writes to `.metaproject/runtime/wiki-ask/`.** Any
  before/after comparison of wiki search must account for the dictionary the
  first RU query creates.
- The graph answers from the last `keryx gdgraph build`. This survey's graph
  reported 1197 indexed source files against a working tree with many
  modified `src/` files; the structural findings above were each confirmed by
  reading the file, not by the graph alone.
