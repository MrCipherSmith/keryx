# Flow 252 review round 2: verified report

Dispatch `252-T4-r2`. Scope: the round-1 fix diff `2078a9a6..HEAD` plus a whole-branch pass over `main..HEAD` on
`skills/quality-program`, HEAD `0cdc36d12f43ec63c8298c193e3f69f76b348870`.
Passes run, in order and by one agent with no subagents: closure check of the 14 round-1 findings, fix-diff review
(logic, security, tests, architecture), and whole-branch sanity. Every experiment ran under
`scratchpad/r2/`: tmp projects for the installer, `closure.ts` importing `installGdskills` read-only from ROOT/src, and a
`git archive HEAD` copy (`r2/mut`) for mutations. ROOT was never mutated.

## Stage counts

| stage | count |
|---|---|
| round-1 findings re-checked | 14 |
| fixed | 13 |
| partially fixed | 1 (C-003) |
| not fixed | 0 |
| new candidates (blocker/major/minor) | 4 |
| refuted | 0 |
| retained new (blocker/major/minor) | 4 |
| new info (does not hold the loop) | 5 |
| findings in the `keryx:findings` block | 9 |

Retained new findings by severity: blocker 0, major 1 (C-009), minor 3 (C-010, C-011, L-008), info 5.
Method mix for the new findings: execution 3 (C-009, L-008, C-012), site-check 5, reasoning 1 (S-004, recorded as
unverifiable, info).

No `round-2-verifications.json` is written. This round had no independent verifier. The reviewer that raised each
finding also checked it, and AC9 forbids recording that as a verification. The execution and site evidence is in each
finding's `evidence` field instead.

## Closure of round-1 findings

Mutation baseline in `r2/mut`: 8 targeted test files, 193 pass, 0 fail.

