# Контекст этапа 4
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 2, 3. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

## Additional observed provenance defect

During authorized parallel reads, service.ts and types.ts ctx read results both reported the same raw/summary identifier `2026-09-06T12-02-33-793Z_read`. Investigation found src/commands/ctx.ts generates IDs solely from millisecond timestamp plus operation kind (line457 at observation) and uses ordinary writes. Two same-kind calls within one millisecond can overwrite each other. Their simultaneous same-ID results must not be cited as independent immutable evidence.

Track collision-resistant artifact IDs and exclusive write behavior in the added task; include deterministic concurrent fixtures under a frozen clock. Existing different-timestamp test/run evidence is not presumed affected, but no general no-collision claim is made for old artifacts. The last graph context was consulted but reported uncommitted files; current targeted source inspection is authoritative. Searches used keryx ctx rg, no bare rg.

---

# Implementation inventory — phase 4 (freshness and delivery)

Recorded 2026-09-07 by a read-only inventory pass. Branch `codex/agent-first-core`,
HEAD `886400e8`, working tree dirty by design (several lanes landing concurrently).
Nothing under `src/`, `scripts/`, `docs/` was modified by this pass; the only file
written is this one. Every claim below marked **measured** was produced by running
the command or probe named next to it in this session. Claims marked *inferred* were
read out of source and not driven.

## 0. Enumerated caller surfaces (the "helper nothing calls" guard)

Enumerated by running the registries, not by reading them:

| Surface | How enumerated | Phase-4-relevant entries |
|---|---|---|
| CLI | `bun src/cli.ts wiki --help`, `... init --help`, `... update --help`, `... orient --help` | `wiki refresh`, `wiki freshness`, `wiki verify`, `wiki backlinks`, `wiki sections{,resolve,sync,migrate}`, `wiki ask`, `wiki collect`, `wiki migrate-markers`, `init`, `update`, `rules sync/distill`, `orient`, `orient install-hook` |
| Agent tool ops | `keryx ctx rg 'name: "' src/harness/tool/metaproject-operations.ts` — 16 ops | `read_wiki`, `wiki_freshness`, `wiki_ask`, `wiki_backlinks` |
| MCP tools | `keryx ctx rg 'name: "' src/mcp/tools.ts` — 25 tools | `wiki.query`, `wiki.ask` **only** |

**Surface gap (measured).** The MCP server exposes no freshness, no sections, no
backlinks and no refresh. An MCP-only consumer cannot ask whether a wiki page is
current. The agent-tool port can (`wiki_freshness`); MCP cannot. Any lane that adds
a freshness/binding capability must add it to *both* registries or it lands in a
third helper nothing calls.

**Dead capability #8 for this programme (measured).**
`checkPageStalenessGate` / `PageStalenessGate` in `src/wiki/staleness.ts:94-128` has
**zero non-test, non-comment callers**. `keryx ctx rg -c -t ts 'checkPageStalenessGate' src`
returns 4 files: `staleness.test.ts` (6), `staleness.ts` (its own definition, 2),
`enrich.ts` (1 — a comment at line 1642), `resume-state.ts` (1 — a comment at line 7).
It is the *only* thing in the wiki lane that would carry graph staleness into a
freshness decision, and it is unreachable. It also still wraps the **boolean**
`graphMaybeStale`, and its doc comments (lines 22-33, 96-115) still describe the
*old* `.git/HEAD`-mtime implementation that the sibling lane replaced — so the
comments actively mislead about what the check now does.

**Tri-state adoption (measured).** `keryx ctx rg 'checkGraphStaleness|graphMaybeStale'`:
the tri-state `checkGraphStaleness` (`src/gdgraph/staleness.ts:121`) is consumed by
`src/commands/gdgraph.ts` and `src/harness/tool/metaproject-adapter.ts` only. The
boolean wrapper's only consumer is the dead `checkPageStalenessGate`. **No path in
this phase — `wiki refresh`, `wiki verify`, `wiki freshness`, `wiki collect` — calls
either.** They call `loadGraph()` directly and never ask how old it is.

## 1. AC1 / AC-08 — generated wiki, unchanged prose, no churn, old source not fresh

Norm: `wiki-specification.md` §7 (lines 82-90). Surfaces: `keryx wiki refresh`,
`wiki verify`, `wiki collect`, `wiki migrate-markers`.

