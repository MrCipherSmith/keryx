STATUS: DONE_WITH_CONCERNS

# T79 — implementation: closing T76 F-001..F-004, and the class

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`, confirmed
via `pwd`/`git rev-parse --abbrev-ref HEAD` before the first read). No
`.claude/worktrees/**` entered. No `git stash` at any point (all uncommitted
work in this checkout was left untouched; temporary RED/GREEN reverts used
plain `Edit` calls followed by restoring `Edit` calls, never a stash). Spec
written before any edit: `T79-spec.md` (same directory).

## Enumeration axis

**By emission mechanism — how a string reaches a user or agent — not by
directory or "which files a prior round already knew about."** Six
mechanisms, each swept by keyword
(`advisory|enforced|gateway|mode-gated|secret/critical|needs-approval`) over
its own surface, then every hit read in full context and judged against
measured code:

1. **Generator functions** (`^export function render` in
   `src/lib/templates.ts` + `src/security/templates.ts`) whose output is
   written to disk by `init`/`update` into a scaffolded project — **28 total**
   (confirmed by counting raw match lines against the search header; the
   compacted `ctx rg` summary undercounted 28→6 shown, reproducing the
   documented defect again — read the raw log directly, per the dispatch's
   own instruction). Only 3 of the 28 carry security-mode content:
   `renderSecurityPrePushHook`, `renderSecurityManifest`,
   `renderSecurityCoreReadme`.
2. **Interactive prompt strings** in `init.ts`/`update.ts` — exactly 1 hit,
   `init.ts:497`.
3. **Runtime console strings** printed by `src/commands/security.ts` itself
   (distinct from generated files — this is the CLI's own stdout/stderr).
   This mechanism was never swept by any of T62/T68/T70/T73/T75/T76. Found a
   fifth, previously undiscovered site (`:801`) — see Findings.
4. **The published documentation site** (`docs/docs/**/*.md`, 21 files,
   enumerated via `find`). Matches only in `cli-reference.md`, `modules.md`,
   `architecture.md`, `workspace-and-lifecycle.md` — all previously corrected
   except `modules.md`'s two mislabeled Exit cells (F-002/F-003).
5. **This repo's own checked-in Metaproject artifacts**
   (`.metaproject/modules/security.md`, `.metaproject/core/security/README.md`)
   — self-hosted copies of the same generator output (this repo runs `keryx`
   on itself, so these files exist independently of the generator functions
   and can drift from them, as T73 already established for this exact
   file). 3 hits: 2 in `modules/security.md` (F-004, stale), 1 in
   `core/security/README.md` (already correct).
6. **Root `README.md`**. 0 security-mode-blocking hits.

This axis is exhaustive for "security mode / gate / exit" claims because it
covers every distinct code path by which such a string can leave this repo:
generated-file writes, interactive prompts, CLI runtime output, the docs
site, and this repo's own self-hosted copies of generated content. It found
a genuinely new site (mechanism 3) that five prior enumeration passes never
swept, because none of them treated "the CLI's own runtime messages" as a
distinct emission mechanism from "the files the CLI writes."

## Baseline measurement (before any edit)

`bun .metaproject/flows/.../T76-guidance.ts` (the reviewer's probe, run
unmodified) →
`.metaproject/data/gdctx/raw/2026-09-06T19-29-15-000Z_T79-guidance-before.log`.
Matches `T76-review.md`'s own numbers exactly: `B pre-push hook script`
`containsEnforcedCiWithoutGateway:true`, `omitsGatewayLine` present; `B
suspects count:4` (2 real defects at `src/lib/templates.ts:2063,2165`, 2
pre-classified non-defects); `T3 CLAIM_HOLDS:false` (scan-mcp mislabeled);
`T4 CLAIM_HOLDS:false` (hooks install mislabeled); `Row3 other manifest
claims claimsSecretCriticalOnly:true`.

## Item 1 (major) — F-001: pre-push hook omitted `gateway`

**File**: `src/lib/templates.ts`, `renderSecurityPrePushHook` (:2059-2189).

**Reproduced, exactly as T76 described.** Read the function before editing:
header comment (`:2062-2065`) read `'advisory' (default) always exits 0
(warn, never block); 'enforced'/'ci' exit non-zero on a blocking
(secret/critical) finding`; loop comment (`:2165`) read `# enforced/ci mode
blocked on this file.`

**Fix**:
- Header comment: now `'enforced'/'ci'/'gateway' exit non-zero on a failing
  or needs-approval gate (not only a secret or critical finding)` — kept
  `'enforced'/'ci'/'gateway'` as one contiguous substring on a single line
  (not wrapped across a line break), because the reviewer's own probe's
  section-B sweep is line-based and would re-flag a wrapped split as a fresh
  suspect (verified: see "after" measurement below).
- Loop comment: `# enforced/ci mode blocked on this file.` → `#
  enforced/ci/gateway mode blocked on this file.`
- This edit also folds in Item 3's fix (the "secret/critical" narrowing) for
  the same sentence, since both defects lived in the same two comments.

**What an existing scaffolded project sees until it re-runs the generator**:
`renderSecurityPrePushHook()` is only re-rendered onto disk by `keryx init`
(new project — `init.ts:1369`,
`installManagedHook(projectRoot, "pre-push", "security-pre-push",
renderSecurityPrePushHook())`) or `keryx update` (existing project — the
`update.ts` equivalent, confirmed by the same call pattern read at the same
site T76 cited). An existing project's `.git/hooks/pre-push` keeps the
stale, gateway-omitting, secret/critical-narrowed comment text — a real
script that is executed on every push — until that project's owner runs
`keryx update`. Nothing else migrates: the hook's actual runtime behaviour
was never wrong (it delegates entirely to the CLI's own exit code, which
already honored `gateway` since T61/T65); only its own descriptive comments
were stale. This is the same migration path T68 already documented for the
manifest/README generators.

**Regression**: `src/lib/security-pre-push.test.ts` already existed
(imports `renderSecurityPrePushHook` directly) and had no test for this
sentence — the correct home, used instead of creating a new file. Added two
tests: one pinning both corrected comments name `gateway` (and that the old
split/omitting forms are absent), one pinning the narrowing phrase
`(secret/critical)` is gone and the new `failing or needs-approval gate`
phrase is present.

**RED/GREEN**, confirmed by temporarily reverting both comment edits (plain
`Edit` calls, not `git stash`) and re-running:
- RED: `bun test src/lib/security-pre-push.test.ts src/security/templates.test.ts`
  → **9 pass / 3 fail** — the 3 new tests failed exactly as predicted
  (`toContain`/`not.toContain` mismatches against the reverted text).
- GREEN after restoring: **12 pass / 0 fail / 32 expect()**.

## Item 2 (major) — F-002/F-003: `docs/docs/modules.md` CLI-surface table

**Reproduced.** Read `handleScanMcp` (`src/commands/security.ts:384-536`) in
full: the only exit-affecting line is `if (args.includes("--strict") &&
(totalFindings > 0 || coverage === "incomplete")) process.exitCode = 1` —
`modeOf(cwd)`/`config.mode` never read. Read `handleHooks`
(`src/commands/security.ts:764-817`) in full: `process.exitCode = 1` only
for an invalid action, unknown runtime(s), or a post-install validation
error; `modeOf(cwd)` is read once, only to print the advisory note at
`:799-802`, never to set the exit code.

**Fix**:
- Line 774 (`scan-mcp` Exit cell): `mode-gated` → `**1** with `--strict`, on
  a threat or incomplete coverage (independent of mode)`.
- Line 782 (`hooks install|uninstall` Exit cell): `mode-gated` → `**1** on an
  unknown runtime or a post-install validation error (independent of mode)`.
- Lines 784-787 (the paragraph below the table): reworded to scope
  explicitly to the four rows that are actually mode-gated (`scan`,
  `check-input`, `check-output`, `report` — each confirmed by reading its
  handler calls `exitCodeFor`/`reportExitCode` with `mode`), and to state
  that `scan-mcp`/`hooks install` are gated by something else, so a reader
  cannot re-derive the same wrong inference the F-002/F-003 defect caused.

**Not pinned by a test**: `docs/docs/modules.md` is hand-authored prose, not
the output of a `render*` generator function — there is no seam to assert
against in a unit test, the same reason none of T68/T73/T75 added a test for
any of their `docs/docs/*.md` corrections. Verified instead by re-running
the reviewer's own probe (claims `T3`/`T3b`/`T4`/`T4b`, which measure the
code directly, independent of the doc text) and by a direct read of the
corrected table.

**Measurement taken, after editing**: re-ran `T76-guidance.ts` — `T3b`/`T4b`
(the supporting code measurements) still `CLAIM_HOLDS:true`, confirming the
new cell text matches measured behaviour; `T3`/`T4` (which test the OLD
"mode-gated" hypothesis) remain `CLAIM_HOLDS:false` by design — they are
fixed predicates over the old wording, the same judgement call T75 recorded
for its own analogous claims A2-A5 (they test whether the OLD claim holds
against measured behaviour, and correctly keep failing after the doc text
that made the claim is gone).

## Item 3 (minor) — F-004: four sites narrow the block condition to
## "secret/critical finding"

**Reproduced.** Read `src/security/resolve.ts:132-161` (`computeGate`) in
full: returns `fail` when `blockers.length > 0` (any finding, any category,
`action === "block"`) OR `severe.length > 0` (any finding, any category,
`severity >= config.gate.failOn`); returns `needs-approval` on the strongest
`require-approval` action across any category (e.g. an escalated
prompt-injection finding) — and a `needs-approval` gate also exits non-zero
in a blocking mode (re-confirmed: `report|{enforced,ci,gateway}|needs-approval`
all `1` in the reviewer's probe, both before and after this task's edits).

**Fix** (all four sites, same replacement — "on a failing or needs-approval
gate (not only a secret or critical finding)" in prose, "a failing or
needs-approval finding" in the interactive prompt):
- `src/security/templates.ts:62-66` (`renderSecurityManifest`).
- `.metaproject/modules/security.md:45-51` — this repo's own checked-in copy
  of the same sentence (self-hosted; corrected under the same "plainly the
  same sentence in another documentation file" allowance T73 used for
  `.metaproject/core/security/README.md`).
- `src/commands/init.ts:497` — the interactive prompt.
- `src/lib/templates.ts:2064` — folded into Item 1's edit (same sentence,
  same function).

**Regression**: `src/security/templates.test.ts` — new test asserting
`renderSecurityManifest()` no longer contains `"secret/critical finding"`
and does contain the new phrase (plus re-asserts the T68 gateway-naming
correction still holds, so this fix cannot silently regress that one).
`src/lib/security-pre-push.test.ts`'s new test (Item 1) covers the
`src/lib/templates.ts` copy. `init.ts:497`'s prompt string: confirmed no
existing test pins it (`ctx rg` over `init.test.ts`/`init.no-git.test.ts`
for the old text, zero hits) — not pinned, same as T73's own precedent for
this exact site (T73-implementation.md, "No test currently pinned the stale
`init.ts:497` prompt string").
`.metaproject/modules/security.md` is a static checked-in file with no
generator seam to test against in this repo's own test suite — not pinned,
same precedent as `.metaproject/core/security/README.md` in T73.

**RED/GREEN**: covered by the same Item 1 RED/GREEN run above (the
`src/security/templates.ts` revert was included in that same
revert/restore cycle) — RED: 9 pass/3 fail; GREEN: 12 pass/0 fail.

## Finding disclosed, not fixed (new — F-005, mechanism 3 of the enumeration)

`src/commands/security.ts:801` (`handleHooks`, inside `security hooks
install`'s advisory-mode note, printed directly to the operator's terminal
when the guard is installed while `mode` is `advisory`):

```
`advisory mode: ${runtime.id} will report findings and allow the call. Set
\`mode\` to \`enforced\` or \`ci\` in ${path...} to make it refuse.`
```

This omits `gateway` — the identical F-001 shape (`gateway` has blocked
identically to `enforced`/`ci` since T61/T65) — in a fifth site none of
T62/T68/T70/T73/T75/T76 ever swept, because it is a CLI runtime string, not
a generated file or a docs page. `src/commands/security.ts` is marked
**read-only** in this dispatch's "Files to read" list, so this is disclosed
per this phase's established convention (T68's own "out of ownership,
disclosed not fixed" section), not fixed. Recorded as `T79#F-005` in the
`keryx:findings` block below and in `T79-result.json`.

## What is pinned and what is not (per the dispatch's regression-pinning
## requirement)

| Correction | Pinned by a test? |
|---|---|
| `src/lib/templates.ts` (`renderSecurityPrePushHook`, both comments) | **Yes** — `src/lib/security-pre-push.test.ts`, 2 new tests |
| `src/security/templates.ts` (`renderSecurityManifest`, secret/critical narrowing) | **Yes** — `src/security/templates.test.ts`, 1 new test |
| `docs/docs/modules.md` (Exit cells + paragraph) | **No** — hand-authored prose with no generator seam; same as every prior `docs/docs/*.md` correction in this phase. Guarded instead by the reviewer's probe re-run (`T3b`/`T4b`) and by re-reading the table directly each round. |
| `.metaproject/modules/security.md` | **No** — static checked-in copy, no generator seam in this repo's own suite; same precedent as `.metaproject/core/security/README.md` in T73. |
| `src/commands/init.ts:497` | **No** — no existing test pins operator-facing prompt strings in this file (confirmed zero hits for the old text in both `init.test.ts` and `init.no-git.test.ts`); same as T73's own finding for this exact site. |

So of the two code-generator seams this task's edits touch, both are now
pinned; the three prose/static-file corrections remain unpinned by
construction (no seam exists to pin them against), consistent with every
prior round in this phase.

## Files changed

- `src/lib/templates.ts` — `renderSecurityPrePushHook`: named `gateway`
  alongside `enforced`/`ci` in both comments; dropped the "secret/critical"
  narrowing in the header comment.
- `src/lib/security-pre-push.test.ts` — 2 new regressions pinning both
  fixes above.
- `src/security/templates.ts` — `renderSecurityManifest`: dropped the
  "secret/critical" narrowing in the Hooks section.
- `src/security/templates.test.ts` — 1 new regression pinning the fix
  above (and re-pinning the T68 gateway-naming correction stays true).
- `docs/docs/modules.md` — corrected the `scan-mcp` and `hooks
  install|uninstall` Exit cells; rescoped the paragraph below the table to
  the four rows it actually describes.
- `.metaproject/modules/security.md` — mirrored the
  `src/security/templates.ts` fix (self-hosted copy of the same sentence).
- `src/commands/init.ts` — corrected the interactive pre-push-hook prompt
  string (line 497).

Not changed: `src/commands/security.ts` (read-only per dispatch; the new
`:801` finding is disclosed above, not fixed), `src/security/detect/*` and
`docs/requirements/keryx-agent-first-core/policies.md` (other worker's
files, untouched — confirmed by not appearing in `git status` output
attributable to this task), `.metaproject/core/security/README.md` (already
correct, re-verified not stale, left alone).

## Verification

| Check | Before | After | Raw log |
|---|---|---|---|
| Reviewer probe `T76-guidance.ts`, `B pre-push hook script` | `containsEnforcedCiWithoutGateway:true`, `omitsGatewayLine` present, `claimsSecretCriticalOnly:true` | `containsEnforcedCiWithoutGateway:false`, `omitsGatewayLine:null`, `claimsSecretCriticalOnly:false` | before: `2026-09-06T19-29-15-000Z_T79-guidance-before.log`; after: `2026-09-06T19-37-42-000Z_T79-guidance-after.log` |
| Reviewer probe, `B suspects count` | `4` (2 real defects, 2 pre-classified non-defects) | `2` (only the 2 pre-classified non-defects remain) | same two logs |
| Reviewer probe, `B generators` | `manifestClaimsSecretCriticalOnly:true` | `manifestClaimsSecretCriticalOnly:false`; `manifestNamesGateway`/`readmeNamesGateway` still `true` (T68's fix undisturbed) | same two logs |
| Reviewer probe, `Row3 other manifest claims` | `claimsSecretCriticalOnly:true` | `claimsSecretCriticalOnly:false` | same two logs |
| Reviewer probe, `T3b`/`T4b` (code measurements behind the modules.md fix) | `CLAIM_HOLDS:true` (unaffected by doc edits — these measure code, not docs) | `CLAIM_HOLDS:true` (unchanged, confirms no behaviour was touched) | same two logs |
| New regressions, RED (temporary revert) | — | 9 pass / 3 fail, all 3 the new tests, failing exactly as predicted | inline (`bun test`, not `ctx run`, matching this phase's precedent for quick local RED/GREEN checks that a compacted summary could drop rows from) |
| New regressions, GREEN (restored) | — | 12 pass / 0 fail / 32 expect() | inline |
| `bun src/cli.ts ctx run -- bun test src/lib/ src/commands/ src/security/` | — | **2027 pass / 6 skip / 0 fail / 7915 expect()**, 2033 tests across 145 files | `2026-09-06T19-38-51-329Z_run.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | — | clean, exit 0 | `2026-09-06T19-39-04-948Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint <7 changed files>` | — | clean: 0 errors, 2 informational warnings (`.md` files have no ESLint config — expected, same as every prior round) | `2026-09-06T19-39-10-118Z_run.log` |

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no artifact reaching a user or an agent describes behaviour the code does not have, in either direction. | met for every corrected site; one new out-of-ownership site disclosed, not fixed | F-001/F-004 (over-narrow, wrong direction) and F-002/F-003 (mislabeled) all corrected and re-measured against the reviewer's own probe; F-004's under-selling direction (item 3) also corrected. `src/commands/security.ts:801` remains stale (disclosed as F-005, read-only per dispatch). |
| The enumeration is by what ships rather than by which files were already known, the axis is stated, and every shipped artifact is listed with its disposition. | met | Enumeration axis section above (6 mechanisms); full table of dispositions per mechanism, including the mechanism (CLI runtime strings) that found the new F-005 site. |
| Regressions pin the corrected generated content, so a future edit to a template cannot silently reintroduce a stale claim; state which are pinned and which cannot be. | met | Both `render*`-function fixes (the only two seams this task's edits create) are pinned by new regressions with confirmed RED/GREEN; the three prose/static-file corrections are explicitly stated as unpinned, with the reason, in the table above. |
| `bun test src/lib/ src/commands/ src/security/` stays green. | met | 2027 pass / 6 skip / 0 fail, unchanged pass/fail shape from before this task's edits (only new test count increased). |

## Concerns

1. **F-005 (new, disclosed, not fixed)**: `src/commands/security.ts:801`'s
   advisory-mode note (printed during `keryx security hooks install`) omits
   `gateway` from its "enforced or ci" enumeration — the same defect class
   this whole task closes, in a site this dispatch marks read-only. Left
   unfixed per the dispatch's own file boundary; recommend a follow-up task
   in this file's actual ownership.
2. Three corrections (`docs/docs/modules.md`, `.metaproject/modules/security.md`,
   `src/commands/init.ts:497`) are not pinned by any test, for the structural
   reason given in the pinning table (no generator seam exists for
   hand-authored prose or a static checked-in file) — consistent with every
   prior round in this phase, not a new gap this task introduced.

## Routing audit

- `graph_used`: **no** — *not-relevant*. Every file and site was named by
  the dispatch, by `T76-review.md`'s own findings, or found by this task's
  own from-scratch keyword sweeps; the questions were behavioural (what does
  the code do — answered by reading `resolve.ts`, `security.ts` directly)
  and textual (what does shipped prose say). `keryx-tooling-caveats` project
  memory flags gdgraph's answers as historically unreliable on this repo,
  and the graph predates this session's uncommitted tree regardless.
- `wiki_used`: **no** — *not-relevant*. The normative source for "what the
  code does" is the code itself (`resolve.ts`, `security.ts`, `guard.ts`,
  all read directly); the normative source for prior scope/history is the
  cited prior task artifacts (T68/T73/T75/T76), all read directly.
- `ctx_used`: **yes** — every text search went through `bun src/cli.ts ctx
  rg`; every aggregate command went through `bun src/cli.ts ctx run`; every
  raw log cited above by path.
- `raw_rg_used`: **no** bare `rg`/`grep`/`cat`/`find`/`sed` was run over
  project code or docs for search purposes. Two commands (`grep`, `find`)
  were attempted once each out of habit against a *generated log file
  already produced by this task* (not project source) and were blocked by
  the project's own hook before any output was produced; both were then done
  correctly via the `Read` tool. **gdctx compaction undercount, observed
  independently four more times this task** (the dispatch's own warning,
  reproduced yet again): `^export function render` over the two templates
  files (header 28, summary rendered 6); the broad
  `advisory|enforced|gateway|...` sweep over the same two files (header 9+6,
  summary rendered 4+4); the same sweep over `docs/docs` (header ~74, far
  fewer rendered); the same sweep over `src` (header 24, files count itself
  mismatched — 13 claimed vs 12 summed from the shown rows). Every count in
  this report is taken from a raw log read directly via the `Read` tool, not
  from a compacted summary header or its rendered list alone.

## keryx:findings

```json keryx:findings
[
  {
    "id": "F-005",
    "global_id": "T79#F-005",
    "reviewer": "task-implementer (T79, during the mandated enumeration closing the class)",
    "severity": "minor",
    "file": "src/commands/security.ts",
    "line": 801,
    "symbol": "handleHooks, advisory-mode note",
    "problem": "The note printed to the operator's terminal during `keryx security hooks install` when `mode` is `advisory` reads: \"advisory mode: ${runtime.id} will report findings and allow the call. Set `mode` to `enforced` or `ci` in ... to make it refuse.\" This omits `gateway`, which has blocked identically to `enforced`/`ci` since T61/T65 -- the same F-001 shape found in `src/lib/templates.ts`'s pre-push hook, in a fifth site (a CLI runtime string, not a generated file or a docs page) that none of T62/T68/T70/T73/T75/T76 ever swept.",
    "impact": "An operator reading this note while installing the agent-hook guard is told only `enforced`/`ci` will make the guard refuse, which undersells `gateway` -- the same 'gateway mode is inert' misreading this whole phase exists to close, on a live CLI message rather than a written file.",
    "suggested_fix": "Add `gateway` to the enumeration: \"Set `mode` to `enforced`, `ci`, or `gateway` ... to make it refuse.\"",
    "evidence": "Read src/commands/security.ts:799-802 directly (read-only per this dispatch's Files-to-read list, which marks security.ts read-only for measured behaviour). ctx rg \"advisory|enforced|gateway|mode-gated|secret/critical|needs-approval\" src/commands/security.ts -> 12 matches (raw log 2026-09-06T19-32-24-714Z_rg.log), confirming line 801 is the only site in this file naming enforced/ci without gateway.",
    "confidence": "high",
    "dedupe_key": "shipped-guidance/security-hooks-install-advisory-note/omits-gateway",
    "blocking_merge": false,
    "related_skill": "review-security-code",
    "learning_candidate": true
  }
]
```