| id | verdict | method | evidence at HEAD |
|---|---|---|---|
| S-001 | fixed | execution | `closure.ts` (profile minimal, one fresh project per case). The directory, chmod 000, symlink→dir, symlink→/dev/zero, symlink→unmodified file, FIFO and oversized (8993 B > 8992 cap) cases all give `ok:true`, with catalog, manifest and contracts written. Each case leaves the entry in place with one kept-* warning. The FIFO case returns in 8 ms (no hang), and /dev/zero is never read. install.ts:144-161 does `lstat` + `isFile()` + size cap, and :171-186 has a per-entry try/catch. |
| L-001 | fixed | execution | The CRLF, BOM and BOM+CRLF copies of the shipped blob are all removed with `warnings:[]`. The LF control is removed. The modified copy is kept. install.ts:200-206 normalises the content before hashing. |
| L-002 | fixed | execution | The observed kept-modified warning names `RETIRED_RULES[].reason` and the remedy: "…is no longer shipped by keryx (Byte-identical duplicate of …); kept because it differs from every shipped version — delete it, or rename it if you still rely on it". install.ts:219-240 |
| C-001 | fixed | site-check | `keryx ctx rg "economy\|per-group\|current-session\|model_class\|\"current\""` over the bundled and installed review-orchestrator packages finds only SKILL.md:660, a sentence that describes the removal. The review-context.schema.json strategy enum is `ask, adaptive`. The reviewer-input `model_class` is replaced by the `model` block (tier `light/standard/deep`). SKILL.md :1327, :1606, :1760, :1801 and :1880 are rewritten. Nothing in src/ outside tests produces or validates reviewer-input: the only non-test hit is the enforcement-claims note that it is not a registered contract. The updated fixtures validate (round-trip, review-input-fix-round and enforcement-claims give 33 pass, 0 fail). |
| C-002 | fixed | site-check | implementation-plans.mdc:9-21 is now scoped to requirements-package plans and names `docs/plans/<name>/` and `docs/analysis/<feature>/implementation-plan.md` as governed by documentation-management. That matches documentation-management.mdc:56 and :62-73, and feature-analyzer SKILL.md:336-338 (`<DOCS_ROOT>/analysis/<feature-name>/implementation-plan.md`). "No separate `plans/` tree" is gone. |
| C-003 | partially-fixed | execution + site-check | Fixed: rule-management-workflow no longer cites `keryx install`. The home-directory "Sync Targets" are removed. The source of truth is the bundled tree. The count now says four, and the layout includes `<category>/`. `keryx skills sync --runtime <r> --global` is a real flag combination (skills.ts:731-752). Not fixed: the prescribed chain to reach global destinations does not work. See C-009. |
| C-004 | fixed | site-check | Every git command in the task-implementer templates, in SKILL.md and all 4 builds, is now `git -C "<codebase_path>"` with explicit paths. The only remaining bare `git` hits (:405, :407) are prohibitions. git-concurrency.mdc:12 now reads "Cited by". The auto-commit-off case is now written down, but it introduces C-010. |
| C-005 | fixed | execution | `bun ./src/cli.ts review tier --findings 1 --diff-lines 0 --json` gives `tier: light` with reasons `[base:standard, light:small-scope]`. job-orchestrator SKILL.md:1426 and its 4 builds use exactly this form, and skill-lifecycle.mdc:48-52 names it. `--scope narrow` survives only as the rule's counter-example. |
| C-006 | fixed | site-check | catalog.ts:74 and the installed entity-skill-verifier SKILL.md:3 now describe the command's actual checks plus the manual read. "review lessons" gives 0 hits. |
| T-001 | fixed | execution | Mutation `if (false)` at update.ts:240 is KILLED by update.test.ts (1 fail). The same mutation at init.ts:1089 is KILLED by init.test.ts (1 fail). |
| T-002 | fixed | execution | Replacing either review-strict-profile hash with junk is KILLED by install.test.ts: 2 fail each, the fixture-per-hash test and the removal loop. |
| T-003 | fixed | execution | `/^#[^\n]*\n?/` → `/^[^\n]*\n?/` at templates.ts:1800 is KILLED by templates.test.ts ("keep a first line with no leading '#'"). |
| T-004 | fixed | execution | README "on-demand rule library" → "always-loaded rule library" is KILLED by templates.test.ts. Changing `stack_requires` in nestjs-dto.mdc, in both the bundled rule and its mirror, is KILLED by stack.test.ts. |
| T-005 | fixed | execution | Disabling YAML quoting at catalog.ts:542 is KILLED by catalog-frontmatter.test.ts (14 fail). |

## New findings

### Major

**C-009**: src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:122 (and the mirror). The rule's route to a
global destination fails as written. The rule says to regenerate the mirror with `keryx update`, then run
`keryx skills sync --runtime <runtime> --global` "to also push a skill to a harness's own global directory" (:78-81,
:89, :118-127, :139-144). Global sync reads only `.metaproject/runtime/skills/<runtime>/` (sync.ts:177). Only
`keryx skills export` writes that directory (export.ts:124), and export accepts project-skills only.

Execution in a tmp project (`keryx init`, then `keryx update --skip-runtime`, with a fake HOME holding `.cursor/`):
`skills sync --runtime cursor --global --dry-run` gives "No exported runtime skills found for cursor. Run: keryx skills
export <skill> --runtime cursor", exit 1. `skills export task-implementer --runtime cursor` gives "Project skill not found
for: task-implementer", exit 1. So a shipped skill has no global route, and a project skill needs an export step the rule
omits.

