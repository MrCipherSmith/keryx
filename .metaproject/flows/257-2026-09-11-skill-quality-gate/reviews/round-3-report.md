# Flow 257 review round 3 — verbatim report

Scope: one commit, `a91679b9`, the fix for round 2's three findings. Branch
`skills/quality-gate` at `731a8ef1`, which is the head of PR #540.
Reviewer: one agent, review-only, no source edits, no subagents.

STATUS: DONE_WITH_CONCERNS

Targeted suite green: 103 pass / 0 fail across the four named files.

## Claims checked

| claim | verdict | how checked |
|---|---|---|
| Removal stays out of `warnings` | true | `bun test src/gdskills/install.test.ts`; mutation removing the `severity === "warning"` filter in a scratch copy turns 3 tests red |
| Symlinked parent gives exactly one warning | true | `keryx update` on a scratch project with one removable and one symlinked build: 1 Notices line, 1 Warnings line |
| `keryx update` prints both headings, right order, empty one omitted | true | Same fixture (Notices at line 18, Warnings at 21); a second fixture with only a symlink gives `grep -c Notices` = 0 |
| No consumer silently loses removals | true | `keryx ctx rg "installGdskills\("` finds 3 command sites, all updated; every `result.warnings` assertion re-read |
| `notices` needs no schemaVersion bump | true | `skills install` has no `--json`; `InstallGdskillsResult` is never serialised |
| No `staleRuntimeBuildWarning` leftovers | true | `ctx rg "staleRuntimeBuildWarning"` over the tree: 0 |
| 17 distinct `docs/…` paths, 10 absent, 7 present | true (at the repo root) | Independent script replicating `PATH_REFERENCE` with `docs/` added over the whole bundled tree: exactly 17 / 10 / 7 |
| The six named autodoc outputs are among the absent | true | All six in the absent set; `docs/data-models.md` correctly added, `docs/skills/` correctly excluded |
| `docs/skills/` not in `package.json` `files` | true | `files` = dist, `docs/requirements/shared-agent-context/schemas`, src/gdgraph, src/gdskills/bundled, src/gdskills/contracts, … |
| The quote helper cannot pass vacuously | true | Three scratch mutations: one word changed turns the assertion red; heading renamed throws; blockquote deleted throws |
| "Collapses whitespace" normalises nothing that matters | true | `/\s+/g` to one space only; the rule wraps over 5 lines, the message is one line |
| A trim is green under `verify --bundled` and red in the ceiling check | true | Trimmed `quality/push/SKILL.md` from 73 to 68 lines in a scratch tree: `skills verify --bundled` exit 0, the `ceilingMismatches` test red |
| Bundled rule byte-identical to the `.metaproject` mirror | true | `shasum -a 256` on both: identical |
| Commit message matches the diff; no debug leftovers | true | Full diff read; `ctx rg` for TODO/FIXME/console.debug/`.only(`: 0 |

## Findings

**L1 — minor — `src/commands/init.test.ts:14-15`.** The header still cites
"init.ts:624 … init.ts:1089". After this commit `installGdskills` is at
`src/commands/init.ts:625` and the Warnings print at `:1099` — the ten lines the
commit added shifted both. The same commit de-line-numbered the identical rot in
`src/commands/update.test.ts:126-129` and
`src/commands/skills-install-warnings.test.ts:91-92`; this one was missed.

**L2 — minor — the new Notices print is untested at two of three call sites.**
`src/commands/skills.ts:109-114` and `src/commands/init.ts:1093-1098`. In a
scratch copy both print blocks were deleted (verified: `heading("Notices")`
count 0, `console.log("Notices:")` gone) and `install.test.ts`,
`update.test.ts`, `skills-install-warnings.test.ts` and `init.test.ts` still
gave 48 pass, 0 fail. Only `update.ts`'s print is covered. This is the failure
mode those files' own headers document as round-1 finding T-001 — "a regression
in either print survives a green run" — reintroduced for the new heading. The
comment at `src/gdskills/install.test.ts:427-428` is true of the result and does
not cover the print. Both prints do work: `keryx skills install` on a fixture
emits the Notices line.

