# T51 — reconcile the two metaproject-adapter regressions

## Failure 1 — `readWiki` escape-error wording (`metaproject-adapter.test.ts:223`)

**What the diff showed.** `git diff -- src/harness/tool/metaproject-adapter.ts`
shows two error strings changed from interpolated/propagated text to fixed
literals:

```
-          error: `wiki path escapes the wiki root: ${input.path}`,
+          error: "wiki path is outside its root",
...
-        return { path: input.path, content: "", isError: true, error: errorMessage(cause) };
+        return { path: input.path, content: "", isError: true, error: "wiki page is unavailable" };
```

**Which side is the contract, and why.** The code is the contract. Evidence:

1. `.metaproject/flows/233-.../artifacts/T6-implementation.md` (task T6,
   "secure contained resource readers") states the shared contained-reader
   seam was integrated into "harness wiki and skill reads" and that failures
   now "fail closed with bounded typed errors" — i.e. deliberately generic,
   non-leaking error shapes, not raw propagated text.
2. The committed sibling file `src/harness/tool/metaproject-adapter-containment.test.ts`
   (untouched by this task) enforces exactly this bar today for `readWiki`:
   its `assertSafeWikiError` helper requires the serialized result to name no
   path and no leaked content. The old message embedded `input.path` verbatim
   in `error`; the new one is a fixed string with no interpolation — the
   pattern this hardening removes.
3. The journal entry at `.metaproject/flows/233-.../journal.md` (session
   2026-09-06T15:35) independently reached the same read before this task was
   dispatched: "Скорее всего это след containment-работы, где формы ошибок
   делали константными и leak-safe" ("most likely a trace of the containment
   work, where error shapes were made constant and leak-safe").

**Consumer search and method.** Ran `keryx ctx rg` (the project's mandated
ripgrep wrapper, never bare `rg`/`grep`) for the exact strings:

- `"escapes the wiki root"` over the whole repo → 3 hits: the two assertions
  in this test file, and one now-stale code *comment* on `confineToWiki`
  (`// escapes the wiki root`), which documents the function's own logic, not
  a returned string, and was left alone.
- `"wiki path is outside its root"` over the whole repo → 1 hit, the single
  production call site.
- `WikiPageResult` and `wiki_read` over `src/`, `docs/`, `.metaproject/core/`
  → two specification files reference the *type shape*, neither pins an exact
  `error` string.

No MCP tool schema, CLI output parser, doc, or other test depends on the old
wording. The only place asserting it was this test.

**Resolution.** Updated `metaproject-adapter.test.ts:218-227` to expect
`"wiki path is outside its root"`, with an inline comment stating this is a
corrected expectation catching up to T6's deliberate leak-safe rewording —
not a weakened assertion. `result.isError`/`result.content` assertions (the
behavioral core of the test) are unchanged.

## Failure 2 — `skillsCatalog` catalog.md fallback (`metaproject-adapter.test.ts:657`)

**What the diff showed.** `git diff -- src/gdskills/catalog.ts` touches only
two unrelated prose strings about `.metaproject/routing.md` (a doc-routing
sentence inside `BUNDLED_GDSKILLS` and inside `renderGdskillsCatalog`'s
"Resolution order" list) — nothing in that file touches the description
fallback. `catalog.ts` is not actually the cause of this failure at runtime,
despite being one of the two files flagged as carrying uncommitted edits.

The actual cause is in `metaproject-adapter.ts`'s diff, in
`parseCatalogSummaries`:

```
-    content = await readFile(join(cwd, ".metaproject", "skills", "catalog.md"), "utf8");
+    const bytes = await readContainedFile(
+      join(cwd, ".metaproject", "skills", "gdskills"),
+      join(cwd, ".metaproject", "skills", "catalog.md"),
+      { maxBytes: 512 * 1024, requireRegularFile: true },
+    );
```