Fix: say global sync applies to project-skills and requires `keryx skills export <skill> --runtime <r>` first. Remove the
implication that a shipped skill (the rule's first source-of-truth bullet) can be pushed. Alternatively, add export
support for bundled skills.

### Minor

**C-010**: src/gdskills/bundled/rules/core/git-concurrency.mdc:68 and task-implementer SKILL.md:327-331 / :419-420 (plus 4
builds). The new text says that with auto-commit disabled "the orchestrator stages and commits those exact paths at the
task boundary". No orchestrator does this:
- job-orchestrator SKILL.md:904 treats zero commits as `retryable` and re-dispatches with "No commits were made.
  Implement the changes and commit them." That instruction conflicts with task-implementer's "When auto-commit is
  disabled, do not commit".
- flow-orchestrator SKILL.md has 0 mentions of "commit".

`auto_commit` is a real input (job-orchestrator input-contract.schema.json:167, default true). Fix: add the commit step
and a sanity-check exemption to job-orchestrator for `implementer_settings.auto_commit=false`, or state in both texts that
auto-commit off is unsupported under job-orchestrator.

**C-011**: src/gdskills/bundled/rules/core/rule-management-workflow.mdc:17. Under "Source of Truth", :15 says
`.metaproject/rules/` is regenerated on every run: "edit the source, not the installed copy". But :17 lists
`.metaproject/rules/core/*.mdc` as the thematic source files, and :27 says to "Update or create thematic rule files only
under `rules/core`". This was introduced on this branch: on main the source of truth was `.metaproject/rules`, and
5362b1fc and 7ad7b290 changed :15 without :17 or :27. Fix: :17 and :27 should name
`src/gdskills/bundled/rules/core/*.mdc` (installed to `.metaproject/rules/core/`), and say where a project-owned rule
goes.

**L-008**: src/gdskills/install.ts:181-185 and :234. An `unlink` failure is reported as a read failure. Execution
(`closure.ts`, case readonly-dir-unmodified: an unmodified shipped copy in a `chmod 555` rules/core after a first
install) gives `ok:true`, the file kept, and the warning "kept because it could not be read (EACCES)". The file was read
and matched a shipped hash. Only the removal failed. Fix: record the failing stage in `kept-error` (read or remove) and
word the removal case separately, for example "matches a shipped version but could not be removed (EACCES)".

### Info

- **C-012** review-orchestrator SKILL.md:1567 says `keryx review tier` prints `inherit: true` when it "cannot rank
  anything". Execution shows otherwise: with an unrankable catalogue (`ranked: []`, fallback_reason set) it printed
  `provider`/`model` with `tier_resolution: session-fallback`. review.ts:839-843 emits `inherit` only when the session
  provider or model is empty. Rule 5 at :1575 keys off `inherit: true` correctly, so behaviour is unaffected.
- **C-013** reviewer-input.schema.json `model`: the description says "never alongside" and requires one of
  `provider`/`model` or `inherit`, but the schema enforces neither. This mirrors subagent-dispatch.schema.json:85-149,
  which also does not enforce it (site-check).
- **S-004** install.ts:144-163: there is a TOCTOU window between `lstat` and `readFile`. `readFile` follows a symlink
  swapped in after the `lstat`. Exploiting it needs a concurrent local writer. `open` with O_NOFOLLOW plus `fstat` would
  close it. Unverifiable (reasoning only).
- **C-014** templates.ts:1748-1750: the rules README sentence names only the edited-copy case. Non-regular, oversized and
  unreadable entries are also kept with a warning.
- **T-008** install.test.ts:431: `normalizeRetiredRuleContentForTest` duplicates the unexported installer function. The
  CRLF and BOM behaviour tests cover the behaviour, so drift fails safe.

## Whole-branch sanity (`main..HEAD`, 404 files)

After 2078a9a6, the round-1 reviewers could not have seen these: the 6 fix commits listed above (65 files, all reviewed
in pass 2), and 0cdc36d1, which adds only flow-253 docs (`context-map.md`, `plan.md`) and touches no flow-252 artifact or
code. The installed mirrors match the bundled trees byte-for-byte: `diff -rq` is clean for rules/core, task-implementer
and review-orchestrator.

```json keryx:findings
[
  {
    "id": "C-009",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc",
    "line": 122,
    "problem": "The rule's route to a global destination (keryx update, then keryx skills sync --runtime <r> --global) fails. Global sync reads only .metaproject/runtime/skills/<runtime>/ (sync.ts:177), which only keryx skills export writes (export.ts:124), and export accepts project-skills only.",
    "impact": "An agent following the rule runs a sync that exits 1. A shipped skill (the rule's first source-of-truth bullet) has no global route at all, and a project skill needs an export step the rule never names.",
    "suggested_fix": "State that global sync applies to project-skills and needs `keryx skills export <skill> --runtime <r>` first. Remove the implication that shipped skills can be pushed globally, or add bundled-skill export support. Mirror the change.",
    "evidence": "Execution in scratchpad/r2/proj-sync (keryx init, then keryx update --skip-runtime, with a fake HOME holding .cursor/): `skills sync --runtime cursor --global --dry-run` gives 'No exported runtime skills found for cursor. Run: keryx skills export <skill> --runtime cursor', exit 1. `skills export task-implementer --runtime cursor` gives 'Project skill not found for: task-implementer', exit 1.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:78-81",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:89",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:118-127",
        "src/gdskills/bundled/rules/core/skills-storage-workflow.mdc:139-144",
        ".metaproject/rules/core/skills-storage-workflow.mdc:78-81",
        ".metaproject/rules/core/skills-storage-workflow.mdc:89",
        ".metaproject/rules/core/skills-storage-workflow.mdc:118-127",
        ".metaproject/rules/core/skills-storage-workflow.mdc:139-144"
      ],
      "enumeration_method": "keryx ctx rg -n \"skills sync|keryx update|global destination\" over the bundled rule, plus diff -rq showing the installed mirror is byte-identical (same line numbers). No other bundled rule or skill prescribes `skills sync --global`."
    }
  },
  {
    "id": "C-010",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/bundled/rules/core/git-concurrency.mdc",
    "line": 68,
    "problem": "The new text in git-concurrency and task-implementer says that with auto-commit disabled the orchestrator stages and commits the reported paths at the task boundary. job-orchestrator instead treats zero commits as retryable and re-dispatches with 'commit them', and flow-orchestrator never mentions commits.",
    "impact": "With implementer_settings.auto_commit=false, the task-implementer does not commit, job-orchestrator's sanity check fails and it re-dispatches telling the worker to commit, and nobody performs the promised boundary commit.",
    "suggested_fix": "Add the auto_commit=false commit step (git -C, explicit reported paths) and a sanity-check exemption to job-orchestrator, or state in git-concurrency.mdc and task-implementer that auto-commit off is unsupported under job-orchestrator.",
    "evidence": "Site-check. git-concurrency.mdc:68 and task-implementer SKILL.md:327-331 and :419-420 (identical in the 4 builds) contain the claim. job-orchestrator SKILL.md:904 reads '| At least 1 commit exists | ≥1 commit | `retryable` — ... \"No commits were made. Implement the changes and commit them.\"'. keryx ctx rg -i commit on flow-orchestrator SKILL.md gives 0 matches. The input is real: job-orchestrator input-contract.schema.json:167 `auto_commit` (default true).",
    "confidence": "high"
  },
  {
    "id": "C-011",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/gdskills/bundled/rules/core/rule-management-workflow.mdc",
    "line": 17,
    "problem": "Source of Truth :15 says .metaproject/rules/ is regenerated every run ('edit the source, not the installed copy'), but :17 lists `.metaproject/rules/core/*.mdc` as the thematic source files and :27 says to create thematic rule files only under `rules/core`.",
    "impact": "The rule tells an agent to edit a tree that the same rule says is overwritten on the next keryx update.",
    "suggested_fix": "Point :17 and :27 at src/gdskills/bundled/rules/core/*.mdc (installed to .metaproject/rules/core/), and say where a project-owned rule goes. Mirror the change.",
    "evidence": "Site-check of rule-management-workflow.mdc:15, :17 and :27 at HEAD. `git show main:` shows Source of Truth was `.metaproject/rules` on main. The change came in-branch (5362b1fc, 7ad7b290) and touched :15 only.",
    "confidence": "high"
  },
  {
    "id": "L-008",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/install.ts",
    "line": 234,
    "problem": "kept-error is shared by read failures and unlink failures, and the warning always says 'could not be read'. An unmodified retired copy that was read and hash-matched, but could not be removed, is reported as unreadable.",
    "impact": "The operator gets a wrong diagnosis (a read problem) for a removal problem, for example a read-only rules/core.",
    "suggested_fix": "Record the failing stage in the kept-error outcome (read or remove) and word the removal case separately, for example 'matches a shipped version but could not be removed (EACCES)'. Add a test.",
    "evidence": "Execution with scratchpad/r2/closure.ts, case readonly-dir-unmodified (first install, then the unmodified fixture written, then chmod 555 on rules/core, then install): ok:true, file kept, warning '...kept because it could not be read (EACCES) — inspect it...'. The catch at install.ts:171-185 records only errorCode.",
    "confidence": "high"
  },
  {
    "id": "C-012",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": 1567,
    "problem": "The sentence says keryx review tier prints inherit: true when it 'cannot rank anything'. It prints inherit only when the session provider or model is empty (review.ts:839-843). An unrankable catalogue yields provider/model plus session-fallback.",
    "impact": "The explanation is inaccurate. Rule 5 keys off inherit: true directly, so behaviour is unaffected.",
    "suggested_fix": "Replace the parenthetical with 'when the session has no provider/model to name (it prints inherit: true)'.",
    "evidence": "Execution: `bun ./src/cli.ts review tier --findings 1 --diff-lines 0 --json` printed provider rapid-mlx, a model, tier_resolution session-fallback, ranked [], fallback_reason 'provider \"rapid-mlx\" reported no models', and no inherit.",
    "confidence": "high"
  },
  {
    "id": "C-013",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json",
    "line": 39,
    "problem": "The model block describes inherit as 'never alongside' provider/model, but the schema requires neither form and does not forbid both.",
    "impact": "A hand-composed block with neither form, or with both, validates.",
    "suggested_fix": "Add oneOf [required provider+model, required inherit(const true)], or leave it as-is to match subagent-dispatch.schema.json.",
    "evidence": "Site-check. reviewer-input.schema.json:39-91 has required [tier, tier_reasons, tier_resolution, model_discovery] and no oneOf or not. subagent-dispatch.schema.json:85-149 likewise has no constraint.",
    "confidence": "medium"
  },
  {
    "id": "S-004",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/gdskills/install.ts",
    "line": 163,
    "problem": "There is a TOCTOU window between lstat (:144) and readFile (:163). readFile follows a symlink swapped in after the lstat.",
    "impact": "Only a concurrent local writer racing the install could reintroduce an unbounded read.",
    "suggested_fix": "Open with O_NOFOLLOW, fstat the handle for isFile and size, and read from the handle.",
    "evidence": "Unverifiable (reasoning only; the race was not reproduced).",
    "confidence": "low"
  },
  {
    "id": "C-014",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/lib/templates.ts",
    "line": 1748,
    "problem": "The rules README sentence names only the edited-copy case as kept with a warning. Non-regular, oversized and unreadable entries are also kept with a warning.",
    "impact": "The README slightly understates when retired files are kept.",
    "suggested_fix": "Say 'kept (with a warning) unless it is an unmodified regular file'.",
    "evidence": "Site-check of templates.ts:1748-1750 against install.ts:150-186.",
    "confidence": "medium"
  },
  {
    "id": "T-008",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/gdskills/install.test.ts",
    "line": 431,
    "problem": "normalizeRetiredRuleContentForTest duplicates the unexported installer normalisation.",
    "impact": "The copy can drift. The CRLF and BOM behaviour tests still pin the behaviour, so this fails safe.",
    "suggested_fix": "Export normalizeRetiredRuleContent (or move it to retired-rules.ts) and import it in the test.",
    "evidence": "Site-check of install.test.ts:431-437 against install.ts:200-206.",
    "confidence": "medium"
  }
]
```
