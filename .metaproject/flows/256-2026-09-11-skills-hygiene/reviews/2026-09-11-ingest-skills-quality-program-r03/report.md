# Flow 252 review round 3: verified report

Dispatch `252-T4-r3` (final round). Scope: closure of the round-2 findings, plus a review of the round-2 fix diff
`0cdc36d1..HEAD` on `skills/quality-program`, HEAD `cb4175a3f24281b4da3f6b2781e4188c3c929f10`. The fix commits are
`2db34d71` (T27), `75b45f69` (T25) and `cb4175a3` (T26). `ec6aa99e` adds only the round-2 flow docs.

One agent ran every pass with no subagents. Experiments ran under `scratchpad/r3/`:
- tmp projects `proj9` (skill sync) and `proj8` (rules), each with its own tmp HOME;
- `closure.ts`, which imports `installGdskills` read-only from ROOT/src;
- a `git archive HEAD` copy (`r3/mut`) for mutations;
- a throwaway repo (`gitnoop`) for git behaviour.

ROOT was never mutated. Seven `.metaproject/data/{gdgraph,testing,wiki}` files show as modified in ROOT. Their mtimes
(17:08Z and 19:38Z) are before this round began (19:56Z), so this round did not produce them.

## Stage counts

| stage | count |
|---|---|
| round-2 findings re-checked (C-003, C-009, C-010, C-011, L-008, C-012, C-014, T-008) | 8 |
| fixed | 8 |
| partially fixed | 0 |
| not fixed | 0 |
| new candidates (blocker/major/minor) | 2 |
| refuted | 0 |
| retained new (blocker/major/minor) | 2 |
| new info | 1 |
| findings in the `keryx:findings` block | 3 |

Retained new findings by severity: blocker 0, major 1 (C-015), minor 1 (C-016), info 1 (C-017). Both retained findings
came from the C-010 fix commit `cb4175a3`. Method: execution plus site-check for C-015 and C-016, and site-check for
C-017. C-013 and S-004 (round-2 info, unchanged) are not re-raised.

No `round-3-verifications.json` is written. As in round 2, the reviewer that raised each finding also checked it, and AC9
forbids recording that as a verification. The evidence is in each finding's `evidence` field.

## Closure of round-2 findings

| id | verdict | method | evidence at HEAD |
|---|---|---|---|
| C-009 | fixed | execution | See "C-009 execution" below. `proj9` followed skills-storage-workflow.mdc as prescribed, with HOME=`r3/home9` holding `.cursor`, `.codex`, `.config/zed` and `.config/opencode`, CODEX_HOME unset, and every command run as `bun ROOT/src/cli.ts`. Every step succeeds as the rule describes, and the shipped-skill statement (:77-82, :102, :135-137) holds. |
| C-003 | fixed | execution | Its remaining part was C-009, closed above. The home-directory mapping in the rule (:84-89) now matches `GLOBAL_SKILL_SYNC_TARGETS` (sync.ts:49-54) and the observed landing paths. |
| C-010 | fixed (as raised); the fix introduces C-015 and C-016 | site-check + execution | See "C-010 site check" below. When auto-commit is off, all four texts agree that the orchestrator commits, and every command is scoped `git -C <root> add <explicit paths>`. job-orchestrator's zero-commit sanity row is exempted for `auto_commit=false` (:917). New defects: flow-orchestrator also commits when auto-commit is on (C-015), and job-orchestrator never forwards `auto_commit` to the worker (C-016). |
| C-011 | fixed | execution + site-check | rule-management-workflow.mdc:15-26 splits the source of truth. keryx's shipped rules are edited in `src/gdskills/bundled/rules/core/`. A project's own instructions go in the root `AGENTS.md`/`CLAUDE.md` and are imported with `keryx rules sync`/`distill`. :37-40 matches. Execution in `proj8` (init, then append a line to AGENTS.md, then `rules sync`): exit 0, "AGENTS.md -> .metaproject/rules/agents-md.md (high)" and "CLAUDE.md -> .metaproject/rules/claude-md.md (high)", and the appended line is present in agents-md.md. `rules distill --dry-run` exits 0. |
| L-008 | fixed | execution | See "L-008 execution" below. `closure.ts` covers all four cases, the ROOT baseline is green, and all four mutations are KILLED. |
| C-012 | fixed | execution | review-orchestrator SKILL.md:89-94, :673 and :1568 now say that `inherit: true` appears only when the session has no provider or model, and that a failed ranking names the session's own model. Execution (tmp HOME, `--catalog []`): with no session, exit 0 and `"inherit": true`, `tier_resolution: session-fallback`. With `--session-provider acme --session-model acme-1`, exit 0 and `provider: acme`, `model: acme-1`, `session-fallback`, `ranked: []`, and no inherit. That matches review.ts:838-846. |
| C-014 | fixed | site-check | templates.ts:1749-1752 and ROOT `.metaproject/rules/README.md`:26-29 now read "otherwise it is kept (with a warning that says why — edited, not a regular file, oversized, or unreadable/unremovable)". That covers every kept-* outcome in install.ts. templates.test.ts is green. |
| T-008 | fixed | site-check + execution | install.ts:220 exports `normalizeRetiredRuleContent`. install.test.ts:9 imports it and :287 hashes the fixtures with it. The duplicate `normalizeRetiredRuleContentForTest` is gone. install.test.ts is green (see L-008). |

