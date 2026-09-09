# T79 spec — closing T76 F-001..F-004, and the class

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`, confirmed
via `pwd`/`git rev-parse --abbrev-ref HEAD` before the first read). No
`.claude/worktrees/**` entered. No `git stash`.

Read before writing this spec, in full: `T76-review.md` (F-001..F-004),
`T68-implementation.md`, `T73-implementation.md`, `T75-implementation.md`,
`.metaproject/index.md`, the task-implementer `SKILL.md`. Ran the reviewer's
probe `T76-guidance.ts` unmodified before any edit — output matches
`T76-review.md`'s own numbers exactly (see "Baseline measurement" below).

## Enumeration axis (stated up front, per the dispatch's own instruction not
## to enumerate by "which files were already known")

**Axis: by emission mechanism — how a string reaches a user/agent — not by
directory.** Six mechanisms, each swept independently by keyword
(`advisory|enforced|gateway|mode-gated|secret/critical|needs-approval`) over
its own surface, then every hit read in full context (not the search
snippet) and judged against the measured code:

1. **Generator functions** (`render*` in `src/lib/templates.ts` and
   `src/security/templates.ts`) whose return value is written to disk by
   `init`/`update` into a scaffolded project. Enumerated by function
   signature (`^export function render`): **28 total** (26 in
   `src/lib/templates.ts`, 2 in `src/security/templates.ts` — confirmed by a
   line-count match against the search header, not the compacted summary,
   which undercounted 28→6 shown, reproducing the documented defect again).
   Only 3 of the 28 carry security-mode content:
   `renderSecurityPrePushHook`, `renderSecurityManifest`,
   `renderSecurityCoreReadme`.
2. **Interactive prompt strings** in `src/commands/init.ts` /
   `src/commands/update.ts` (the `confirm(...)` calls an operator reads while
   scaffolding). Swept directly: exactly 1 hit, `init.ts:497`.
3. **Runtime console strings** printed by `src/commands/security.ts` itself
   (the CLI's own stdout/stderr, distinct from generated files). Swept
   directly: found a **fifth, previously undiscovered site** (`:801`) — see
   Findings below. `security.ts` is marked read-only in this dispatch's
   "Files to read", so this is disclosed, not fixed.
4. **The published documentation site** (`docs/docs/**/*.md`, 21 files,
   enumerated via `find`). Swept across all 21: matches only in
   `cli-reference.md`, `modules.md`, `architecture.md`,
   `workspace-and-lifecycle.md` — all previously corrected by T68/T73/T75
   except `modules.md`'s two mislabeled Exit cells (F-002/F-003, still open).
5. **This repo's own checked-in Metaproject artifacts**
   (`.metaproject/modules/security.md`, `.metaproject/core/security/README.md`)
   — the self-hosted copies of the same generator output. Swept: 3 hits, all
   in `modules/security.md` (2, F-004) and `core/security/README.md` (1,
   already correct).
6. **Root `README.md`**. Swept: 0 security-mode-blocking hits.

This axis is exhaustive for "security mode / gate / exit" claims because it
covers every distinct code path by which a string can leave this repo and
reach a user or agent: generated-file writes, interactive prompts, CLI
runtime output, the docs site, and this repo's own self-hosted copies of the
same generated content. It does not depend on which files a prior round
happened to already know about — mechanism 3 (security.ts's own runtime
strings) was never swept by any of T62/T68/T70/T73/T75/T76, and it is where
the fifth, previously-undiscovered site was found.

## Baseline measurement (before any edit)

`bun .metaproject/flows/.../T76-guidance.ts` →
`.metaproject/data/gdctx/raw/2026-09-06T19-29-15-000Z_T79-guidance-before.log`.
Matches `T76-review.md` exactly: `B pre-push hook script`
`containsEnforcedCiWithoutGateway:true`; `B suspects count:4` (2 real —
`src/lib/templates.ts:2063,2165` — 2 pre-classified non-defects); `T3
CLAIM_HOLDS:false` (scan-mcp mislabeled mode-gated); `T4 CLAIM_HOLDS:false`
(hooks install mislabeled mode-gated); `Row3 other manifest claims
claimsSecretCriticalOnly:true`.

## Findings confirmed by direct code read (read-only sources)

- `src/security/resolve.ts:132-161` (`computeGate`), read in full: `fail` on
  `blockers.length>0` (any category's `action==="block"`) OR
  `severe.length>0` (any finding at/above `config.gate.failOn` severity);
  `needs-approval` on the strongest `require-approval` action across any
  category. Confirms F-004: "secret/critical finding" undersells the trigger
  set.
- `src/commands/security.ts:533` (`handleScanMcp`): the only exit-affecting
  line is `if (args.includes("--strict") && (totalFindings>0 ||
  coverage==="incomplete")) process.exitCode=1` — never reads `config.mode`.
  Confirms F-002.
- `src/commands/security.ts:764-817` (`handleHooks`): `process.exitCode=1`
  only for invalid action/unknown runtime/post-install validation error;
  `modeOf(cwd)` read once, only to print the advisory note at `:799-802`,
  never to set the exit code. Confirms F-003.
- `src/commands/security.ts:801` (read-only, new finding, not in F-001..F-004):
  `` `advisory mode: ${runtime.id} will report findings and allow the call.
  Set \`mode\` to \`enforced\` or \`ci\` in ... to make it refuse.` `` — omits
  `gateway`, the same F-001 shape, in a fifth site none of T62/T68/T70/T73/
  T75/T76 swept (this dispatch's own SURFACES list for `security.ts` covers
  the mode-gating logic, not this runtime string). `security.ts` is marked
  read-only in "Files to read" — **disclosed, not fixed.**