**Already holds (measured).**
- *Author prose is byte-identical.* `refreshPages` (`src/wiki/refresh.ts:169-290`)
  replaces only the marked managed block; prose is never in the replacement range.
- *Repeated sync produces no diff / observation time causes no churn.* Two
  consecutive `bun src/cli.ts wiki refresh --dry-run --json` runs, seconds apart with
  a different `generatedAt`, returned identical results: **24 refreshed, 16
  unchanged, 10 no-block, 0 conflicts**, identical per-page versions. If
  `generatedAt` leaked into the Reference block all 40 block-carrying pages would
  read "refreshed"; 16 read "unchanged". The generator is time-independent.
- *A hand-edited block is refused, not overwritten* (`refresh.ts:238-246`), and an
  already-current page is not restamped (`refresh.ts:256-261`).

**Fails, measured.**
1. **Health and testing sources have no update path at all.** `refreshPages:178`
   builds `referenceBySlug` from `collectGraphWikiCandidates` **only**.
   `collectHealthWikiCandidates` (`service.ts:706`) and
   `collectTestingWikiCandidates` (`service.ts:760`) are reachable only from
   `wiki collect` (`service.ts:277-279`). Driven: the two pages they own,
   `architecture/quality-map.md` and `architecture/testing-map.md` (plus
   `architecture/project-map.md`), both come back `action: "no-block"` from
   `wiki refresh --dry-run --json` — they carry no managed marker at all. And
   `writeCollectedPage` (`service.ts:805-818`) skips any existing page unless it is
   an *unmodified draft*. So once a health/testing page is accepted, **no command in
   the product can update it.** AC-08's leading clause ("a changed graph/testing/
   health source updates the accepted map") is one-third delivered.
2. **An old source does become fresh.** Live state, measured this session:
   `.metaproject/data/gdgraph/.provenance.json` records `commit 60848c77`; `git
   rev-parse HEAD` is `886400e8`. The graph is stale *now*. `wiki refresh` would
   regenerate 24 pages from that stale graph and stamp each with
   `VerifiedAt: 886400e8` (`commands/wiki.ts:754` `currentHead(cwd)` →
   `refresh.ts:278-281` `writeProvenance`). The freshness report then reads those
   pages as verified at current HEAD. `refreshPages` and `verifyPages` never call
   `checkGraphStaleness`. This is the defect-class-2 instance for AC-08: a stale
   input is rendered indistinguishable from a verified one.
3. **10 of 50 pages carry no managed block**, so refresh is silently a no-op for a
   fifth of the corpus. `no-block` is reported but not summarised in the human
   output (`commands/wiki.ts:769-778` prints only refreshed/conflict rows).

**Smaller findings.** `wiki refresh --dry-run` exists (`commands/wiki.ts:759`) but is
**not in `--help`**; the preview capability is undiscoverable. `appendChangelogLine`
(`refresh.ts:143`) adds a line per effective refresh and never dedupes — unbounded
page growth under repeated refresh; currently bounded only because no hook runs
`wiki refresh` (checked `.git/hooks/post-commit`: it appends to the freshness queue
and nothing else).

**Files.** `src/wiki/refresh.ts`, `src/wiki/service.ts` (candidate collectors +
`writeCollectedPage`), `src/wiki/provenance.ts`, `src/wiki/managed-block.ts`,
`src/commands/wiki.ts` (refresh/verify/collect handlers + help text).

## 2. AC2 / AC-21 — one install/update lifecycle

Norm: `artifact-lifecycle.md` lines 52-56. Read Phase 0's own record at
`.metaproject/flows/232-.../artifacts/DELIVERY.md` §"Остаточный объём" rather than
re-deriving; this pass confirms it verbatim.

**Already holds (measured).** One shared writer `src/lib/routing-entrypoint.ts`
consumed by `init.ts`, `update.ts`, `rules.ts` (`keryx ctx rg -l
'routing-entrypoint|writeRoutingEntrypointPair'` → exactly those five files). A
shared cross-command fixture exists:
`src/commands/routing-entrypoint-lifecycle.test.ts` drives init → rules sync →
rules sync → update on one temp root and asserts byte-equality across repeats and
preservation of `<!-- user-owned -->` blocks. `writeTextIfChanged` +
`withFileLock` + `writeFileAtomic` give per-file atomicity and a safe rerun.

**Fails, measured.**
1. **No preview.** `bun src/cli.ts init --help` and `update --help` list no
   `--dry-run` / `--preview`. There is no way to see create/update/conflict/skip
   with expected base digests before applying. (`orient install-hook` *does* have
   `--dry-run`; init/update do not.)