### C-009 execution

Each step of the `proj9` run:

1. `init --yes …`: exit 0.
2. Pre-Sync Validation, `skills verify --all`: exit 0 ("No project skills registered.").
3. `update`: exit 0.
4. `skills create src/demo --module docs --name demo-skill`: exit 0, creating `.metaproject/project-skills/docs/demo-skill/`. A `SKILL.cursor.md` build was added.
5. For each of cursor, codex, zed and opencode, `skills export demo-skill --runtime <r>` exits 0. Each writes `.metaproject/runtime/skills/<r>/docs-demo-skill/`, which is the rule's `<module>-<skill-name>` (:76).
6. `skills sync --runtime <r> --global` exits 0 for each runtime. The files land at `home9/.cursor/skills/docs-demo-skill/SKILL.md`, `home9/.codex/skills/…`, `home9/.config/zed/skills/…` and `home9/.config/opencode/skills/…`, which matches :86-89.
7. The cursor copy ends in `CURSOR BUILD`, so it was built from `SKILL.cursor.md` (:86).
8. `skills export task-implementer --runtime cursor` exits 1 with "Project skill not found for: task-implementer", exactly the message the rule quotes at :79.

### C-010 site check

Who commits when auto-commit is off:
- git-concurrency.mdc:68: "When it is disabled, the worker does not commit … the orchestrator stages and commits those paths at the task boundary."
- task-implementer SKILL.md:327-331 (and :419-420), identical in all 5 builds and the installed mirror: "When auto-commit is disabled, do not commit. Report the exact list … the orchestrator stages and commits those exact paths at the task boundary."
- job-orchestrator SKILL.md:833-844, identical in all 5 builds and their mirrors: "Task boundary commit (`implementer_settings.auto_commit=false` only)", then `git -C <worktree_path> add <files_modified/files_created/files_deleted from the result file>` and `git -C <worktree_path> commit -m …`. :844 reads "When `auto_commit=true`, the worker already committed — skip this step."
- flow-orchestrator SKILL.md:354-364 and :380-381: "After a worker succeeds, stage and commit exactly the worker's `changed_files` … `git -C <worktree_path> add <changed_files from the subagent-result>`". This step is unconditional.

`cmp` confirms that the bundled and installed copies are byte-identical for job-orchestrator (5 builds), flow-orchestrator, task-implementer (5 builds), the three edited rules and review-orchestrator.

### L-008 execution

`closure.ts` runs `installGdskills` from ROOT/src with profile minimal and one fresh project per case:
- An unmodified copy in a `chmod 555` rules/core gives `ok:true`, the file kept, and exactly one warning: "…matches a shipped version but could not be removed (EACCES) — delete it by hand".
- An unreadable file (`chmod 000`) still gives "kept because it could not be read (EACCES)".
- A modified copy in a read-only directory gives "differs from every shipped version".
- An unmodified copy in a writable directory is removed with no warning.

install.ts:150, :171 and :175 set the stage, and :260-262 branches on it. ROOT baseline: `bun test src/gdskills/install.test.ts src/lib/templates.test.ts` gives 42 pass and 0 fail.

Mutations in `r3/mut`, which fails 2 environmental tests at baseline because it has no `.metaproject` mirror:

| mutation | result | killed by |
|---|---|---|
| M1: drop `stage = "unlink"` | KILLED | the new read-only-directory test (install.test.ts:446) |
| M4: `outcome.stage === "unlink"` → `false` | KILLED | the new read-only-directory test |
| M2: → `true` | KILLED | the existing chmod-000 test (:402) |
| M3: label the read stage `unlink` | KILLED | the existing chmod-000 test |

## Fix-diff review (`0cdc36d1..HEAD`)