**L3 — minor — `src/gdskills/bundled-eval.ts:1344-1350`.** The rewritten refusal
says the seven existing paths "DO exist here … The same citation would resolve
or break depending on whose tree the sweep runs in." Existence is checked as
`existsSync(path.join(root, resolved))` at `bundled-eval.ts:1558` with `root =
defaultBundledRoot()` = `src/gdskills/bundled` (`:1740`). Measured at both roots:
7 exist under the repository root, 0 under the bundled root. So with `docs` in
`CHECKED_PATH_ROOTS` all 17 would be findings in this tree too, and the citation
would break in every tree rather than resolving in this one. The counts, the six
names and the `package.json files` measurement are all correct; only this
inference is wrong. Correcting it strengthens the refusal.

**Info (no action taken).** The blockquote helper's docstring says "The one
blockquote", but `section.filter(startsWith(">"))` would silently concatenate a
second blockquote added to that section rather than throwing — the test would go
red with a confusing diff instead of a named error.

Out of scope: `.metaproject/data/gdgraph/*` and `wiki/freshness-queue.jsonl`
are dirty in the worktree (tool artifacts, not this commit).

## Checked and cleared

Notices/warnings placement for all six outcome kinds; `notices` absent from
every serialized shape; both rule copies identical and the new paragraph
accurate in both halves; the quote test bites on three independent mutations;
every commit-message claim matches the diff; no unrelated hunks; no debug
leftovers.

Routing audit: `graph_used: no (not-relevant — scope was one named commit)`,
`wiki_used: no (not-relevant)`, `ctx_used: yes`, `raw_rg_used: no` (raw `git
show` / `grep` only inside the scratch tree and for one escape-marked diff dump).

## Findings

```json keryx:findings
[
  {"id":"R3-m1","reviewer":"round-3","severity":"minor","file":"src/commands/init.test.ts","line":14,"problem":"The test header cites init.ts:624 and init.ts:1089; after a91679b9 those symbols are at :625 and :1099.","impact":"A reader follows the citation to the wrong lines, and the citation rots again on the next edit.","suggested_fix":"Name the symbol rather than the line, as the same commit did for update.test.ts and skills-install-warnings.test.ts.","evidence":"installGdskills is at src/commands/init.ts:625 and the Warnings print at :1099 at 731a8ef1; the commit added ten lines above both.","confidence":"high"},
  {"id":"R3-m2","reviewer":"round-3","severity":"minor","file":"src/commands/skills.ts","line":109,"problem":"The new Notices print is asserted at only one of its three call sites; skills.ts and init.ts print it untested.","impact":"A regression that drops the Notices print in either command survives a green run — the same failure mode those files' headers record as round-1 finding T-001, reintroduced for the new heading.","suggested_fix":"Add one assertion per uncovered call site, mirroring src/commands/update.test.ts:146.","evidence":"Deleting both print blocks in a scratch copy (heading(\"Notices\") count 0, console.log(\"Notices:\") gone) leaves install.test.ts, update.test.ts, skills-install-warnings.test.ts and init.test.ts at 48 pass / 0 fail.","confidence":"high"},
  {"id":"R3-m3","reviewer":"round-3","severity":"minor","file":"src/gdskills/bundled-eval.ts","line":1344,"problem":"The rewritten refusal infers that the citation would resolve in this tree and break in another; the sweep resolves paths against defaultBundledRoot(), under which none of the seven exists.","impact":"A recorded justification states something the code would not do, which is the defect the rewrite was meant to remove.","suggested_fix":"Say the seven exist at the repository root and that the sweep's own root would not see them either — the citation would break in every tree.","evidence":"existsSync(path.join(root, resolved)) at bundled-eval.ts:1558 with root = defaultBundledRoot() = src/gdskills/bundled (:1740). Measured: 7 of 17 exist under the repo root, 0 under the bundled root.","confidence":"high"}
]
```
