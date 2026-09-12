# Flow 252 review round 1: verified report

Scope: `main..HEAD` on `skills/quality-program`, HEAD `2078a9a645e34ffadbdadc544e50bc6650bd3f3f`, merge-base `bb0e36b4`.
Reviewers (Wave A/B): review-security-code (S), review-logic (L), review-architecture (C), review-testing-practices (T).
The round's review orchestrator stopped before Wave C. The flow orchestrator consolidated the reviewer results into
`round-1-consolidated.md` and dispatched Wave C (review-verifier, dispatch `252-T4-waveC`) separately. The verifier did
not raise any of these findings.

## Stage counts

| stage | count |
|---|---|
| candidates (blocker/major/minor) | 14 |
| refuted by verifier | 0 |
| retained (blocker/major/minor) | 14 |
| info (reported, not verified, do not hold the loop) | 9 |
| findings in the `keryx:findings` block | 23 |

Retained by severity: blocker 0, major 5 (S-001, L-001, C-001, C-002, C-003), minor 9 (L-002, C-004, C-005, C-006,
T-001, T-002, T-003, T-004, T-005), info 9.

## Verification (Wave C, review-verifier)

Method mix: execution 10, site-check 4, reasoning 0, not checked 9 (the info items, by design). Result: 14 confirmed,
0 refuted, 0 unverifiable. All experiments ran in the verifier scratchpad (`scratchpad/verify/`): tmp projects for the
installer, and a copy of the repo (`verify/mut/`) for mutations. ROOT was never mutated.

| id | verdict | method | evidence (short) |
|---|---|---|---|
| S-001 | confirmed | execution | `installGdskills` from ROOT/src: a directory at the retired name aborts with EISDIR, chmod 000 with EACCES, and a symlink to a dir with EISDIR. Catalog, manifest and contracts are never written. The LF control case is removed cleanly. |
| L-001 | confirmed | execution | The shipped blob `c44f5f0f` hashes to `e29a8328…` (= RETIRED_RULES[0]). The LF copy is removed. CRLF and BOM copies are kept, each warned as modified. |
| L-002 | confirmed | execution | The observed warning is exactly `retired rule kept because it was modified: review-agent-profile.mdc`. install.ts:83-85 never reads `RETIRED_RULES[].reason`. |
| C-001 | confirmed | site-check | review-context.schema.json:366-373 still enumerates `current, economy, per-group, current-session`. reviewer-input.schema.json:41-46 has `simple, normal, complex, current-session`. SKILL.md :1327, :1573-1575, :1606, :1760, :1801 and :1880 still offer retired strategies. Cited :1608 and :1803 carry none at HEAD. |
| C-002 | confirmed | site-check | implementation-plans.mdc:12 applies to any plan, and :17-18 say "no separate `plans/` tree". documentation-management.mdc:56 defines `docs/plans/<name>/`, and :62-73 define `analysis/<feature>/implementation-plan.md`. feature-analyzer SKILL.md:336-338 writes the latter. |
| C-003 | confirmed | execution | `bun ./src/cli.ts install` prints `Unknown command: install` (exit 1). No non-bundled code writes `~/.cursor/rules/AGENTS.md`. update.ts has no home-dir writes. Global sync is `keryx skills sync --runtime … --target\|--global` (skills.ts:1547-1548). skills-storage-workflow :21, :24, :79 and :104-120 are as cited. |
| C-004 | confirmed | site-check | task-implementer SKILL.md:320-321 and :406-407 use bare `git add`/`git commit` behind "When auto-commit is enabled" (:318, :404). git-concurrency.mdc:12 says "Always loaded alongside…", against the rules README (templates.ts:1739-1740) "on-demand … read only when a skill or `routing.md` cites it". |
| C-005 | confirmed | execution | `review tier --scope narrow --json` gives `standard` with reasons `[base:standard]`. `--findings 1 --diff-lines 0` gives `light`. |
| C-006 | confirmed | site-check | catalog.ts:74 and the installed mirror SKILL.md:3 say "tests, or review lessons". verify.ts signals are gdgraph, gdctx, code-health, memory-consultation and gdwiki only. |
| T-001 | confirmed | execution | Disabling the Warnings print at update.ts:240 left update and skills-install-warnings tests green (10 pass). The same mutation at init.ts:1089 left init and skills-install-warnings tests green (5 pass). |
| T-002 | confirmed | execution | Both review-strict-profile hashes were replaced with junk; install, skills-install-warnings and installed-registry-integrity stayed green (16 pass). |
| T-003 | confirmed | execution | Changing `/^#[^\n]*\n?/` to `/^[^\n]*\n?/` at templates.ts:1798 left templates, init and update tests green (31 pass). |
| T-004 | confirmed | execution | The README "on-demand" wording was replaced; templates, init and update tests stayed green (31 pass). Changing `stack_requires` in nestjs-dto.mdc, in both the bundled rule and its mirror, left stack, templates, install, bundled-eval and registry-integrity tests green (106 pass). Changing the bundled rule alone was caught only by the byte-identity drift test. |
| T-005 | confirmed | execution | Disabling YAML quoting at catalog.ts:542 left 7 gdskills and skills test files green (57 pass). |