Nothing to report in:
- **install.ts / retired-rules.ts (T27).** `stage` is set immediately before each awaited step. The ENOENT race still
  `continue`s. `RetiredRuleFailureStage` is a closed union, and the one `kept-error` producer always supplies it. The
  switch stays exhaustive (`never`).
- **install.test.ts.** The new test skips for root and win32 and restores permissions in `finally`. It asserts the exact
  warning count and both the positive and the negative wording, and it kills M1 and M4. Its comment claims that a second
  install writes only files that already exist in rules/core. The test passing, and the closure case, both bear that out.
- **templates.ts and rules README (C-014).**
- **skills-storage-workflow and rule-management-workflow (T25).** Every prescribed command was executed, as above.
- **review-orchestrator wording.** It matches the executed behaviour.

Findings in the orchestrator commit-step text from T26 follow.

## New findings

### Major

**C-015**: src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:354-364 (also :380-381 and the installed
mirror). The new boundary commit is unconditional, and on flow-orchestrator's default path it fails.

flow-orchestrator's task-implementer dispatch (:326-351) carries no `auto_commit`, and `subagent-dispatch.schema.json`
has no such field (0 matches). task-implementer therefore runs with its default `auto_commit: true`
(input-contract.schema.json:206-209) and commits its own diff (SKILL.md:318-325). flow-orchestrator is then told to
`git -C <worktree_path> add <changed_files>` and `git -C <worktree_path> commit`.

