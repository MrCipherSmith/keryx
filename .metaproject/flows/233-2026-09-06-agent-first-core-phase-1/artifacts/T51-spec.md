# T51 spec — reconcile the two metaproject-adapter regressions

## Scope

Two failures in `src/harness/tool/metaproject-adapter.test.ts` (an unmodified,
committed test file) against two production files that carry uncommitted edits
from earlier work in this programme (`src/harness/tool/metaproject-adapter.ts`,
`src/gdskills/catalog.ts`). Per-file focused runs never caught these because no
task in this programme owned `metaproject-adapter.test.ts` itself.

## Failure 1 — `readWiki` escape-error wording (test line 223)

**Diff evidence** (`git diff -- src/harness/tool/metaproject-adapter.ts`):

```
-          error: `wiki path escapes the wiki root: ${input.path}`,
+          error: "wiki path is outside its root",
...
-        return { path: input.path, content: "", isError: true, error: errorMessage(cause) };
+        return { path: input.path, content: "", isError: true, error: "wiki page is unavailable" };
```

Both changes replace an interpolated/propagated message with a **constant**
string. This is exactly the shape of T6 ("secure contained resource readers"):
T6-implementation.md states the shared contained-reader seam was "integrated
into MCP resource reads/listing plus harness wiki and skill reads" and that
failures now "fail closed with **bounded typed errors**". A sibling test file,
`src/harness/tool/metaproject-adapter-containment.test.ts` (already
committed, not touched by this task), asserts exactly this bar for `readWiki`:
`assertSafeWikiError` requires `JSON.stringify(result)` to contain neither the
leaked file content nor the word `"outside"` sourced from an attacker-visible
path, i.e. error text must not echo path material. The **new** message,
`"wiki path is outside its root"`, is a fixed literal with no interpolation —
consistent with that bar. The **old** message embedded `input.path` verbatim
in the error string, which is the pattern this hardening phase was built to
remove.

**Consumer search.** `keryx ctx rg` (ripgrep-backed, project-mandated over raw
grep) for the exact strings:

- `"escapes the wiki root"` → only `metaproject-adapter.ts` (the removed
  comment `// escapes the wiki root` on `confineToWiki`, unrelated to the
  runtime string) and the two references inside this same test file. No
  other file, doc, or schema names or matches this wording.
- `"wiki path is outside its root"` → only the one production call site.
- `WikiPageResult` / `wiki_read` across `src/`, `docs/`, `.metaproject/core/`
  → two specification files reference the *type*, neither pins an exact
  error string.

No consumer — MCP tool schema, CLI output parser, docs, or another test —
depends on the old wording. The only place asserting it is the test this task
owns.

**Determination: the code is the contract.** The reworded constant message is
the deliberate, correct product of this phase's containment hardening, not
incidental drift. `metaproject-adapter.test.ts:223` will be corrected to
expect `"wiki path is outside its root"`, framed explicitly as a corrected
expectation (stale assertion catching up to a deliberate, leak-safer error
shape), not a weakening. Restoring the old wording would reintroduce raw path
text into an error result, which the task's own constraints forbid.

## Failure 2 — `skillsCatalog` fallback to `catalog.md` (test line 657)

**Diff evidence.** `src/gdskills/catalog.ts`'s diff only touches two unrelated
prose strings about `.metaproject/routing.md`; nothing there touches the
fallback logic — so `catalog.ts` is not actually implicated in this failure at
runtime (only listed as "carrying uncommitted edits" in the dispatch, which is
true but coincidental to this bug). The real cause is entirely in
`metaproject-adapter.ts`'s diff:

```
-    content = await readFile(join(cwd, ".metaproject", "skills", "catalog.md"), "utf8");
+    const bytes = await readContainedFile(
+      join(cwd, ".metaproject", "skills", "gdskills"),
+      join(cwd, ".metaproject", "skills", "catalog.md"),
+      { maxBytes: 512 * 1024, requireRegularFile: true },
+    );
```

`readContainedFile(ownerRoot, candidatePath)` (`src/lib/contained-read.ts`)
requires `candidatePath` to resolve *inside* `ownerRoot`
(`isInside(rootReal, targetReal)`, else `CONTAINED_READ_OUTSIDE`). The new
call passes `.metaproject/skills/gdskills` as the owner root, but
`catalog.md` lives at `.metaproject/skills/catalog.md` — a **sibling** of
`gdskills/`, not inside it. Every call therefore throws (either
`CONTAINED_READ_OUTSIDE` once resolved, or `CONTAINED_READ_NOT_FOUND` if
`gdskills/` itself doesn't exist yet in a given fixture), `parseCatalogSummaries`
catches it and returns an empty `Map`, and `walkSkillCatalog`'s fallback
(`description ?? catalogSummaries.get(skillDir.name) ?? ""`) always lands on
`""`. This reproduces the test failure exactly: `catalog.md` is written,
`gdgraph-router`'s own `SKILL.md` has no frontmatter description, and the
documented one-line-summary fallback (specification.md §3.1, restated in the
function's own doc-comment) never fires.

This is a wrong owner-root argument introduced while wiring the new
contained-read primitive through this call site — an incidental mistake in an
otherwise-deliberate hardening pass, not a deliberate behavior change. Nothing
in T6/T25's own implementation notes claims the catalog-summary fallback was
meant to stop working, and the function's doc-comment above `walkSkillCatalog`
still states the fallback is expected. An empty description where a
documented fallback exists is a real loss of behaviour.

**Consumer search.** `keryx ctx rg` for `parseCatalogSummaries` and
`.metaproject/skills/catalog.md` confirms the only reader of that file is this
one function; no other call site assumes a particular owner-root shape for it.

**Determination: the code has a bug; fix the code, not the test.** Change the
owner root passed to `readContainedFile` from the `gdskills` directory to its
parent, `.metaproject/skills` — the real directory that contains both
`catalog.md` and `gdskills/`. This preserves containment (the read stays
bounded under `.metaproject/skills/`, still refuses symlink/traversal escapes)
while letting the documented fallback actually read `catalog.md` again. No
change to `readContainedFile` itself, no change to `walkSkillCatalog`'s SKILL.md
containment (still correctly rooted at `gdskills/`), no change to the test.

## Plan

1. `src/harness/tool/metaproject-adapter.ts`: in `parseCatalogSummaries`,
   change the `readContainedFile` owner-root argument from
   `join(cwd, ".metaproject", "skills", "gdskills")` to
   `join(cwd, ".metaproject", "skills")`.
2. `src/harness/tool/metaproject-adapter.test.ts`: update the assertion at
   line 223 from `.toContain("escapes the wiki root")` to
   `.toContain("wiki path is outside its root")`, with a comment recording
   this as a corrected expectation following the T6 containment hardening.
3. Run the failing file before/after, then the owning directories, typecheck,
   and lint on the two changed files, per the verification list in the
   dispatch.
