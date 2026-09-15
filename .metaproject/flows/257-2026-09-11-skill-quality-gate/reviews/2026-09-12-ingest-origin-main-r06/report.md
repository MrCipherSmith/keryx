# Flow 257 review round 6 — verbatim report

Scope: one commit, `a1ea358c`, closing round 5's two findings. Branch
`skills/quality-gate` at `a1ea358c`, the PR head at the time. Reviewer: one
agent, review-only, no subagents. All experiments in scratch; the worktree was
left unchanged.

STATUS: DONE_WITH_CONCERNS

## Claims checked

| claim | verdict | how checked |
|---|---|---|
| The install completes, with no swallowed throw | true | Drove `installGdskills` twice against a symlinked category in scratch; the second call resolved and returned 1 warning / 0 notices |
| macOS `cp` accepts a symlinked skill directory (the comment's premise) | true | `fs.cp(src, symlinkToDir, {recursive, force})` succeeded on darwin |
| The test goes red if the symlink guard regresses | true | `lstat` → `stat` in `resolveSweepableDir` (scratch copy): the new test fails at `toHaveLength(1)`, receiving 8 |
| The refusal is emitted once per category, not once per skill | true | `orchestration` holds 8 skills and produces 1 warning. Breaking only the `categories` memo makes the new test the sole failure — nothing else covers it |
| The hand-written file is genuinely untouched | true | mtime and size unchanged across the install, while 8 sibling skill directories were written into the same directory — so it was reached, not merely unreachable |
| `mkdir(recursive)` leaves `<skillsRoot>/<category>/<name>` a real directory | true, but see the finding | Probe: `mkdir` creates `<name>` **inside the link target**; `lstat` reports a real directory and `readdir(skillsRoot)` shows only the link |
| Gates | all green | 31 pass / 0 fail; `tsc` exit 0; `eslint` exit 0; `skills verify --bundled` exit 0; `diff -rq` no output |

## Findings

**1 — minor — `src/gdskills/install.test.ts:347-353` and the test title at
`:354`.** The comment explains why the copy succeeds but not where it lands, and
the title says "install" where only the sweep refuses. `mkdir(..., { recursive:
true })` on a path whose category component is a symlink creates the skill
directory *in the link target*. Verified by execution: the second install copied
all 8 bundled `orchestration` skills — `SKILL.md`, schemas, prompts — into
`<root>/shared-skills/orchestration/`, outside `.metaproject` entirely. The
install **writes through** the link and only the *sweep* refuses to delete
through it. The comment's sentence is literally true (the path resolves to a
real directory) but stops one step short of the fact that makes it true, and "a
symlinked category is refused by a real install" reads as the install rejecting
the link. Rounds 4 and 5 each found an overstatement in this same block; this is
the same species — an elision, not a false statement, and no behaviour is wrong.

**2 — info — `install.test.ts:381-384` and `:389-390`.** Two assertions in the
new test are defence in depth rather than regression detectors: with the symlink
guard removed the `toHaveLength(1)` assertion trips first, and the belt-and-
braces realpath check keeps the file alive anyway. Worth keeping; just not what
makes the test load-bearing.

Nothing else at or above minor in the commit or its surroundings. The
`ERR_FS_CP_DIR_TO_NON_DIR` / `EISDIR` pair no longer claims a CI attribution,
and the `install.ts` twin at `:86-93` holds up as written.

Routing audit: `graph_used: no (single-file diff, paths known)`,
`wiki_used: not-relevant`, `ctx_used: yes`, `raw_rg_used: no`.

## Findings

```json keryx:findings
[
  {"id":"R6-m1","reviewer":"round-6","severity":"minor","file":"src/gdskills/install.test.ts","line":354,"problem":"The test name says a real install refuses a symlinked category; the install actually copies through the link, writing the bundled skills into the target, and only the sweep refuses to delete through it. The comment above stops one step short of the mkdir behaviour that makes its own claim true.","impact":"A reader takes the install for the thing that rejects the link, which is the opposite of what the code does — the third overstatement found in this one comment block.","suggested_fix":"Name the asymmetry in both the comment and the test title, and assert the write-through so the claim is checked rather than described.","evidence":"Executed: the second install copied all 8 bundled orchestration skills into <root>/shared-skills/orchestration/, outside .metaproject. mkdir(..., {recursive:true}) creates <name> inside the link target; lstat reports a real directory and readdir(skillsRoot) shows only the link.","confidence":"high"},
  {"id":"R6-i1","reviewer":"round-6","severity":"info","file":"src/gdskills/install.test.ts","line":381,"problem":"Two assertions in the new test never fire under a single-point regression — the toHaveLength(1) assertion trips first and the realpath belt-and-braces check keeps the file alive.","impact":"They read as regression detectors while being defence in depth.","suggested_fix":"Keep them; do not mistake them for what makes the test load-bearing.","evidence":"With the symlink guard removed, the first failure is toHaveLength(1) receiving 8; the hand-written file survives regardless.","confidence":"medium"}
]
```
