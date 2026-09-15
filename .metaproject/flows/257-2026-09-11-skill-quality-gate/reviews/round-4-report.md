# Flow 257 review round 4 — verbatim report

Scope: one commit, `aa209ae4` (6 files, +142/−20) — the CI fix and round 3's
three findings. Branch `skills/quality-gate` at `ae2ff9b7`, the PR head at the
time. Reviewer: one agent, review-only, no subagents.

STATUS: DONE_WITH_CONCERNS

## Claims checked

| claim | verdict | command / mutation |
|---|---|---|
| The test still checks everything it claimed | true | `install.test.ts:327-341`: the target file survives, `lstat` says symlink, whole-list `toEqual` with `action:"skipped-dir"` / `reason:"symlink"` / `blockedAt`, both message sentences, no notice-severity outcome and no `removed`. `bun test src/gdskills/install.test.ts` → 30 pass |
| The test bites | true, twice over | Scratch copy: disabling the symlink branch of `resolveSweepableDir` turns it red (`reason: "outside-skills-root"`); disabling both guards turns it red at line 327 with the hand-written `SKILL.zed.md` actually deleted |
| `ERR_FS_CP_DIR_TO_NON_DIR` is unreachable | sound | The only `cp` in the test is the first `installGdskills` on a clean tree (line 301); the mutations happen after it; `removeStaleRuntimeBuilds` makes only `lstat`, `realpath`, `readdir` and `unlink` calls |
| The sibling symlink tests are safe | true, one inventory detail off | The bundled job-orchestrator ships `SKILL.md`, `orchestrator-prompt.md` and three schemas — five files, not "SKILL.md plus three schemas" as the T24 report said; there is no `SKILL.codex.md`, so `cp` never addresses the link. The conclusion holds |
| No other test in the repo plants a non-directory where install copies | true | `ctx rg "symlink\("` over `src` finds 8 files; only `install.test.ts` reaches `installGdskills`; `:360` drives the sweep directly and `:727` is a file-level link in `rules/core` |
| The comment at the `cp` is accurate | true | `install.ts` order: `cp` :94 → `removeStaleRuntimeBuilds` :100 → `installBundledRules` :102 → `removeUnmodifiedRetiredRules` :462. A throw at :94 takes both |
| macOS really differs | true, by execution | Scratch probe: `fs.cp(dir, symlinkToDir, {recursive, force})` succeeds on darwin and copies *through* the link. The Linux half is confirmed indirectly: `typecheck-and-tests` is green at `ae2ff9b7` (18 checks pass) |
| The two new Notices tests bite and assert ordering | true | Scratch: deleting the Notices block in `skills.ts:125-130` and in `init.ts:1093-1098` turns each test red at `noticesAt > -1`; each also asserts the removal line's index is greater than `noticesAt`, and that `Warnings` never appears |
| The docs roots were re-measured correctly | true | An independent extractor over the bundled tree: 17 distinct paths, 7 under the repository root, 0 under the bundled root — exactly what the new sentence says. All six generated names are in the absent set, and `GENERATED_PATH_ROOTS` holds only `rules/entrypoints/`, so all 17 would indeed be findings |
| The `package.json files` bullet is untouched and correct | true | The field is `dist`, `docs/requirements/shared-agent-context/schemas`, `src/gdgraph`, `src/gdskills/bundled`, `src/gdskills/contracts`, plus LICENSE/README/package.json; no `docs/skills/` |
| The blockquote helper throws on a second quote | true | The rule has exactly one blockquote run today and the test passes; inserting a second into `## Length Ceilings` in a scratch copy gives `Error: "Length Ceilings" has 2 blockquotes; this comparison is written for the one quoting the anatomy:length message` |

## Findings