`readContainedFile(ownerRoot, candidatePath)` in `src/lib/contained-read.ts`
requires the resolved `candidatePath` to sit *inside* `ownerRoot`
(`isInside(rootReal, targetReal)`; otherwise `CONTAINED_READ_OUTSIDE`). The
new call passes the `gdskills/` directory as owner root, but `catalog.md`
lives at `.metaproject/skills/catalog.md` — a **sibling** of `gdskills/`, not
a descendant. Every call therefore fails (outside-containment once resolved,
or not-found if `gdskills/` doesn't yet exist in a given fixture),
`parseCatalogSummaries`'s `catch` returns an empty `Map`, and
`walkSkillCatalog`'s fallback expression
(`description ?? catalogSummaries.get(skillDir.name) ?? ""`) always lands on
`""`. Reproduced exactly: the RED run before the fix showed
`Expected: "Route graph questions to gdgraph." / Received: ""` at line 657.

**Which side is the contract, and why.** The code has the bug; the test is
correct and stays as-is. The function's own doc-comment above
`walkSkillCatalog` (unchanged by the diff) still documents the fallback as
expected behavior, and nothing in T6/T25's implementation notes claims the
catalog-summary fallback was meant to regress — this is an incidental wrong
argument introduced while wiring the new contained-read primitive through
this call site, not a deliberate behavior change. An empty description where
a documented fallback exists is a real loss of behaviour, argued from the
code: the doc-comment, the fallback expression, and the containment
primitive's own contract (owner root must be an ancestor of the read target)
all agree the fix is to correct the owner root, not to accept the empty
description as new truth.

**Consumer search and method.** `keryx ctx rg` for `parseCatalogSummaries` and
for `.metaproject/skills/catalog.md` across `src/` confirms this function is
the only reader of that file; no other call site assumes a particular
owner-root shape for it, so widening the owner root to its true parent has no
other blast radius.

**Resolution.** In `src/harness/tool/metaproject-adapter.ts`,
`parseCatalogSummaries` now passes `join(cwd, ".metaproject", "skills")` (the
real parent directory that contains both `catalog.md` and `gdskills/`) as the
owner root, instead of `join(cwd, ".metaproject", "skills", "gdskills")`.
Containment is preserved — the read stays bounded under
`.metaproject/skills/` and still refuses symlink/traversal escapes outside
that tree — while the documented fallback can read `catalog.md` again. Added
a code comment recording why the owner root must be the shared parent.
`readContainedFile` itself, `walkSkillCatalog`'s SKILL.md containment (still
correctly rooted at `gdskills/`), and the test file are all unchanged for
this failure.

## Files changed

- `src/harness/tool/metaproject-adapter.ts` — `parseCatalogSummaries`'s
  `readContainedFile` owner root corrected from `.metaproject/skills/gdskills`
  to `.metaproject/skills`.
- `src/harness/tool/metaproject-adapter.test.ts` — one assertion corrected
  from the retired interpolated wiki-escape message to the current
  leak-safe constant, with a comment stating the justification.

No other file touched. `src/gdskills/catalog.ts` was read and searched but
not modified — its uncommitted diff is unrelated to either failure.

## Verification

| Check | Result | Evidence |
|---|---|---|
| `bun test src/harness/tool/metaproject-adapter.test.ts` (before fix) | 29 pass / 2 fail — the two named failures, reproduced verbatim | `.metaproject/data/gdctx/raw/2026-09-06T15-38-37-196Z_run.log` |
| `bun test src/harness/tool/metaproject-adapter.test.ts` (after fix) | 31 pass / 0 fail | `.metaproject/data/gdctx/raw/2026-09-06T15-38-53-162Z_run.log` |
| `bun src/cli.ts ctx run -- bun test src/harness src/gdskills` | 2069 pass / 9 skip / 0 fail across 159 files | `.metaproject/data/gdctx/raw/2026-09-06T15-39-11-517Z_run.log` |
| `bun run typecheck` | clean (`tsc --noEmit`, no output) | ran directly, no findings to route |
| `bunx eslint src/harness/tool/metaproject-adapter.ts src/harness/tool/metaproject-adapter.test.ts` | clean, no output | ran directly, no findings to route |

Diff commands used to establish provenance (read-only, no git state changed):
`bun src/cli.ts ctx run -- git diff -- src/harness/tool/metaproject-adapter.ts`
(`.metaproject/data/gdctx/raw/2026-09-06T15-36-26-112Z_run.log`) and
`bun src/cli.ts ctx run -- git diff -- src/gdskills/catalog.ts`
(`.metaproject/data/gdctx/raw/2026-09-06T15-36-27-814Z_run.log`).

## Routing audit

`graph_used: not-relevant` — both failures were pinpointed directly from the
dispatch's named line numbers and the uncommitted diffs of the two implicated
files; no structural/dependency question (blast radius, cycles, orphans) was
in scope, so gdgraph would have added a lookup without narrowing anything.
`wiki_used: not-relevant` — no architecture/domain/business-rule question was
open; the relevant "why" (T6's containment rationale) lived in this flow's own
task artifacts (`T6-implementation.md`, `journal.md`), which were read
directly per the dispatch's file list, not through gdwiki. `ctx_used: yes` —
every diff, search, and command run (both `git diff`s, both `rg` searches,
all `bun test` runs) went through `keryx ctx run` / `keryx ctx rg`, each
recorded under `.metaproject/data/gdctx/raw/`. `raw_rg_used: no`.
