# Flow 257 review round 5 — verbatim report

Scope: one commit, `162e34db`, comment-only, closing round 4's F1 and its info
note F3. Branch `skills/quality-gate` at `162e34db`, the PR head at the time.
Reviewer: one agent, review-only, no subagents.

STATUS: DONE_WITH_CONCERNS

## Claims checked

| claim | verdict | how checked |
|---|---|---|
| An install maps outcomes through ONE kind-agnostic severity filter | true | `staleRuntimeBuildSeverity` (install.ts:361) is `action === "removed" ? "notice" : "warning"` — blind to the four non-removed kinds; both `.filter`s at install.ts:119/123 call that one predicate |
| Both branches are covered by the notice/warning-split test | true | install.test.ts:220 drives `installGdskills` (line 233) and asserts `result.notices` holds the removal (236) and `result.warnings` holds the kept symlink (241-243), plus the removal absent from warnings (238-239) |
| No test drives a `skipped-dir` outcome through an install | true | `keryx ctx rg "skipped-dir"` over `*.test.ts`: only install.test.ts:337 and :372, both preceded by a direct `removeStaleRuntimeBuilds(skillsRoot)` call |
| Reaching a `skipped-dir` through an install needs the symlink this test plants | **false** | Executed counterexample — see F1 |
| The error-code hedge matches its twin | yes | install.ts:88-89 names `ERR_FS_CP_DIR_TO_NON_DIR` / `EISDIR`; the test comment now names the same pair |
| The hedge claims only what was observed | no | journal.md:108 quotes CI as `ERR_FS_CP_DIR_TO_NON_DIR` only; "as CI reported it" attaches the attribution to both codes |
| The commit is comment-only | true | Every changed line in `162e34db~1..162e34db` begins with `//`; one file, +9/−4 |
| Gates | green | `bun test src/gdskills/install.test.ts` 30 pass / 0 fail; `tsc --noEmit -p .` exit 0; `bun run lint` exit 0; `skills verify --bundled` exit 0; `diff -rq src/gdskills/bundled/rules/core .metaproject/rules/core` clean |

## Findings

**F1 — minor — `src/gdskills/install.test.ts:326-329`.** The new comment's last
sentence overstates, the same way round 4's F1 did. `skipped-dir` has three
reasons (install.ts:149, 264, 333) and is raised at the skills root
(install.ts:220-223) and per category (236-238), not only at a skill directory.
A symlink at either of those levels leaves the copy destination
`<skillsRoot>/<category>/<name>` a real directory created by the preceding
`mkdir(..., { recursive: true })`, so `fs.cp`'s non-directory-destination
refusal cannot arise — the install runs on any platform. Executed in the
scratchpad: with a symlinked *category*, `installGdskills(...).warnings` returns
`".metaproject/skills/gdskills/orchestration was not swept … it is a symlink"`;
with a symlinked *skills root*, likewise. The second shape is what
install.test.ts:352 already plants, driving the sweep directly. So an
install-level `skipped-dir` test is available and cheap; the comment tells the
next reader it is impossible.

**F2 — info — same hunk, line 318.** "as CI reported it" covers a pair of codes
where the journal records one. The twin in install.ts lists both without
attributing them.

Nit: the reflow left an orphan line — `// whole install BEFORE the sweep` /
`// runs — so…` (lines 319-320).

Nothing else at or above minor in this commit or its surroundings.

Routing audit: `graph_used: no (single known file, not-relevant)`,
`wiki_used: no (not-relevant)`, `ctx_used: yes`, `raw_rg_used: no`.

## Findings

```json keryx:findings
[
  {"id":"R5-m1","reviewer":"round-5","severity":"minor","file":"src/gdskills/install.test.ts","line":326,"problem":"The replacement comment says a skipped-dir outcome cannot be reached through an install; it can, one level up. A link at a category or at the skills root leaves the copy destination a real directory that mkdir just created, so fs.cp never meets a non-directory destination and the install completes on any platform.","impact":"The comment tells the next reader that an end-to-end test of the carry-through is impossible, when it is available and cheap — and that carry-through is the one half the direct-sweep test cannot reach.","suggested_fix":"Say which shape the copy cannot survive (the link at the skill directory) and add the install-level test the counterexample shows is possible.","evidence":"Executed in the scratchpad: with a symlinked category, installGdskills(...).warnings contains \".metaproject/skills/gdskills/orchestration was not swept ... it is a symlink\"; with a symlinked skills root, likewise. skipped-dir is raised at install.ts:220-223 (root) and :236-238 (category), not only at a skill directory.","confidence":"high"},
  {"id":"R5-i1","reviewer":"round-5","severity":"info","file":"src/gdskills/install.test.ts","line":318,"problem":"\"as CI reported it\" attributes both ERR_FS_CP_DIR_TO_NON_DIR and EISDIR to the CI log, which records the first only.","impact":"A reader takes an inferred code for an observed one.","suggested_fix":"Name the pair the way install.ts does, without the attribution; also fix the orphan line the reflow left.","evidence":"journal.md:108 quotes the CI failure as ERR_FS_CP_DIR_TO_NON_DIR; install.ts:88-89 lists both codes without attributing them.","confidence":"high"}
]
```