## Plan

### Item 1 (major) — F-001: pre-push hook omits `gateway`

File: `src/lib/templates.ts`, `renderSecurityPrePushHook` (:2059-2189).
- Header comment (:2062-2065): add `gateway` to the mode enumeration,
  keeping `'enforced'/'ci'/'gateway'` as one contiguous substring on one
  line (not wrapped across a line break) — the reviewer's own probe's B-sweep
  is line-based and would re-flag a wrapped split as a fresh suspect.
  Also folds in the Item-3 fix (drop "secret/critical" narrowing) here,
  since it is the same sentence.
- Loop comment (:2165): `# enforced/ci mode blocked on this file.` →
  `# enforced/ci/gateway mode blocked on this file.`

Regression: `src/lib/security-pre-push.test.ts` already exists and is the
correct home (imports `renderSecurityPrePushHook` directly, has no test for
this sentence yet). Add one test pinning the corrected header comment names
`gateway` and does not contain the old `'enforced'/'ci'` form without it, and
does not narrow to secret/critical. RED confirmed by temporarily reverting
the two comment lines and re-running; GREEN after restoring.

**What an existing scaffolded project sees until it re-runs the generator**:
`renderSecurityPrePushHook()` is only re-rendered onto disk by `keryx init`
(new project, `init.ts:1369`, `installManagedHook(..., "security-pre-push",
renderSecurityPrePushHook())`) or `keryx update` (existing project,
`update.ts` — installs the same managed block via the same call). An
existing project's `.git/hooks/pre-push` keeps the stale, gateway-omitting,
secret/critical-narrowed comment text until that project's owner runs `keryx
update` — nothing else migrates (the hook's actual runtime behaviour, which
delegates entirely to the CLI's exit code, was never wrong; only its own
descriptive comments were). Same migration path T68 already documented for
the manifest/README generators.

### Item 2 (major) — F-002/F-003: `docs/docs/modules.md` CLI-surface table

- Line 774 (`scan-mcp` Exit cell): `mode-gated` → `**1** with `--strict`, on a
  threat or incomplete coverage (independent of mode)`.
- Line 782 (`hooks install|uninstall` Exit cell): `mode-gated` →
  `**1** on an unknown runtime or a post-install validation error
  (independent of mode)`.
- Lines 784-787 (the paragraph below the table): reword to scope explicitly
  to the rows it actually describes (`scan`, `check-input`, `check-output`,
  `report` — all confirmed mode-gated by reading their handlers) and name
  that `scan-mcp`/`hooks install` are gated by something else, so a reader
  cannot re-derive the same wrong inference the F-002/F-003 defect caused.

Not pinned by a test: `docs/docs/modules.md` is hand-authored prose, not the
output of a generator function — there is no `render*` seam to assert
against, the same reason none of T68/T73/T75 added a test for any of their
`docs/docs/*.md` corrections either. Verified instead by re-running the
reviewer's own probe (claims `T3`/`T4`), which measures the code directly.

### Item 3 (minor) — F-004: four sites narrow the block condition to
### "secret/critical finding"

Sites: `.metaproject/modules/security.md:49`, `src/security/templates.ts:64`,
`src/commands/init.ts:497`, `src/lib/templates.ts:2064` (folded into Item 1).

- `src/security/templates.ts` (`renderSecurityManifest`, :62-66): drop the
  "secret/critical finding" qualifier; state "a failing or needs-approval
  gate (not only a secret or critical finding)" — matches `computeGate`'s
  measured trigger set (any category's block action or severity, or any
  category's require-approval).
- `.metaproject/modules/security.md:45-51`: this repo's own checked-in copy
  of the same sentence (self-hosted — this repo runs `keryx` on itself, per
  T73's precedent for this exact file). Corrected to match, under the same
  "plainly the same sentence in another documentation file" allowance T73
  used for `.metaproject/core/security/README.md`.
- `src/commands/init.ts:497`: the interactive prompt. Drop "secret/critical
  findings", state "a failing or needs-approval finding".
- `src/lib/templates.ts:2064`: folded into Item 1's edit (same sentence, same
  function).

Regression: `src/security/templates.test.ts` — new test asserting
`renderSecurityManifest()` no longer contains `"secret/critical finding"`
and does contain the new phrase. `src/lib/security-pre-push.test.ts`'s new
test (Item 1) covers the `src/lib/templates.ts` copy of the same sentence.
`init.ts:497`'s prompt string: no existing test pins it (confirmed by `ctx
rg` over `init.test.ts`/`init.no-git.test.ts` for the old text, zero hits,
same as T73 found) — not pinned, same as T73's own precedent for this exact
site.

## Files to change

- `src/lib/templates.ts` (Items 1 + 3)
- `src/lib/security-pre-push.test.ts` (new regression)
- `src/security/templates.ts` (Item 3)
- `src/security/templates.test.ts` (new regression)
- `docs/docs/modules.md` (Item 2)
- `.metaproject/modules/security.md` (Item 3)
- `src/commands/init.ts` (Item 3, one prompt string)

Not changed: `src/commands/security.ts` (read-only per dispatch; the new
`:801` finding is disclosed, not fixed), `src/security/detect/*` and
`docs/requirements/keryx-agent-first-core/policies.md` (other worker's
files), `.metaproject/core/security/README.md` (already correct, re-verified
not stale).

## Verification plan

1. Reviewer probe `T76-guidance.ts`, before/after — already ran before; will
   re-run after and diff the same rows (`B pre-push hook script`, `T3`, `T4`,
   `Row3 other manifest claims`).
2. New/changed regressions, RED (temporary revert, plain edit + restore, no
   `git stash`) then GREEN.
3. `bun src/cli.ts ctx run -- bun test src/lib/ src/commands/ src/security/`
   (dispatch-required scope).
4. `bun run typecheck`.
5. `bunx eslint` on every changed file.

All raw logs under `.metaproject/data/gdctx/raw/`.