The mutation baseline was green over the combined test set (135 pass, 0 fail). One environment note:
`src/commands/install-lifecycle.test.ts` exits 1 with `4 pass 0 fail` in the scratch copy, which looks like an
exit-code leak rather than a failure. It was left out of the mutation sets so that it could not fake a kill.

## Info (retained as reported, not verified)

- S-002 install.ts:129: on a case-insensitive FS the warning names the canonical spelling, not the on-disk name.
- S-003 install.ts:136: with a symlinked rules dir, the unlink lands in the shared target (byte-identical shipped content only).
- L-005 bundled-eval.ts:824: the harness/category checks read values with a single-line regex, so YAML block/flow lists mis-parse.
- L-006 bundled-eval.ts:481: PATH_REFERENCE captures a trailing sentence period.
- L-007 templates.ts:1797: a multi-heading-only body keeps its body, and a `#tag` first line takes the fallback.
- C-007: the AC6 literal strings occur inside valid installed paths (grep with `(?<!gd)`).
- C-008 `.metaproject/rules/README.md:24`: "overwrite wholesale" hides the retired-rule removal.
- T-006: the bundled-eval harness-claude trim is not pinned (fails safe).
- T-007: the destructive-git sweep reads only `SKILL*.md`, and DENIAL excuses "instead of"/"rather than".

Note on field provenance: the consolidated input carries no per-finding `confidence`, so `medium` is recorded for every
finding. `impact` is taken from the consolidated problem text. No finding text or severity was changed.