2. **No plan, no step IDs, no resumable partial state.**
   `keryx ctx rg -l 'stepId|planSteps|InstallPlan|resumeState|pendingSteps|
   completedSteps|inputFingerprint' src/commands src/lib` returns **one** file,
   `src/commands/job.ts`, unrelated to install. The norm's "stable step IDs and
   input fingerprints … apply … saves completed/failed/pending and safely continues
   after a crash" has no representation in code. A crash mid-`init` today leaves a
   partial tree whose only recovery is a full rerun that re-derives everything.
3. **No conflict resolution on divergent versions.** `writeTextIfChanged` compares
   bytes and overwrites; there is no expected-base check, no conflict outcome.

**Honest sizing.** This is not a patch. Introducing a plan/apply/resume protocol
across a 1811-line `init.ts` and a 1627-line `update.ts` is the largest single item
in the phase and should be scoped as design-then-implement, with the design (step
identity, fingerprint definition, state file location and its retention) agreed
before code. The norm explicitly *forbids* promising full rollback, so the target is
an honest partial report plus resume — which is cheaper than a transaction, but only
if the step boundary is defined first.

**Files.** `src/commands/init.ts`, `src/commands/update.ts`, `src/commands/rules.ts`,
`src/lib/routing-entrypoint.ts`, `src/lib/templates.ts`, `src/lib/fs.ts`, plus a new
plan/apply module. Heavily contended with any other lane touching `src/commands/`.

## 3. AC3 / AC-22 — freshness cost at 50/500/2000 pages

Norm: `metrics-and-validation.md:64` and `wiki-specification.md:88`.

**Measured, with a probe** (`scratchpad/probe-freshness-cost.ts`, calls
`buildFreshnessReport` directly with an instrumented `GitRunner`; writes nothing):

```
REAL GIT      50 pages · 107 git subprocesses (cat-file 44, log 37, diff 26) · 2790 ms
              fresh 12, affected 34, undecidable 0, notCodeScoped 4
              limitations: [symbol-layer-unavailable, unresolved-edges-present]
GIT BROKEN    50 pages · fresh 11, affected 35, undecidable 0 ·  96 ms
(every git     limitations: [symbol-layer-unavailable, unresolved-edges-present]
 call → null)  categories: {unknown: 2, stale-prose: 33}
```

**This is the defect-class-2 instance the dispatch asked me to look hard for, and it
is worse than expected.** With git completely broken the report is *not* marked
unknown — it is nearly identical to the healthy one. Same two limitation codes, same
`unknown` count, one page flipping from fresh to affected. **No `not-a-git-repository`
limitation, no per-page unknown, no signal whatsoever.** `runFreshness`
(`src/wiki/freshness/run.ts:77-86`) does add that limitation, but only from a single
up-front `rev-parse HEAD` probe. A git that answers `rev-parse` and then fails per
page — corrupt object, shallow clone, index lock, permission, a `VerifiedAt` that
resolves but whose `log` errors — falls silently through `evaluatePageFreshness`
(`page-freshness.ts:65-94`) onto the scope-hash basis and reports verdicts derived
from a measurement that never ran.

Root cause is one primitive: `gitCmd` (`src/sync/provenance.ts:26-40`) returns
`null` for spawn error, non-zero exit and "not found" alike. Every consumer reads
`null` as "no data". Both AC-22's and AC-W05's "a git failure yields unknown" clauses
resolve to fixing this seam and threading a distinguishable failure through
`page-freshness.ts` → `report.ts`.