Execution in `r3/gitnoop` (a worker commit, then the orchestrator's prescribed step on the same path): `git add` exits 0,
and `git commit` prints "nothing to commit, working tree clean" and exits 1. The same happens for any review, context or
docs worker with empty `changed_files`: `git add` with no pathspec prints "Nothing specified, nothing added." and the
commit fails. `<worktree_path>` is also undefined in flow-orchestrator. Its only two occurrences are :359-360, and the
skill has no step that creates or names a worktree.

This contradicts git-concurrency.mdc:68 ("committed … by whoever owns commits") and job-orchestrator :833/:844, where the
orchestrator commits only when `auto_commit=false`. Every successful task on the default configuration now ends in a
prescribed command that fails.

Fix: make the step conditional, in the same way as job-orchestrator. Either:
- commit only the reported paths that `git -C <root> status --porcelain -- <paths>` still shows as changed, and skip when
  nothing is left or `changed_files` is empty; or
- have flow-orchestrator own commits explicitly, by adding an "auto-commit disabled: do not commit, report changed_files"
  constraint to the dispatch.

In either case, name the root, e.g. `<project_or_worktree_root>` bound to the flow, instead of an undefined
`<worktree_path>`.

### Minor

**C-016**: src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:801-830 (and the 4 builds and mirrors).
`implementer_settings.auto_commit` never reaches the worker.

input-contract.schema.json:163-170 describes `implementer_settings` as "Settings passed to task-implementer sub-agents",
but the Step B dispatch's Workspace block (:813-821) lists only worktree_path, branch, package_manager, run_command,
issue_number, job_name and context_path. The only mentions of `auto_commit` in the skill are :833, :844 and :917, and
the required response format (:823-827) always asks for `Commits: [...]`.

With `auto_commit=false`, the worker defaults to `true` (task-implementer input-contract :206-209) and commits anyway.
The boundary step at :839-842 then hits the same `git commit` exit 1 ("nothing to commit"), reproduced in
`r3/gitnoop`. The ownership statement at git-concurrency.mdc:68 holds only on paper.

Fix: add `- auto_commit: <implementer_settings.auto_commit>` to the Step B Workspace block. Make `Commits:` conditional
("`Commits: none (auto_commit=false)`"). Mirror both changes across the 5 builds.

### Info

- **C-017** job-orchestrator SKILL.md:752-772. The wave-loop pseudo-code, which is the control flow an orchestrator
  follows, still goes "all DONE → continue to next wave" with no commit step. The auto_commit=false boundary commit
  appears only as a paragraph after the dispatch template (:833), and :917 cites it as "(Step B)". Add
  `IF auto_commit=false: task-boundary commit per accepted result` inside the loop, before moving to the next wave.
  Site-check.

```json keryx:findings
[
  {
    "id": "C-015",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "line": 354,
    "problem": "The new flow-orchestrator boundary commit is unconditional. Its task-implementer dispatch carries no auto_commit (subagent-dispatch.schema.json has none), so the worker runs with its default auto_commit=true and commits itself. The prescribed `git -C <worktree_path> add <changed_files>` + `git -C <worktree_path> commit` then has nothing to commit and exits 1. `<worktree_path>` is undefined in this skill.",
    "impact": "On flow-orchestrator's default path, every successful task ends in a prescribed git command that fails. Workers with empty changed_files (review, context, docs) fail the same way. The text contradicts git-concurrency.mdc:68 ('whoever owns commits') and job-orchestrator :833/:844, where the orchestrator commits only when auto_commit=false. That leaves commit ownership ambiguous in exactly the area the rule governs.",
    "suggested_fix": "Make the step conditional. Commit only the reported paths that `git -C <root> status --porcelain -- <paths>` still shows as changed, and skip when nothing is left or changed_files is empty. Alternatively, have flow-orchestrator own commits by adding an 'auto-commit disabled: do not commit, report changed_files' constraint to the dispatch. Replace the undefined <worktree_path> with the flow's bound project/worktree root. Mirror the change.",
    "evidence": "Execution in scratchpad/r3/gitnoop: a worker commit of a.txt, then `git -C <repo> add a.txt` exits 0 and `git -C <repo> commit -m ...` prints 'nothing to commit, working tree clean' and exits 1. With no paths, `git add` prints 'Nothing specified, nothing added.' Site-check: flow-orchestrator SKILL.md:326-351 has no auto_commit field; `keryx ctx rg -n auto_commit src/gdskills/contracts/subagent-dispatch.schema.json` gives 0 matches; task-implementer input-contract.schema.json:206-209 has auto_commit default true; task-implementer SKILL.md:318-325 commits when auto-commit is enabled; `keryx ctx rg -n -i worktree` over flow-orchestrator SKILL.md finds only :234 (a rule citation) and :359-360.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:354-364",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:380",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:381",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:354-364",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:380",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:381",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:833-844 (correct: conditional on auto_commit=false; same in SKILL.codex/cursor/zed/opencode.md and mirrors)"
      ],
      "enumeration_method": "`keryx ctx rg -n -i \"commit (exactly|the worker|changed_files)|stage and commit|task.boundary commit|orchestrator (stages|commits)\" src/gdskills/bundled --all` finds the orchestrator-side commit prescriptions only in flow-orchestrator and in the 5 job-orchestrator builds. task-implementer and git-concurrency hits describe the protocol and are not orchestrator steps. `cmp` shows the installed mirror is byte-identical, with the same line numbers."
    }
  },
  {
    "id": "C-016",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 813,
    "problem": "implementer_settings.auto_commit is described as 'Settings passed to task-implementer sub-agents' (input-contract.schema.json:165), but the Step B dispatch Workspace block (:813-821) never passes it, and the required response always asks for 'Commits: [...]'. The only auto_commit mentions in the skill are :833, :844 and :917.",
    "impact": "With auto_commit=false, the worker defaults to true and commits anyway. The new task-boundary commit (:839-842) then has nothing to commit and exits 1. The auto-commit-off ownership that git-concurrency.mdc:68 and task-implementer :327-331 describe never actually happens under job-orchestrator.",
    "suggested_fix": "Add `- auto_commit: <implementer_settings.auto_commit>` to the Step B Workspace block, and make the 'Commits:' response line conditional (e.g. 'Commits: none (auto_commit=false)'). Mirror across SKILL.codex/cursor/zed/opencode.md.",
    "evidence": "Site-check: `keryx ctx rg -n \"implementer_settings|auto_commit\"` over job-orchestrator SKILL.md finds only :833, :844 and :917. The Step B template at :801-830 has no auto_commit. task-implementer input-contract.schema.json:206-209 has default true. Execution (scratchpad/r3/gitnoop): after a worker commit, the orchestrator's add+commit exits 1 with 'nothing to commit, working tree clean'.",
    "confidence": "high"
  },
  {
    "id": "C-017",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 769,
    "problem": "The wave-loop pseudo-code (:752-772) goes 'all DONE -> continue to next wave' with no commit step. The auto_commit=false task-boundary commit appears only as a paragraph after the dispatch template (:833), and :917 cites it as '(Step B)'.",
    "impact": "An orchestrator following the loop can advance to the next wave before the boundary commit. The sanity check at :917 catches only the zero-commit case.",
    "suggested_fix": "Add 'IF auto_commit=false: task-boundary commit per accepted result' inside the loop, after reading each STATUS and before the next wave. Mirror across the builds.",
    "evidence": "Site-check of job-orchestrator SKILL.md:752-772, :833-844 and :917 (identical in the 4 builds).",
    "confidence": "medium"
  }
]
```