```json keryx:findings
[
  {
    "id": "S-001",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/gdskills/install.ts",
    "line": 130,
    "problem": "removeUnmodifiedRetiredRules gates on existsSync (follows symlinks, true for dirs/FIFOs) then readFile with no lstat/isFile, no size bound, no try/catch. Directory -> EISDIR aborts install before catalog/manifest/contracts are written; symlink to /dev/zero -> unbounded memory; FIFO -> hang; chmod 000 -> EACCES abort.",
    "impact": ".metaproject/rules/core is git-tracked, so a repo can plant a non-regular entry at a retired name and make every keryx init/update/skills install abort (or hang/exhaust memory) before catalog, manifest and contracts are written.",
    "suggested_fix": "lstat first; skip non-regular entries with a warning (\"kept: not a regular file\"), never follow/unlink them; optional size cap at largest shipped size; per-entry try/catch -> warning, cleanup can never abort install; tests for symlink, directory, unreadable file.",
    "evidence": "Reviewer reproduced all four cases (scratchpad/sec/exp*.ts); cited src/gdskills/install.ts:130-136.",
    "confidence": "medium",
    "class_scope": {
      "sites": ["src/gdskills/install.ts:130-136"],
      "enumeration_method": "removeUnmodifiedRetiredRules (called only from installBundledRules, install.ts:123) is the one place installed retired-rule files are read and unlinked; as reported in round-1-consolidated.md."
    }
  },
  {
    "id": "L-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/install.ts",
    "line": 133,
    "problem": "sha256 over raw bytes; registry hashes are LF-only, BOM-less. An unmodified copy with CRLF (Windows core.autocrlf=true on a versioned .metaproject/rules/core) or a BOM is classified kept-modified forever and warned on every install.",
    "impact": "Unmodified retired rules are never cleaned up on CRLF/BOM checkouts and produce a permanent false 'modified' warning on every install.",
    "suggested_fix": "normalise before hashing: strip leading U+FEFF, \\r\\n -> \\n; tests for CRLF and BOM copies being removed.",
    "evidence": "Reviewer reproduced (scratchpad/install-exp.ts); cited src/gdskills/install.ts:133-135.",
    "confidence": "medium",
    "class_scope": {
      "sites": ["src/gdskills/install.ts:133-135"],
      "enumeration_method": "The single hash comparison against RETIRED_RULES[].shippedSha256 in removeUnmodifiedRetiredRules; as reported in round-1-consolidated.md."
    }
  },
  {
    "id": "L-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/install.ts",
    "line": 83,
    "problem": "kept-modified warning does not say the rule is no longer shipped nor how to silence it; repeats forever.",
    "impact": "Operators see a recurring warning with no reason and no remedy.",
    "suggested_fix": "include RETIRED_RULES[].reason and the remedy (delete, or rename if still used).",
    "evidence": "Cited src/gdskills/install.ts:83-85.",
    "confidence": "medium"
  },
  {
    "id": "C-001",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/review-context.schema.json",
    "line": 364,
    "problem": "input contract now `ask|adaptive`, but review_context model_plan.strategy still allows current/economy/per-group/current-session; reviewer-input model_class is simple|normal|complex|current-session (keryx review tier emits light/standard/deep); SKILL.md output templates and Model Metadata Rules still offer retired strategies. AC3 value `current` still validates via review-context.",
    "impact": "The retired strategies remain valid in two schemas and are offered by the skill's own templates, so the narrowing is not enforced.",
    "suggested_fix": "narrow model_plan.strategy to ask|adaptive; model_class -> tier vocabulary (light|standard|deep + inherit) or the tier model block; rewrite the SKILL.md sites; mirror.",
    "evidence": "Cited review-context.schema.json:364-373; reviewer-input.schema.json:39-46; SKILL.md:1327,1567,1573-1575,1606,1608,1760-1761,1801,1803,1880.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-orchestrator/review-context.schema.json:364-373",
        "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json:39-46",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1327",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1567",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1573-1575",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1606",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1608",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1760-1761",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1801",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1803",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md:1880"
      ],
      "enumeration_method": "As listed by review-architecture in round-1-consolidated.md (search for retired strategy names in the review-orchestrator package)."
    }
  },
  {
    "id": "C-002",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/gdskills/bundled/rules/core/implementation-plans.mdc",
    "line": 2,
    "problem": "implementation-plans says plans live only in docs/requirements/<name>/implementation-plan.md, \"no separate plans/ tree\", and to scaffold a requirements package first; documentation-management keeps a plans/ category and analysis/<feature>/implementation-plan.md, which feature-analyzer writes.",
    "impact": "Two core rules and a shipped skill disagree on where an implementation plan lives.",
    "suggested_fix": "scope implementation-plans to plans belonging to a requirements package and name the other two locations (standalone plans/ and analysis/<feature>/), drop \"no separate plans/ tree\".",
    "evidence": "Cited implementation-plans.mdc:2,15-19,23,41,44 vs documentation-management.mdc:56,62-75 vs feature-analyzer SKILL.md:336-341 (+builds), SKILL.detail.md:230-232.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/rules/core/implementation-plans.mdc:2",
        "src/gdskills/bundled/rules/core/implementation-plans.mdc:15-19",
        "src/gdskills/bundled/rules/core/implementation-plans.mdc:23",
        "src/gdskills/bundled/rules/core/implementation-plans.mdc:41",
        "src/gdskills/bundled/rules/core/implementation-plans.mdc:44",
        "src/gdskills/bundled/rules/core/documentation-management.mdc:56",
        "src/gdskills/bundled/rules/core/documentation-management.mdc:62-75",
        "src/gdskills/bundled/skills/orchestration/feature-analyzer/SKILL.md:336-341",
        "src/gdskills/bundled/skills/orchestration/feature-analyzer/SKILL.detail.md:230-232"
      ],
      "enumeration_method": "As listed by review-architecture in round-1-consolidated.md (+ feature-analyzer runtime builds SKILL.codex/cursor/zed/opencode.md)."
    }
  },
  {
    "id": "C-003",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc",
    "line": 21,
    "problem": "skills-storage-workflow names the install mirror as source of truth, says \"sync\" with keryx update (which force-copies bundled over the installed tree and never syncs globally; global sync is `keryx skills sync --runtime <r> --target <dir>`), \"both global destinations\" vs four listed, layout omits <category>/. rule-management-workflow:15 cites nonexistent `keryx install`; its Sync Targets (~/.cursor/rules/AGENTS.md etc.) are written by no code.",
    "impact": "An agent following these rules edits the wrong tree, runs a command that does not sync, or runs a command that does not exist.",
    "suggested_fix": "source = src/gdskills/bundled/skills/<category>/<skill>/ (or project-skills); sync step = keryx skills sync; fix count; rule-management: keryx init/update, delete or correct Sync Targets.",
    "evidence": "Cited skills-storage-workflow.mdc:21,23-30,79,104-108,120; rule-management-workflow.mdc:15,33-44.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:21",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:23-30",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:79",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:104-108",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:120",
        "src/gdskills/bundled/rules/core/rule-management-workflow.mdc:15",
        "src/gdskills/bundled/rules/core/rule-management-workflow.mdc:33-44"
      ],
      "enumeration_method": "As listed by review-architecture in round-1-consolidated.md."
    }
  },
  {
    "id": "C-004",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": 318,
    "problem": "task-implementer templates use bare git (add/commit/checkout) while citing git-concurrency (git -C everywhere); commit only when auto-commit enabled vs rule 4 \"not done until committed\"; rule claims \"Always loaded alongside\" while README says core rules load only when cited.",
    "impact": "Workers following the template run git against whatever cwd persists; the task-boundary commit rule and the loading claim contradict other shipped text.",
    "suggested_fix": "templates -> git -C <worktree> ...; state what happens at a task boundary with auto-commit off (report file list, orchestrator commits); \"Always loaded alongside\" -> \"Cited by\".",
    "evidence": "Cited task-implementer SKILL.md:318-321,397,404-407 (+4 builds); git-concurrency.mdc:12.",
    "confidence": "medium"
  },
  {
    "id": "C-005",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/bundled/rules/core/skill-lifecycle.mdc",
    "line": 48,
    "problem": "rule promises learn at model_tier light via keryx review tier; job-orchestrator's prescribed `keryx review tier --scope narrow --json` computes standard (narrow not a recognised scope; light needs --findings<=3 and --diff-lines<=50 or --verifier).",
    "impact": "The learn dispatch runs one tier heavier than the rule promises.",
    "suggested_fix": "job-orchestrator :1426 use the signals flow-orchestrator:420 uses (--findings 1 --diff-lines 0), or drop \"light\" from the rule.",
    "evidence": "Cited skill-lifecycle.mdc:48-50; job-orchestrator SKILL.md:1424-1430 (+builds).",
    "confidence": "medium"
  },
  {
    "id": "C-006",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/catalog.ts",
    "line": 74,
    "problem": "verifier routing description still says it checks claims against tests and review lessons, which neither the command nor the manual step covers.",
    "impact": "Routing promises a check nobody performs.",
    "suggested_fix": "align description with purpose/workflow at :68-72; re-render the mirror.",
    "evidence": "Cited src/gdskills/catalog.ts:74 (+ installed core/entity-skill-verifier/SKILL.md:3).",
    "confidence": "medium"
  },
  {
    "id": "T-001",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/update.ts",
    "line": 240,
    "problem": "retired-rule warnings only tested on skills install; removing the print in update/init stays green (mutations M9, M9b, M10).",
    "impact": "A regression that silences the warning on keryx update or keryx init would ship unnoticed.",
    "suggested_fix": "tests in update.test.ts and init.test.ts, or one shared print helper tested once; fix the \"stands in for all three\" comment in skills-install-warnings.test.ts.",
    "evidence": "Cited src/commands/update.ts:240,478; init.ts:625,1089; reviewer mutations M9, M9b, M10 green.",
    "confidence": "medium"
  },
  {
    "id": "T-002",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/gdskills/install.test.ts",
    "line": 185,
    "problem": "only RETIRED_RULES[0] exercised; review-strict-profile entry and its two hashes untested (M6 green).",
    "impact": "A wrong hash for review-strict-profile.mdc would leave unmodified copies installed forever with no test failing.",
    "suggested_fix": "loop over every (entry, hash) with fixtures for both review-strict-profile versions (blobs at fd43d35a and ff9dd071); assert every hash has a fixture.",
    "evidence": "Cited src/gdskills/install.test.ts:185; reviewer mutation M6 green.",
    "confidence": "medium"
  },
  {
    "id": "T-003",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/lib/templates.ts",
    "line": 1798,
    "problem": "`#` anchor in isHeadingOnlyBody regex not pinned (M24 green) — a one-line non-heading instruction would be replaced by the fallback.",
    "impact": "A single-line instruction in AGENTS.md/CLAUDE.md could be silently replaced by the fallback text in the imported rule.",
    "suggested_fix": "test: body \"Always run the linter.\" + block keeps the line, no fallback.",
    "evidence": "Cited src/lib/templates.ts:1798; reviewer mutation M24 green.",
    "confidence": "medium"
  },
  {
    "id": "T-004",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/lib/templates.ts",
    "line": 1723,
    "problem": "AC13 rules README wording and the 8 rules' stack_requires are untested (M25 green).",
    "impact": "The README's on-demand contract and the stack tags could regress with the suite green.",
    "suggested_fix": "assert renderProjectRulesReadme on-demand/alwaysApply wording; test the eight rules parse to STACK_TAGS via parseStackRequires.",
    "evidence": "Cited src/lib/templates.ts:1723; reviewer mutation M25 green.",
    "confidence": "medium"
  },
  {
    "id": "T-005",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/gdskills/catalog.ts",
    "line": 542,
    "problem": "YAML quoting of descriptions containing ':' untested (M30 green); without it strict YAML rejects the frontmatter.",
    "impact": "Removing the quoting would ship invalid frontmatter for rendered skills with no test failing.",
    "suggested_fix": "render every BUNDLED_GDSKILLS entry, parse frontmatter with a YAML parser, assert description round-trips.",
    "evidence": "Cited src/gdskills/catalog.ts:542; reviewer mutation M30 green.",
    "confidence": "medium"
  },
  {
    "id": "S-002",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/gdskills/install.ts",
    "line": 129,
    "problem": "case-insensitive FS: warning names canonical spelling, not on-disk name.",
    "impact": "Cosmetic mismatch in the warning on case-insensitive filesystems.",
    "suggested_fix": "report the on-disk name.",
    "evidence": "Cited src/gdskills/install.ts:129 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "S-003",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/gdskills/install.ts",
    "line": 136,
    "problem": "symlinked rules dir: unlink lands in shared target (byte-identical shipped content only).",
    "impact": "A shared rules tree loses a byte-identical retired file; no user content at risk.",
    "suggested_fix": "none required; note in docs or skip symlinked parents.",
    "evidence": "Cited src/gdskills/install.ts:136 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "L-005",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/gdskills/bundled-eval.ts",
    "line": 824,
    "problem": "harness/category checks read values by single-line regex; YAML block/flow lists and top-level keys mis-parse (no shipped skill uses them).",
    "impact": "Latent mis-parse for future skills using YAML list forms.",
    "suggested_fix": "parse frontmatter with a YAML parser.",
    "evidence": "Cited src/gdskills/bundled-eval.ts:824 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "L-006",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/gdskills/bundled-eval.ts",
    "line": 481,
    "problem": "PATH_REFERENCE captures a trailing sentence period.",
    "impact": "A path at sentence end may be reported as missing.",
    "suggested_fix": "exclude a trailing period from the capture.",
    "evidence": "Cited src/gdskills/bundled-eval.ts:481 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "L-007",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/lib/templates.ts",
    "line": 1797,
    "problem": "multi-heading-only body keeps body; '#tag' first line takes fallback.",
    "impact": "Edge cases of isHeadingOnlyBody classify unexpectedly.",
    "suggested_fix": "match ATX headings (`# ` with a space) and strip all heading-only lines.",
    "evidence": "Cited src/lib/templates.ts:1797 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "C-007",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": null,
    "line": null,
    "problem": "AC6 literal strings occur inside valid installed paths (grep with (?<!gd)).",
    "impact": "A naive AC6 grep reports false positives.",
    "suggested_fix": "grep with (?<!gd).",
    "evidence": "Reported in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "C-008",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": ".metaproject/rules/README.md",
    "line": 24,
    "problem": ".metaproject/rules/README.md:24 \"overwrite wholesale\" hides retired-rule removal.",
    "impact": "The README understates what install does to core/.",
    "suggested_fix": "mention retired-rule removal next to \"overwrite wholesale\".",
    "evidence": "Cited .metaproject/rules/README.md:24 in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "T-006",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": null,
    "line": null,
    "problem": "bundled-eval harness-claude trim not pinned (fails safe).",
    "impact": "Unpinned behaviour; fails safe.",
    "suggested_fix": "add a pinning test.",
    "evidence": "Reported in round-1-consolidated.md (info).",
    "confidence": "medium"
  },
  {
    "id": "T-007",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": null,
    "line": null,
    "problem": "destructive-git sweep reads only SKILL*.md; DENIAL excuses \"instead of\"/\"rather than\".",
    "impact": "The sweep can miss destructive git in non-SKILL files or phrased as an alternative.",
    "suggested_fix": "widen the sweep's file set and tighten the DENIAL pattern.",
    "evidence": "Reported in round-1-consolidated.md (info).",
    "confidence": "medium"
  }
]
```