**F1 — minor — `src/gdskills/install.test.ts:322-324`.** The comment redirects
coverage: "That an install carries these outcomes through to
`warnings`/`notices` is the subject of the notice/warning-split test above."
That test exercises `kept-not-regular-file` → warning and `removed` → notice. No
test anywhere asserts a `skipped-dir` outcome reaching `result.warnings` —
`ctx rg "was not swept"` finds only `:336` and `:371`, both against
`staleRuntimeBuildMessage` directly. Behaviourally safe, since the mapping is a
kind-agnostic severity filter, but the sentence claims more than the cited test
delivers.

**F2 — info — the commit message of `aa209ae4`.** "No step calls `fs.cp` with a
non-directory destination on any platform, so the error is unreachable rather
than tolerated." Scoped to the test file this is true; read as a statement about
the codebase it is not — `installGdskills` still does exactly that whenever a
user's `skillDir` is a symlink, which is the behaviour the new `install.ts`
comment records as live. The two sentences sit three paragraphs apart and can be
read as contradicting.

**F3 — info — `src/gdskills/install.test.ts:314-324`.** The comment names
`ERR_FS_CP_DIR_TO_NON_DIR` under Bun, which could not be reproduced on this
platform; the code comes from the CI log via the flow journal, and CI green at
this head is consistent with it. The twin at `install.ts:86-93` hedges with
"/ EISDIR"; the test comment does not.

**Readability six months on:** `install.ts:91-92` cites "flow 257 T24", a
journal reference that will outlive easy lookup, though the surrounding prose
stands alone. The `init.test.ts:13-17` header now avoids line numbers (the
round-3 fix) but says the print lands "at the end of the scaffold summary";
hook lines and next steps print after it. Both trivial.

## Checked and cleared

The whole-list `toEqual`; the two strengthened "no removal claimed" assertions;
the `skillsRoot` / `.slice(2)` path refactor (identical path); the `blocks === 0`
/ `blocks > 1` split; the corrected `bundled-eval.ts` comment and its
`bundled-eval.test.ts` twin; every other commit-message claim.

Routing audit: `graph_used: not-relevant` (scope was one named commit),
`wiki_used: not-relevant`, `ctx_used: yes`, `raw_rg_used: no`.

## Findings

```json keryx:findings
[
  {"id":"R4-m1","reviewer":"round-4","severity":"minor","file":"src/gdskills/install.test.ts","line":322,"problem":"The comment sends the reader to the notice/warning-split test for the claim that an install carries these outcomes through, but that test covers a removal and a kept file, not a skipped directory.","impact":"A reader trusts coverage that does not exist — the same class of overstated claim this flow exists to remove.","suggested_fix":"Say the outcomes are carried by one kind-agnostic severity filter whose two branches that test covers, and state plainly that no test drives a skipped-dir outcome through an install.","evidence":"keryx ctx rg \"was not swept\" finds only install.test.ts:336 and :371, both asserting against staleRuntimeBuildMessage directly, never through installGdskills.","confidence":"high"},
  {"id":"R4-i1","reviewer":"round-4","severity":"info","file":"src/gdskills/install.test.ts","problem":"The commit message of aa209ae4 says no step calls fs.cp with a non-directory destination on any platform; that is true of the test file but not of installGdskills, which still does so whenever a user's skill directory is a symlink.","impact":"Two sentences of the same message can be read as contradicting each other.","suggested_fix":"Scope the sentence to the test, or leave it — a merged commit message cannot be edited without rewriting the branch.","evidence":"The install.ts comment added by the same commit records the live behaviour three paragraphs away from that sentence.","confidence":"high"},
  {"id":"R4-i2","reviewer":"round-4","severity":"info","file":"src/gdskills/install.test.ts","line":314,"problem":"The test comment names ERR_FS_CP_DIR_TO_NON_DIR without the hedge its twin in install.ts carries.","impact":"A reader may take the code as reproduced locally rather than read from a CI log.","suggested_fix":"Match install.ts and name the error the way CI reported it.","evidence":"install.ts:86-93 writes \"/ EISDIR\"; the test comment did not.","confidence":"medium"}
]
```
