# Flow 256 review round 4: the delta after round 3

Scope: the commits on `skills/quality-program` between the round-3 head `cb4175a3f24281b4da3f6b2781e4188c3c929f10`
and the PR #533 head `958f47aeecb2c0f389b406417a416ff60569b86d`, which was squash-merged to main as `56934fe2`. Only
this branch's own commits in that range were reviewed. The changes brought in by the two `origin/main` merges
(`620137b8` #531 and `3ab8a378` #532, closed on main as `e73f7a7b`) were reviewed on their own PRs and are out of scope.

One agent ran this round with no subagents, applying review-logic, review-testing-practices and review-architecture.
The same agent (identity `review-verifier`) re-verified the 20 round-1..3 findings at or above minor at this head. Those
verdicts are in `round-{1,2,3}-verifications-958f47ae.json`, not here. Every experiment ran on a
`git archive 958f47ae` copy under `scratchpad/gate256/`. ROOT was not mutated. The only files written in ROOT are
this report, the three claims files and the review packages.

## Commits in scope

| commit | what | reviewed how |
|---|---|---|
| `23007ed9`, `df02da4e`, `7af903ed`, `1811745e`, `156ef504` | flow docs: flow.json, journal, round-3 package, T30 closure check | read; journal statements matched against the commits and the packages |
| `8420d553` (T29) | flow-orchestrator and job-orchestrator (5 builds and 6 mirrors): the boundary commit works whether or not the worker committed; `auto_commit` passed explicitly | the T30 closure check at `8420d553`, re-run here at `958f47ae`: both snippets extracted verbatim and executed under bash and zsh (see below) |
| `98641bcf` (T30 N-1) | the path placeholder says to single-quote each path | site check of all 12 files (`set -- <each ... path, single-quoted: ...>`); s4 (quoted paths with spaces) commits both paths |
| `c485772b` | renumber flow 252 to 256; id-map.json; program plan; flow 257 docs | `git diff cb4175a3..958f47ae -- .metaproject/flows/id-map.json docs/plans/skills-quality-program.md`; flow directories at `958f47ae` |
| `dca9bcb0` (T31) | `removeUnmodifiedRetiredRules` gets an injectable `unlink` and is exported; `retiredRuleWarning` is exported; new cross-platform unlink-failure test; the read-only-dir test is limited to macOS | `keryx ctx diff cb4175a3..958f47ae -- src/gdskills/install.ts src/gdskills/install.test.ts`, tests, and execution |
| `958f47ae` | move the unstarted flows 253-255 to 257-259 | id-map.json entries, flow directories and the program plan table |

## What was checked

- **T31, install.ts.** The default `fsOps` is `{ unlink }` from `node:fs/promises`, so production behaviour is
  unchanged. The only call site, `installBundledRules`, passes no second argument. `stage = "unlink"` is still set
  immediately before the injected call, so an injected failure takes the same catch path as a real one. The two new
  exports widen the module surface only. Execution: `scratchpad/gate256/install-check.ts`, case
  `l008-injected-unlink-failure`, gives `{action: kept-error, stage: unlink, errorCode: EACCES}` and the
  "could not be removed" wording. Case `l008-readonly-dir-unmodified` (darwin, end to end) gives the same result, and
  the chmod-000 control case still says "could not be read".
- **T31, install.test.ts.** The new test asserts that the unlink was reached with exactly the file path, which proves the
  file was read and hash-matched. It also asserts the exact outcome, that the file is unchanged, and both the positive
  and negative wording. It cleans up in `finally`. The macOS gate on the end-to-end test is stated with its reason (on
  Linux, Bun `cp({force:true})` unlinks each destination), and the branch it covered is now covered on every platform.
  Tests on the 958f47ae copy: `bun test src/gdskills/install.test.ts src/gdskills/destructive-git.test.ts
  src/gdskills/build-parity.test.ts src/gdskills/status-contract.test.ts src/gdskills/task-implementer-contract.test.ts
  src/gdskills/installed-registry-integrity.test.ts` gives **58 pass, 0 fail**. `bun ./src/cli.ts skills verify --bundled`
  exits 0, and every check passes, including `document:build-parity`.
- **T29 and N-1 snippets.** `scratchpad/gate256/run.sh` extracts each boundary-commit bash block verbatim from the
  958f47ae copy and runs it in fresh repos. It covers flow-orchestrator and job-orchestrator, each under bash and zsh,
  and all four combinations give identical results:
  - s1 (auto-commit off, M/A/D): one commit with exactly the reported paths.
  - s2 (the worker already committed) and s3 (empty list): skipped, exit 0.
  - s4 (quoted paths with spaces): committed.
  - s5: another lane's staged file stays staged and is not swept in.
  - s8: only the leftover file is committed.

  `cmp` confirms that the bundled and installed copies are byte-identical for flow-orchestrator, all 5 job-orchestrator
  builds and task-implementer.
- **Renumbering.** id-map.json gains one entry per move (252→256 for this flow; 253/254/255→257/258/259), each with
  the reason. The directories at `958f47ae` are 256-259, with no leftover 252-255 of this program. The program plan
  table names 256-259, and its dependency column moved with them. 252 and 253 now belong to main's flows, as the
  id-map records.

## Result

No new blocker, major or minor. There are three info items. Two are carried from the T30 closure check (N-2, N-3),
because no review round has recorded them yet. One is new (R4-001).

- **N-2** (info): the boundary-commit per-path check does not filter out a deletion that the worker already staged. For
  that path, `git add` prints `fatal: pathspec ... did not match any files`. The commit that follows still records the
  deletion correctly (T30 s9, both shells, both skills). The text does not tell an orchestrator that the `fatal:`
  line is harmless.
- **N-3** (info): flow-orchestrator SKILL.md:332 says "Workers do not commit", while :375 says tests-creator commits
  its stubs itself. Auto-commit-off reaches task-implementer only as a free-text dispatch constraint (:360), because
  `subagent-dispatch` has no `automation` field. The outcome is correct either way, because the boundary step skips a
  worker that committed (s2).
- **R4-001** (info): after `c485772b` moved the review packages from `flows/252-...` to `flows/256-...`, the three
  round manifests still said `flow.id: "252"` and pointed every `artifacts.*` path at `.metaproject/flows/252-...`,
  a directory that no longer exists at `958f47ae`. The gate reads packages by directory, so it was not misled. A
  consumer following `manifest.artifacts` would find nothing. The re-ingest of rounds 1-3 that records this closure
  rewrites those manifests with flow 256 paths. The general fix belongs to `flow renumber`: rewrite the moved
  packages' manifests.

```json keryx:findings
[
  {
    "id": "N-2",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "line": 381,
    "problem": "The boundary-commit per-path check does not exclude a deletion the worker already staged (git rm). For that path `git add -- <path>` prints `fatal: pathspec '<path>' did not match any files`; the script continues and `git commit -- <path>` records the deletion correctly. The explanatory text does not say the fatal line is harmless. Same in job-orchestrator :857 (5 builds) and all mirrors.",
    "impact": "An orchestrator reading the transcript may treat a correct boundary commit as a failure and retry or stop. The recorded commit is right.",
    "suggested_fix": "Add a sentence: a `fatal: pathspec` from `add` on an already-staged deletion is harmless; the commit line is authoritative. Or skip `add` for paths whose status is `D ` (staged deletion).",
    "evidence": "T30 closure check scenario s9 (reviews/closure-check-T30.md) in bash and zsh for both skills: exit 0, HEAD `D del.txt`, with the fatal line printed by add. The snippet text is unchanged at 958f47ae (extracted verbatim by scratchpad/gate256/run.sh).",
    "confidence": "high"
  },
  {
    "id": "N-3",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md",
    "line": 332,
    "problem": "flow-orchestrator :332 says workers do not commit and flow-orchestrator owns every commit, while :375 says tests-creator commits its stubs itself. The auto-commit-off setting reaches task-implementer only as a free-text constraint (:360), because subagent-dispatch has no automation field, so nothing enforces it mechanically.",
    "impact": "Wording tension about commit ownership. The outcome is correct either way, because the boundary step skips when the worker already committed.",
    "suggested_fix": "Qualify :332 ('task-implementer workers do not commit; tests-creator commits its own stubs'), and in the quality-gate flow consider an automation field on subagent-dispatch.",
    "evidence": "Site-check at 958f47ae: flow-orchestrator SKILL.md:332, :360 and :375. tests-creator SKILL.md commits its stubs. keryx ctx rg auto_commit over src/gdskills/contracts/subagent-dispatch.schema.json gives 0 matches. The boundary step skip was executed in s2 (scratchpad/gate256/run.sh, bash and zsh).",
    "confidence": "medium"
  },
  {
    "id": "R4-001",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": ".metaproject/flows/256-2026-09-11-skills-hygiene/reviews/2026-09-11-ingest-skills-quality-program/manifest.json",
    "line": null,
    "problem": "The flow renumber (c485772b) moved the review packages from flows/252-2026-09-11-skills-hygiene to flows/256-... without rewriting their manifests. All three rounds kept `flow.id: \"252\"` and `artifacts.*` paths under .metaproject/flows/252-2026-09-11-skills-hygiene/, a directory that does not exist at 958f47ae, and flow 252 is now a different flow (mcp-servers-p3b).",
    "impact": "A reader following manifest.artifacts or manifest.flow finds nothing, or the wrong flow. The review gate reads packages by directory and is unaffected. The re-ingest of rounds 1-3 recorded in this closure rewrites the three manifests with flow 256 paths.",
    "suggested_fix": "Have the flow renumber step rewrite `flow` and `artifacts` in every manifest.json under the moved reviews directory, with a test.",
    "evidence": "Site-check: `git show 958f47ae:.metaproject/flows/256-2026-09-11-skills-hygiene/reviews/2026-09-11-ingest-skills-quality-program/manifest.json` (and -r02, -r03) carries flow.id 252 and artifacts under 252-2026-09-11-skills-hygiene. `git ls-tree 958f47ae .metaproject/flows/` lists 252-2026-09-11-mcp-servers-p3b and no 252-2026-09-11-skills-hygiene.",
    "confidence": "high"
  }
]
```

## Routing audit

- graph_used: not-relevant. The delta is six named commits; files were located from `git show --stat`.
- wiki_used: not-relevant.
- ctx_used: yes (`keryx ctx diff`, `keryx ctx rg`).
- raw_rg_used: no.
