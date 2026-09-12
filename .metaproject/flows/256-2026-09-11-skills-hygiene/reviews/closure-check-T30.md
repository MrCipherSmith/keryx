# Flow 252 closure check T30: C-015, C-016, C-017

Dispatch `252-T30`. This is a targeted closure check of the user-approved fix past the review-loop bound. It is not a
full review round, and nothing was ingested.

- ROOT: `/Users/Goodea/goodea/keryx/.claude/worktrees/skills-quality`, branch `skills/quality-program`.
- HEAD: `8420d5539a5707d4f82e0c13169c62e07ce3f062`, "fix(skills): the orchestrators' task-boundary commit works whether
  or not the worker committed" (T29).
- Fix diff: `keryx ctx diff HEAD~1..HEAD`. It touches 12 files: flow-orchestrator SKILL.md, the 5 job-orchestrator
  builds, and the `.metaproject/skills/gdskills/` mirrors of all 6.
- Experiments ran only under `scratchpad/t30/`:
  - `extract.ts` pulls the bash block verbatim out of a SKILL.md.
  - `run.sh` substitutes the placeholders and nothing else, runs the result in fresh `git init` repos, and stubs
    `keryx` as an echo function.
  - `extract-json.ts` pulls out the dispatch JSON example.
- ROOT was not mutated. The dirty `.metaproject/data/*` and flow files in ROOT predate this check.

## Verdicts

| id | severity | verdict | method |
|---|---|---|---|
| C-015 | major | **closed** | execution (9 scenarios × 2 shells) + site-check + schema validation |
| C-016 | minor | **closed** | site-check across 5 builds + mirrors, and the schema field check |
| C-017 | info | **closed** | site-check across 5 builds |

One new **minor** (N-1) and two **info** notes (N-2, N-3) follow. None of them reopens C-015.

## C-015: closed

**The snippet in flow-orchestrator SKILL.md:377-392** was extracted verbatim. It runs `set --` over the paths, fills
`PENDING` from per-path `git status --porcelain -- "$p"`, skips when `PENDING` is empty, and otherwise runs
`git -C <wt> add -- "${PENDING[@]}"` and then `git -C <wt> commit -m … -- "${PENDING[@]}"`. The paths were substituted
single-quoted per path.

Command: `bash run.sh {bash,zsh} flow-orchestrator/SKILL.md "Task boundary commit, after every accepted" "changed_files from the subagent-result"`.
bash and zsh produced identical results:

| scenario | exit | commits added | result |
|---|---|---|---|
| s1: auto-commit off, `a.txt` modified, `new.txt` added, `del.txt` deleted | 0 | 1 | HEAD `M a.txt D del.txt A new.txt`; tree clean |
| s2: worker already committed `a.txt` | 0 | 0 | "boundary commit: nothing left to commit, skipped" |
| s3: empty change list | 0 | 0 | skipped |
| s4: `'dir/a b.txt'` modified plus `'dir/new c.txt'` added (paths with spaces) | 0 | 1 | HEAD `M dir/a b.txt A dir/new c.txt` |
| s5: another lane staged `other.txt`; worker reported `a.txt` | 0 | 1 | HEAD `M a.txt` only; `other.txt` **still staged** (`M  other.txt`); it was not swept in |
| s6: `'ghost.txt'` only (does not exist) | 0 | 0 | skipped |
| s6b: `'ghost.txt' 'a.txt'` | 0 | 1 | HEAD `M a.txt` |
| s7: deleted file only | 0 | 1 | HEAD `D del.txt` |
| s8: worker committed `a.txt` and left `new.txt` | 0 | 1 | HEAD `A new.txt` only |
| s9: worker already ran `git rm del.txt` (staged deletion) | 0 | 1 | HEAD `D del.txt`, but `git add` printed `fatal: pathspec 'del.txt' did not match any files` (see N-2) |

Every scenario the dispatch required exits 0 with the expected commit or skip. The stubbed
`keryx flow task done 252 T1` ran in every flow case.

**`<worktree_path>` is defined** at flow-orchestrator SKILL.md:324-330. It is the absolute root of the flow's checkout,
resolved once via `git rev-parse --show-toplevel` and checked with `branch --show-current`, and it points to
git-concurrency "Pinning A Dispatch To Its Worktree". The dispatch constraint at :359 pins the worker to it.

**The dispatch example validates.** It was extracted verbatim from :339-367 to `scratchpad/t30/dispatch.json`.
`bun ./src/cli.ts skills contracts validate …/dispatch.json --schema subagent-dispatch` prints
`valid: …/dispatch.json` / `schema: subagent-dispatch`, exit 0.

The step now runs "after every accepted worker result". It no longer fails when the worker committed, and :360 adds an
explicit "Auto-commit is off (automation.auto_commit: false): do not commit" constraint. Both fix options from round 3
are therefore in place. The status table at :414-415 points to the boundary step. The installed mirror is byte-identical
(bun string compare: `flow mirror identical: true`).

## C-016: closed

In all 5 builds (SKILL.md, SKILL.codex.md, SKILL.cursor.md, SKILL.zed.md, SKILL.opencode.md), at the same line numbers
per `keryx ctx rg -n … src/gdskills/bundled/skills/orchestration/job-orchestrator --all`:

- :828 `    ## Automation (task-implementer input \`automation\`)`
- :829 `    - auto_commit:      <implementer_settings.auto_commit>   # false: do not commit; report exact paths`
- :834 `    Commits: [abc1234 feat(x): ...]    # auto_commit=false: Commits: none (auto_commit=false)`
- :842-845 "Who commits is set by the dispatch, never by a default. Step B always passes `auto_commit` explicitly."