**Cost, measured and extrapolated.** 2.14 git spawns and ~56 ms per page, with the
page's whole describe-set passed as pathspec args (so arg length grows too). No
per-run git cache and no batching by base revision exist anywhere on this path —
`gitCmd` spawns unconditionally, and the norm requires both ("checks groups of equal
base revisions in batches and caches Git results within a run"). Linear extrapolation
(*inferred*, not measured): 500 pages ≈ 1,070 spawns / ~28 s; 2,000 pages ≈ 4,280
spawns / ~112 s. **No 50/500/2000 fixture and no per-page oracle exist**
(`ls scripts/benchmark/` — 29 scripts, none page-scale wiki freshness).

**No calibration profile exists.** `keryx ctx rg -l -i 'calibration|latencyBudget|
concurrencyBound|rankingWeights' src scripts docs/requirements` matches **zero files
under `src/`** — only requirements prose and old flow notes. AC-22's "the budget is
agreed before optimisation" is undelivered as an artifact, which means the
optimisation work is currently *blocked* by the norm, not merely unstarted.

**Honest sizing.** This criterion is a performance criterion wearing a correctness
criterion's clothes. It decomposes into three things of very different size:
(a) the git-failure→unknown seam — small, high value, testable with an injected
runner; (b) the versioned calibration profile — a document plus a schema, small, and
a *precondition* for (c); (c) corpus fixtures at three scales plus a per-page oracle
plus batching/caching — the largest measurement item in the phase. Do not let (c)
gate (a).

**Files.** `src/sync/provenance.ts` (the `gitCmd` seam — contended, used repo-wide),
`src/wiki/freshness/page-freshness.ts`, `src/wiki/freshness/report.ts`,
`src/wiki/freshness/run.ts`, a new calibration profile under
`docs/requirements/keryx-agent-first-core/` or `.metaproject/`, new fixtures under
`fixtures/` and a new `scripts/benchmark/run-wiki-freshness-scale.ts`.

## 4. AC4 / AC-26 — graph of grounds

Norm: `wiki-specification.md` §5 (lines 57-70): `EvidenceLink` with relation, owner
target ref, targetVersion/digest, source section ref, qualification
(confirmed/proposed/broken/unknown), provenance; reverse dependencies over explicit
links; visited-set cycle traversal; bounded output; loss manifest; `completeness`
that does not promise full semantic impact.

**Measured: none of it exists.** `keryx ctx rg -l -t ts 'EvidenceLink|evidenceLink|
reverseDependenc|reverseBinding|needs-review|needsReview|qualification' src` returns
9 files — `gdskills/*` (3), `memory/*` (5), `harness/tool/metaproject-port.ts` (1).
**Not one file under `src/wiki/`.** There is no evidence-link type, no qualification
enum, no reverse index over explicit links, no `needs-review` marking.

**Nearest existing machinery, and why it does not substitute.**
- `src/wiki/backlinks.ts` (86 lines) inverts markdown links and file-like code spans
  into `Map<target, pages[]>`. Pure text; no relation kind, no version/digest, no
  qualification, no symbol identity. Driven: `bun src/cli.ts wiki backlinks
  src/wiki/refresh.ts` → "Wiki pages linking here (0)", plus 2 importers from the
  graph. It cannot express "this section is *verified-by* that test at that version".
- `src/wiki/freshness/propagate.ts` walks the **code** graph with confidence decay as
  the bound (lines 1-19, 50-59). Cycle termination there is real, but it is
  termination over `imports`/`calls`/`describes`, not over an evidence-link graph.
  AC-26's cycle clause is about the grounds graph, which does not exist yet.
- `src/wiki/section-index.ts` / `section-marker.ts` / `section-tombstone.ts` give
  sections stable identity, tombstones and resolution — the correct *anchor* for
  bindings, delivered by an earlier phase.

**Blocking precondition, measured.** `bun src/cli.ts wiki sections`:
**635 indexed sections, 0 stable ids, 635 provisional (version-bound) locators.**
Every section is still path/line-derived; `keryx wiki sections migrate` has never
been run on this corpus. Any binding written today binds to an id that a rename or
a line shift invalidates. The migration must precede the binding work, and it is a
separate, low-risk, byte-preserving step (`wiki sections migrate --dry-run` first).

**Files.** New `src/wiki/evidence-link.ts` (+ index/reverse-index module), and edits
to `src/wiki/section-index.ts`, `src/wiki/types.ts`, `src/commands/wiki.ts`,
`src/harness/tool/metaproject-operations.ts` + `metaproject-port.ts` +
`metaproject-adapter.ts`, `src/mcp/tools.ts`.

## 5. AC5 / AC-M02 — delivery of pointers

Norm: `agent-protocol.md` lines 12-16. Proposed delivery key
`(consumerSessionId, projectId, checkoutId, routingRevision, contextEpoch)`.

**Measured: zero implementation.** `keryx ctx rg -l -t ts 'contextEpoch|
routingRevision|consumerSessionId|deliveryKey|orientDelivered' src` → **0 files**.

**Current behaviour, driven.** `src/commands/orient.ts:41-45` unconditionally builds
and prints the full orientation. Two consecutive `bun src/cli.ts orient claude` runs
produced **9,508 bytes each, byte-identical** (`diff -q` → identical). Installed as a
prompt hook (`orient install-hook`), that is ~9.5 KB (~2.4k tokens) re-injected on
every user prompt, with no dedup, no epoch, no acknowledgement, and no way for a
client to say "I already have this".

Also absent: any distinction between a narrow subagent (should receive root, scope,
constraints and pointers) and a navigating agent (may expand the router). `orient`
has one output shape per runtime; the runtime formatter (`ctx/orient-runtimes.ts`)
varies wrapping, not content or breadth. `skills_catalog` / `skill_load` exist as
separate agent ops but nothing routes breadth by consumer role.

**Honest sizing.** The delivery-key half is genuinely new protocol work with a
storage question attached (the norm says the key lives client-side *or* in explicitly
enabled session metadata, and "pure core read does not write history" — so the naive
answer, a server-side delivery log, is forbidden by AFC-30's pure-search rule). The
narrow-vs-navigating half is smaller and can land first.

**Files.** `src/commands/orient.ts`, `src/ctx/orient.ts`, `src/ctx/orient-runtimes.ts`,
`src/lib/templates.ts` (router/index pair rendering),
`src/harness/tool/metaproject-operations.ts` (a bootstrap op), `src/session/**`.

## 6. AC6 / AC-W03 — section to code and test

Norm: `wiki-specification.md` §5, table rows "Файл" / "Символ" / "Тест/отчёт".

**Current behaviour, driven.** `bun src/cli.ts wiki ask "how does wiki refresh
regenerate managed reference blocks" --json` returns citations with `path`, `title`,
`excerpt`, `score`, `matched`, `sectionId`, `sectionRef`, `sectionTitle`,
`sectionStability`, `contentClass`, `domain`, `startLine`, `endLine`.

**Fails, measured.**
1. **No change points and no tests in the result at all** — there is no `codeLinks` /
   `testLinks` / `changePoints` field in the shape. AC-W03's "a question yields an
   explanation *plus* the places to change *and* the tests" is half-delivered: the
   explanation half only.
2. **Every citation returned `sectionStability: "version-bound"`** — consistent with
   the 635/0 stable-id measurement above. There is nothing stable to bind to.
3. **Retrieval quality is a live concern**, not just plumbing: that question about
   `wiki refresh` returned `src-commands`, `src-lib` and `src-agents`, and not
   `src-wiki`. Worth recording because a binding lane will be tempted to blame its
   own layer for a retrieval miss.
4. **Rename/delete → `broken`, and same-name non-hijack, have no representation.**
   `section-tombstone.ts:212 resolveSectionIdentity` already refuses to redirect a
   removed section id to a same-named one — that is the *section* half of the
   non-hijack rule and it holds. The *symbol* half (a same-named symbol in another
   file must not capture a binding) has nothing, because there are no symbol
   bindings. Note `gdgraph`'s symbol layer is currently unavailable on this repo
   (the freshness probe reported `symbol-layer-unavailable`), so the norm's
   "absence of symbols → unknown/file fallback with a stated limitation" is the
   *default* path here, not the exception. Design for it first.

**Files.** Same set as AC-26 (they share the link model), plus `src/wiki/ask.ts`,
`src/wiki/section-tombstone.ts`, `src/testing/**` for test identity.

## 7. AC7 / AC-W05 — needs-review by grounds

Norm: `wiki-specification.md` §7 lines 88-90.

**Already holds (measured).**
- *An unrelated page is not touched.* The real-git probe run: of 50 pages, 12 fresh,
  4 not-code-scoped, 34 affected with reason chains; `cosmetic` changes seed no entry
  at all (`propagate.ts:69-80`). Selection is real, not blanket.
- *Priority does not hide the other findings.* `renderMarkdown`
  (`freshness/run.ts:211-213, 242-244`) hides `fyi` rows from the human view but
  states the hidden count and keeps the full set in `latest.json`. The dispatch's
  "the priority of one scenario does not hide the other findings" clause is
  satisfied by construction here.
- *An absent graph is not "everything is stale."* `report.ts:111-128` returns an
  empty report with a `graph-stale` limitation rather than accusing the corpus.
- *The agent-facing projection is honest.* `metaproject-adapter.ts:603-639`
  (`wikiFreshness`) returns a `status` + `reason` and never an empty `pages` list
  that reads as a clean wiki; `wiki_freshness`'s op description
  (`metaproject-operations.ts:894-899`) tells the caller to read `limitations`.
- *The queue is bounded.* `freshness/queue.ts:19-20, 110-127` — 10,000 lines /
  5 MB, one rotation generation, then drop. Answering the dispatch's
  "does anything here write without bound": on the phase-4 surfaces, **no**.
  `.metaproject/data/wiki/freshness/` holds only `latest.json` + `latest.md`,
  overwritten. (The 325 MB / 7,188-file `.metaproject/data/gdctx/raw` problem is
  real — I re-measured it — but it belongs to the gdctx lane, not this phase.)

**Fails, measured.**
1. **A git failure is not unknown** — the identical defect and the identical fix as
   AC-22 §3 above. Same probe, same numbers. These two clauses are one task.
2. **No dependent *section* is marked.** Everything here operates at **page**
   granularity: `ReportEntry.path` is a page, `AffectedPage.pageId` is
   `wiki:<page>.md`. The norm asks for "affected dependent *prose sections*" carrying
   a derived `needs-review` with a minimal source diff and dependency path. Reasons
   carry an `edgePath` but no source diff, and nothing is written back onto the page
   as a marker. Depends on AC-26's link model.
3. **Parallel prose edits are not protected.** The norm requires a SAC
   proposal/revision with `expectedVersion` and atomic CAS
   (`wiki-specification.md:90`). `src/sac/wiki-owner-writer.ts` and
   `src/sac/guarded-owner-writer.ts` exist and are the right seam, but no freshness
   or refresh path goes through them: `refresh.ts:287` and `refresh.ts:345` call
   `writeFile` directly, with no lock and no expected base. Two concurrent
   `wiki refresh` runs, or a refresh racing an editor, silently lose one side.

**Files.** `src/wiki/freshness/report.ts`, `propagate.ts`, `page-freshness.ts`,
`src/wiki/refresh.ts` (routing writes through the owner writer),
`src/sac/wiki-owner-writer.ts`, `src/sac/guarded-owner-writer.ts`.

## 8. Two recurring defect classes, per criterion

| AC | A capability nothing calls | A failure/absence made indistinguishable from a result |
|---|---|---|
| AC-08 | health/testing candidate collectors are unreachable for any accepted page; `wiki refresh --dry-run` is undocumented | a stale graph is stamped `VerifiedAt: <current HEAD>` and reads as verified |
| AC-21 | — (the shared writer *is* wired) | a crash mid-install leaves a partial tree that the next run cannot tell from a fresh one; no preview means "what would change" is unanswerable |
| AC-22 | health/testing budget: no calibration profile to call | **primary**: total git failure yields a report ≈ identical to the healthy one (measured 11 vs 12 fresh, same limitations) |
| AC-26 | the whole link model is absent, so nothing to strand yet; `wiki sections migrate` exists and has never been run (0/635 stable ids) | `completeness` cannot be reported because coverage is not modelled; absent symbol layer is the default, unflagged |
| AC-M02 | — | an unacknowledged re-delivery is indistinguishable from a first delivery; 9,508 bytes re-sent every prompt |
| AC-W03 | `wiki backlinks` returns 0 wiki pages for a real source file — the inverse index exists and answers nothing useful | a retrieval miss and an absent binding look the same to the caller (no `coverage`/`unknown` in the ask result) |
| AC-W05 | `checkPageStalenessGate` (`src/wiki/staleness.ts`) — **dead**, and it is exactly the staleness carrier this criterion needs | **primary**: same git-failure case as AC-22; also `gitCmd` conflates spawn error / non-zero exit / empty result into `null` |

**Programme-level note.** Both AC-22's and AC-W05's "a git failure yields unknown"
clauses reduce to one seam, `gitCmd` in `src/sync/provenance.ts:26-40`. That file is
imported repo-wide, so the fix is small in code and wide in blast radius — it wants
its own lane and its own ordering slot.

## 9. Proposed lanes (disjoint file sets)

**L1 — git failure becomes unknown.** *Closes: AC3 clause 2, AC7 clause 3.*
Owns `src/sync/provenance.ts`, `src/wiki/freshness/page-freshness.ts`,
`src/wiki/freshness/report.ts`, `src/wiki/freshness/run.ts` (+ their tests).
Done when: an injected always-failing `GitRunner` produces a report whose pages are
`unknown` with a stated reason and whose `limitations` names the failure; a partial
failure (rev-parse works, `log` fails) is equally distinguishable; the healthy-run
numbers are unchanged. **Highest value per line in the phase. Run first.**
Contended: `src/sync/provenance.ts` is imported by gdgraph, wiki, memory, sync — any
other lane touching it must sequence after L1.

**L2 — freshness sources and the stale-graph stamp.** *Closes: AC1.*
Owns `src/wiki/refresh.ts`, `src/wiki/service.ts` (candidate collectors +
`writeCollectedPage`), `src/wiki/staleness.ts` (delete or wire the dead gate),
`src/commands/wiki.ts` (refresh/verify/collect handlers + help).
Done when: a managed block exists on the health- and testing-sourced pages and a
changed `health/artifacts/latest.json` or `testing/context.md` updates it while
prose stays byte-identical; refresh consults `checkGraphStaleness` and refuses to
stamp `VerifiedAt` (or stamps it with an explicit `unknown`/`stale` qualifier) when
the graph is not `fresh`; `--dry-run` is documented; the repeat-no-diff and
no-churn properties measured above still hold.
Contended with L1 only through `report.ts`'s import of `provenance.ts` — no shared
file. Safe in parallel.

**L3 — section identity migration.** *Enables AC4 and AC6; closes nothing alone.*
Owns nothing in `src/`; owns the corpus under `.metaproject/wiki/**` and runs
`keryx wiki sections migrate --dry-run` then apply.
Done when: `keryx wiki sections` reports a non-zero stable-id count and 0 malformed;
`git diff` shows marker insertions only, no prose byte changed.
**Must complete before L4 and L5 can bind to anything durable.** Conflicts with L2
(both write wiki pages) — sequence L3 before or after L2, never concurrently.

**L4 — evidence links and reverse index.** *Closes: AC4, and AC6's binding half.*
Owns new `src/wiki/evidence-link.ts` + `src/wiki/evidence-index.ts`, and edits
`src/wiki/types.ts`, `src/wiki/section-index.ts`, `src/wiki/ask.ts`.
Done when: a link carries relation/ownerRef/targetVersion/qualification/provenance;
reverse lookup returns affected sections, dependency path, changed source version and
independent alternative grounds; a synthetic cycle terminates via a visited set;
re-running the indexer does not duplicate links; output is bounded with a loss
manifest; `completeness` is reported over known links only. Depends on L3.

**L5 — surfacing bindings and needs-review.** *Closes: AC6's delivery half, AC7's
marking half.* Owns `src/commands/wiki.ts` (ask/sections handlers — **conflicts with
L2**), `src/harness/tool/metaproject-operations.ts` + `metaproject-port.ts` +
`metaproject-adapter.ts`, `src/mcp/tools.ts`, `src/wiki/freshness/propagate.ts`.
Done when: `wiki ask` returns change points and tests alongside the explanation; a
rename or delete marks the binding `broken` and a same-named symbol elsewhere does
not capture it; a dependent section carries `needs-review` with source diff and
dependency path while an unrelated one does not; the capability exists on **all
three** surfaces (CLI, agent op, MCP). Depends on L4. Sequence after L2 on
`src/commands/wiki.ts`.

**L6 — prose writes through the owner writer.** *Closes: AC7's parallel-edit clause.*
Owns `src/sac/wiki-owner-writer.ts`, `src/sac/guarded-owner-writer.ts`, and the write
call sites in `src/wiki/refresh.ts` (**conflicts with L2** — sequence after it).
Done when: two concurrent refreshes of one page produce one apply and one conflict
with the current revision and a diff reference; an external editor's bytes invalidate
the base via digest check.

**L7 — install/update plan, preview and resume.** *Closes: AC2.*
Owns `src/commands/init.ts`, `src/commands/update.ts`, `src/commands/rules.ts`,
`src/lib/routing-entrypoint.ts`, plus a new plan/apply module under `src/lib/`.
Done when: `init`/`update` accept a preview that lists create/update/conflict/skip
with expected base digests and writes nothing; apply records completed/failed/pending
under stable step IDs; a fault-injected crash after step N leaves that state and a
rerun continues rather than restarting; the existing lifecycle fixture still passes
unchanged; the delivered scope explicitly does **not** claim rollback.
**Fully disjoint from L1-L6.** Largest item; start its design in parallel with L1.

**L8 — freshness cost: budget then scale.** *Closes: AC3 clauses 1 and 3.*
Owns a new calibration profile document + schema, new fixtures under `fixtures/`, a
new `scripts/benchmark/run-wiki-freshness-scale.ts`, and — **only after L1 lands** —
the batching/caching change inside `src/wiki/freshness/page-freshness.ts`.
Done when: the versioned calibration profile (latency budget, concurrency bound,
ranking weights) is recorded *before* any optimisation commit; 50/500/2000-page
corpora exist with a per-page oracle; cold and repeated runs agree in meaning with
the oracle at all three scales; git-operation counts are reported. **Sequence after
L1** (shares `page-freshness.ts`) and after the profile is agreed.

**L9 — pointer delivery.** *Closes: AC5.*
Owns `src/commands/orient.ts`, `src/ctx/orient.ts`, `src/ctx/orient-runtimes.ts`,
`src/session/**`, and a bootstrap op in
`src/harness/tool/metaproject-operations.ts` (**conflicts with L5** — sequence, or
split the op registry edit into one of the two lanes).
Done when: repeated prompts under one unchanged delivery key do not re-emit the same
orient block; a new root, a new routing revision, a new consumer or a compaction
raises the epoch and re-delivers the applicable constraints; a narrow subagent
receives root/scope/constraints/pointers while a navigating agent can expand the
full router; the implementation records no history on a pure read; nothing claims
guaranteed once-only delivery without an acknowledgement.

**Contended files, explicit.**
`src/commands/wiki.ts` — L2 and L5. `src/wiki/refresh.ts` — L2 and L6.
`src/wiki/freshness/page-freshness.ts` — L1 and L8.
`src/sync/provenance.ts` — L1, and every other lane transitively.
`src/harness/tool/metaproject-operations.ts` — L5 and L9.
`.metaproject/wiki/**` — L2 and L3.

**Ordering.** L1 and L7 and L3 start immediately and independently. L2 starts
immediately, sequences with L3 on the corpus. L8's profile half starts immediately;
its code half waits for L1. L4 waits for L3. L5 waits for L4 and L2. L6 waits for L2.
L9 is independent except for the op-registry edit.

## 10. Method, and what this pass wrote

Every measurement above was produced by a command run in this session:
`bun src/cli.ts wiki --help / wiki refresh --dry-run --json / wiki sections /
wiki backlinks / wiki ask --json / orient claude / init --help / update --help`,
`keryx ctx rg` for every code search (no bare `rg`/`grep` at any point), and one
scratchpad probe driving `buildFreshnessReport` with an instrumented and a failing
`GitRunner`.

**Deliberately not run:** `keryx wiki freshness`. Its `--help` calls it a
"read-only backlog", but `runFreshness` (`freshness/run.ts:88-94`) persists
`latest.json` + `latest.md` **and calls `clearQueue`, deleting the accumulated
`freshness-queue.jsonl`**. A pending queue exists in this tree; running it would have
consumed it. **The `--help` text is wrong and should be corrected in L2.** Also not
run: `wiki verify` (always writes, no dry-run), `wiki refresh` without `--dry-run`,
`wiki sections sync`, `wiki collect`, `keryx test analyze`, `keryx health run`,
`keryx gdgraph repomap`, `keryx gdgraph build`.

**Written by this pass:** this file, and — as an unavoidable side effect of the
mandated routing layer — roughly 25 pairs of `.metaproject/data/gdctx/raw/*.log` and
`.metaproject/data/gdctx/artifacts/*.md`. That directory now holds **7,188 raw logs
and 6,535 artifacts, 325 MB**, with no retention logic; this pass added to it. It is
gdctx's problem, not phase 4's, but the figure is now re-measured and larger than the
6,900 previously reported.

**Two more independent confirmations of the gdctx silent-truncation defect already
recorded as T5/T6 in this flow's journal** (which reported six): searching
`name: "` in `metaproject-operations.ts` returned a summary showing **4 of 16**
matches, and in `mcp/tools.ts` **1 of 25**, in both cases with the true count printed
in the header and no truncation marker in the body. I only got the full lists by
reading the raw log. That makes **eight**.

**Graph freshness caveat.** The gdgraph snapshot backing every graph-derived number
here was built at `60848c77` while HEAD is `886400e8`; the graph is stale and was not
rebuilt (out of scope for a read-only pass). Numbers derived from `loadGraph` — the
50-page corpus walk, the 24/16/10 refresh split — are therefore as-of that build, not
as-of the working tree. This does not affect the git-failure, orient-size,
section-id, dead-code or surface-enumeration findings, which do not read the graph.