Byte parity came from a bun region compare against SKILL.md over three regions: the wave-loop STATUS block through
"continue to next wave", "## Automation (task-implementer" through "not swept into this commit.", and the sanity-check
row. Result: `true,true,true` for all 5 builds, and `mirror-identical: true` for all 5 mirrors.

**The field name and location match.** task-implementer `input-contract.schema.json:195-209` defines
`automation.auto_commit` (boolean, default `true`). The template labels its block "task-implementer input `automation`"
and sends `auto_commit`. The source is `implementer_settings.auto_commit` in job-orchestrator
`input-contract.schema.json:163-169` ("Settings passed to task-implementer sub-agents").

The job-orchestrator boundary snippet (:853-867) was run through the same harness: same 9 scenarios, bash and zsh
(`scratchpad/t30/job.out`). The outcomes are identical to the flow table above: every exit is 0, s5 does not sweep in
`other.txt`, and s2 and s3 skip.

## C-017: closed

job-orchestrator SKILL.md:769-778 (identical in all 5 builds) now reads: accept DONE/DONE_WITH_CONCERNS, then
`# Task boundary commit, for EVERY accepted result, before anything else` →
`FOR each accepted result: commit its still-changed reported paths, or skip` (:775). Only after that come
`any BLOCKED → STOP` and `otherwise → continue to next wave`. The sanity-check row at :949 now cites "the task-boundary
commit (wave loop, after Step B)".

## Consistency (who commits)

| auto-commit | git-concurrency.mdc Rule 4 (:68) / Reporting Back (:87) | task-implementer 4.5 (:316-331), 5.5 (:409-420) | job-orchestrator | flow-orchestrator |
|---|---|---|---|---|
| on | worker commits its own diff | commit, explicit paths, `git -C` | passes `true`; boundary step skips; commits any leftover and records a concern (:868-872) | not used: always dispatches off (:332-335) |
| off | worker does not commit, reports the exact list; orchestrator commits those paths | do not commit; report exact paths | passes `false`; boundary commits the reported paths | constraint :360; boundary commits `changed_files` |

There is no contradiction. The leftover-commit after an `auto_commit=true` worker is a recovery step, not a second
owner.

Destructive-git site check: every new `add` is `git -C <worktree_path> add -- "${PENDING[@]}"`, and the commit is
pathspec-limited. No `-A`, `--all`, `.` or stash appears.

Tests (`keryx ctx run -- bun test src/gdskills/destructive-git.test.ts src/gdskills/build-parity.test.ts src/gdskills/status-contract.test.ts src/gdskills/task-implementer-contract.test.ts`):
**33 pass, 0 fail**, 610 expect() calls, exit 0.

`bun ./src/cli.ts skills verify --bundled`: 67 skills, 169 documents, **findings: 0**, every check passes (including
`document:build-parity`), exit 0.

## New findings

### Minor

**N-1**: flow-orchestrator SKILL.md:378 and job-orchestrator SKILL.md:854 (all 5 builds and all mirrors). The
path-list placeholder gives no quoting rule, and an unquoted path containing a space makes the boundary step skip
silently, leaving the diff uncommitted.

`set -- <changed_files from the subagent-result>` and `set -- <files_modified files_created files_deleted from the result file>`
do not say that each path must be shell-quoted.

Execution: scenario s4b substituted `dir/a b.txt` unquoted, in bash and zsh, for both skills. The word splits into
`dir/a` and `b.txt`, each per-path status is empty, and the step prints
"boundary commit: nothing left to commit, skipped". It exits **0** with 0 commits, and status still shows
` M "dir/a b.txt"`. In flow-orchestrator, the next line then runs `keryx flow task done`, so the task is closed with
its diff uncommitted, which is exactly what Rule 4 forbids.

For comparison, an unquoted glob path (`app/[slug]/page.tsx`) fails loudly under zsh ("no matches found", exit 1, no
commit) and works under bash. The quoted forms (s4 and the bracket test) work in both shells.

This is not a regression of C-015: the prescribed mechanism is correct when paths are quoted. The failure mode is
silent, but it needs a path with whitespace.

Fix: annotate the placeholder, e.g. `set -- '<path1>' '<path2>' …   # each reported path single-quoted; may be none`,
in both skills and all builds.

### Info

- **N-2**: flow-orchestrator SKILL.md:386/:394-396 and job-orchestrator :862/:873-874. The per-path check does not
  filter out a deletion the worker already staged (`git rm`). For that path `git add -- del.txt` prints
  `fatal: pathspec 'del.txt' did not match any files`, but the script continues and `commit -- del.txt` records the
  deletion. The run exits 0 and the commit is correct (s9, both shells, both skills). The explanatory text ("`git add`
  fails on a path that is neither on disk nor tracked") does not mention this case, so an orchestrator could read the
  `fatal:` line as a failure. A sentence such as "a `fatal: pathspec` from `add` on an already-staged deletion is
  harmless; the commit line is authoritative" would cover it.
- **N-3**: flow-orchestrator SKILL.md:332 vs :375. :332 says "Workers do not commit: flow-orchestrator owns every
  commit". :375 says tests-creator commits its stubs on its own, and tests-creator SKILL.md:234-241 does commit.
  task-implementer reads auto-commit only from its `automation` object (SKILL.md:505-510). The flow dispatch carries the
  setting as a free-text constraint (:360), because `subagent-dispatch` has no `automation` field, so nothing
  mechanically enforces it. Either way the outcome is correct, because the boundary step skips a worker that committed
  (s2). This is wording tension, not a failure.

## Routing audit

- graph_used: not-relevant (a closure check of known sites named by the round-3 report)
- wiki_used: not-relevant
- ctx_used: yes (`keryx ctx diff`, `keryx ctx rg`, `keryx ctx run` for log, tests and verify)
- raw_rg_used: no
