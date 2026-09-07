# T73 implementation — closing T62 F-004's remaining disclosed sites

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Files
changed: `src/commands/init.ts`, `.metaproject/modules/security.md`,
`docs/docs/architecture.md`, `docs/docs/modules.md`,
`docs/docs/workspace-and-lifecycle.md`, `docs/docs/cli-reference.md`,
`.metaproject/core/security/README.md`. Spec written before editing:
`T73-spec.md` (same directory). No behaviour changes — every edit is a
string/prose correction; nothing in `src/security/*` was touched.

All raw logs are under `/Users/Goodea/goodea/keryx/.metaproject/data/gdctx/raw/`.

## What the code actually does (verified, read-only)

`src/security/guard.ts:212-213` (`isBlockingMode`), read directly: "Whether
this mode may stop a controlled write (§7a). `advisory` alone reports and
continues; `enforced`, `ci` and `gateway` block." `src/security/types.ts:93`:
`SecurityMode = "advisory" | "enforced" | "ci" | "gateway"`. This confirms
T68's own resolution (T68-implementation.md, T62 F-002): `gateway` blocks
identically to `enforced`/`ci` at the write seam, the flow completion gate,
and every command's exit code; only `gateway`'s own Phase-4 proxy/backend
behaviour remains unimplemented. Every "add `gateway`" correction below is
this fact, applied at each site that previously enumerated only
`enforced`/`ci` as blocking.

## Enumeration method

1. Started from T68-implementation.md's disclosed-not-fixed list and
   T62-review.md's `[F-004]` finding (read in full, both cited by exact line
   numbers).
2. Re-derived the list independently via `bun src/cli.ts ctx rg` in four
   passes:
   - `advisory.*enforced|enforced.*advisory|enforced/ci|enforced, ci|
     advisory, enforced|gateway.*not implemented|not implemented.*gateway`
     over `docs`, `.metaproject/modules`, `src/commands`, `src/security`.
   - `gateway` alone over `docs`, `.metaproject/modules`,
     `.metaproject/core/README.md`, `src/commands/init.ts` — to catch
     mentions the first regex's exact phrasing could miss.
   - `enforced.*ci|advisory.*enforced|advisory.*never block|only.*modes.*
     block|two modes` over all of `docs` — the broadest pass. The compacted
     summary's header said `cli-reference.md: 6` but the rendered list
     showed only 4 lines; per the dispatch's own warning that this project's
     search summary has been observed truncating a match list without
     saying so, I read the raw log directly
     (`.metaproject/data/gdctx/raw/2026-09-06T18-04-00-233Z_rg.log`) and
     recovered the missing two lines (`cli-reference.md:1058` and the
     already-fixed `:2096`, correctly excluded).
   - `gateway|SecurityMode|security mode` over `docs/docs/` plus a directory
     listing of `docs/docs/guides/`, then a targeted search of
     `permission-modes.md`/`run-in-ci.md`/`contain-an-agent.md` for
     `advisory|enforced|gateway|security` — zero relevant hits (the guide
     pages don't describe security-module mode-blocking at all).
3. For every hit, read the surrounding paragraph with `Read` (not the search
   snippet) to judge whether the sentence actually asserts a closed
   enumeration of blocking modes, or is unrelated prose. Excluded: LLM
   "gateway" providers (`cli-reference.md:229,444`, `harness.md:28` —
   different sense of the word), and historical/unrelated-feature docs that
   matched the same regexes by coincidence (`docs/analysis/**/report.md`,
   `docs/requirements/slate/specification.md`,
   `docs/requirements/shared-agent-context-*`,
   `docs/requirements/keryx-memory-reliability/*`,
   `docs/requirements/roadmap.md` — dated point-in-time snapshots or
   generic vocabulary in planning docs for unrelated features, none
   asserting this module's current behaviour).
4. Checked one generation-adjacent site by inference, not by grep alone:
   `.metaproject/core/security/README.md` is this repository's own
   checked-in output of `renderSecurityCoreReadme()` (confirmed via
   `src/commands/update.ts:444`, `writeTextIfChanged(...,
   renderSecurityCoreReadme())`), the exact generator function T68 already
   fixed at the source (`src/security/templates.ts:124`). Because this repo
   runs its own tooling on itself and `update`/`init` is the only thing that
   re-renders this file, the on-disk copy predates T68's source fix and
   still carried the stale enumeration — read directly at
   `.metaproject/core/security/README.md:17-18` and confirmed stale before
   editing.
5. Checked the direction of the error too (this task's own instruction, and
   T62's underlying concern that the reverse mistake is worse): searched for
   `gateway.*not implemented|not implemented.*gateway|still pending` to find
   places that might *understate* gateway's implementation. Found
   `docs/docs/architecture.md:634` and `docs/docs/modules.md:766`, both
   about the (real, still-unimplemented) always-on gateway/proxy mode from
   spec §16 Phase 4 — a different thing from the `mode: "gateway"` config
   value. Judged each on its own wording (see table).

## Sites, disposition, and the exact correction made

| # | Site | Before | Disposition | After |
|---|---|---|---|---|
| 1 | `src/commands/init.ts:497` | "...block pushes on secret/critical findings (enforced/ci mode only)? Recommended" | **corrected** — this is the interactive prompt an operator reads while choosing whether to install the hook; a wrong description here causes the exact miscalibration the dispatch warned about | "...block pushes on secret/critical findings (enforced/ci/gateway mode)? Recommended" — also dropped "only" since three modes are no longer exhaustively "only" two named ones |
| 2 | `.metaproject/modules/security.md:47-48` | "`advisory` (default) warns...; `enforced`/`ci` block the push...on a secret/critical finding" | **corrected** | "...; `enforced`/`ci`/`gateway` block the push..." |
| 3 | `docs/docs/architecture.md:547` | "advisory...never block); enforced/ci blocks or suppresses the guarded write" | **corrected** | "...enforced/ci/gateway blocks or suppresses the guarded write" |
| 4 | `docs/docs/architecture.md:563` | "...enforced/ci blocks or suppresses the write with a masked category+count reason..." | **corrected** | "...enforced/ci/gateway blocks or suppresses the write..." |
| 5 | `docs/docs/architecture.md:634` | heading "**Security — gateway mode still pending.**" | **corrected (heading only)** — same ambiguity T62 F-004 flagged in the pre-T68 `cli-reference.md:2096` wording: an unqualified "gateway mode still pending" can be misread as "`mode: "gateway"` is inert", the reverse mistake this task is told matters most. Body sentence "the always-on gateway/proxy mode (spec §16 Phase 4)" was already correctly qualified and is left untouched | "**Security — gateway's Phase-4 proxy mode still pending (its blocking behavior already ships).**" |
| 6 | `docs/docs/modules.md:865` | "...**enforced/ci blocks or suppresses the write with a masked category+count reason**..." | **corrected** | "...**enforced/ci/gateway blocks or suppresses the write...**" |
| 7 | `docs/docs/modules.md:874` | "advisory...never blocks; enforced/ci block**." | **corrected** | "...enforced/ci/gateway block**." |
| 8 | `docs/docs/modules.md:881` | "advisory exits 0/warns; enforced/ci exit non-zero and block the push" | **corrected** | "...enforced/ci/gateway exit non-zero and block the push" |
| 9 | `docs/docs/modules.md:766` | "the always-on gateway mode (Phase 4) remains **not** implemented" | **left, accurate** — already qualifies "always-on", matches T68's own Phase-4-proxy resolution; does not claim `mode: "gateway"` is inert | unchanged |
| 10 | `docs/docs/workspace-and-lifecycle.md:339` | "the opt-in security pre-push gate (blocks in `enforced`/`ci` mode)" | **corrected** | "...(blocks in `enforced`/`ci`/`gateway` mode)" |
| 11 | `docs/docs/workspace-and-lifecycle.md:350` | table cell "**advisory (default) warns, enforced/ci block** the push" | **corrected** | "**advisory (default) warns, enforced/ci/gateway block** the push" |
| 12 | `docs/docs/cli-reference.md:330` | "...blocks the push only in `enforced`/`ci` mode..." | **corrected** | "...blocks the push in `enforced`/`ci`/`gateway` mode..." (dropped "only", same reasoning as site 1) |
| 13 | `docs/docs/cli-reference.md:754` | "`enforced`/`ci` mode can suppress a draft's write with a masked reason." | **corrected** | "`enforced`/`ci`/`gateway` mode can suppress a draft's write..." |
| 14 | `docs/docs/cli-reference.md:912` | "`enforced`/`ci` mode can suppress raw-log persistence with a masked reason" | **corrected** | "`enforced`/`ci`/`gateway` mode can suppress raw-log persistence..." |
| 15 | `docs/docs/cli-reference.md:993` | "`enforced`/`ci` mode can skip an entry's write with a masked reason." | **corrected** | "`enforced`/`ci`/`gateway` mode can skip an entry's write..." |
| 16 | `docs/docs/cli-reference.md:1058` | "`enforced`/`ci` mode can fail the gate and hold the flow in `in-progress`." | **corrected** | "`enforced`/`ci`/`gateway` mode can fail the gate..." |
| 17 | `docs/docs/cli-reference.md:2086-2099` | already corrected by T68 | **untouched**, per the dispatch's explicit constraint | unchanged |
| 18 | `.metaproject/core/security/README.md:17-18` | "in `advisory` mode `check` never throws; in `enforced`/`ci` mode a `fail`/`needs-approval` decision must stop the write." | **corrected, out-of-list but plainly the same sentence** — this file is this repo's own checked-in output of `renderSecurityCoreReadme()`, whose source T68 already fixed in `templates.ts:124` (`enforced`/`ci` → `enforced`/`ci`/`gateway`); the on-disk copy here simply predates a re-render. Correcting it under the dispatch's own exception clause ("unless it is plainly the same sentence in another documentation file, in which case correct it and say so") | "...in `enforced`/`ci`/`gateway` mode a `fail`/`needs-approval` decision must stop the write." |
| — | `.metaproject/core/README.md` | generic core README | checked, no mode-blocking prose, not touched |
| — | `docs/analysis/**`, `docs/requirements/slate/*`, `docs/requirements/shared-agent-context-*`, `docs/requirements/keryx-memory-reliability/*`, `docs/requirements/roadmap.md` | matched search regexes | **out of scope, listed not edited** — historical analysis snapshots or unrelated-feature planning prose; none describes `keryx security`'s current mode-blocking behaviour and none is in this task's ownership |
| — | `docs/docs/cli-reference.md:229,444`, `docs/docs/harness.md:28` | "gateway(s)" as LLM-provider gateways | different sense of the word, not touched |

15 sites corrected in-scope, 1 corrected out-of-list under the "same sentence"
exception (disclosed above), 1 site (`modules.md:766`) reviewed and left as
already accurate, all others enumerated and excluded with a stated reason.

## Code defects found and NOT fixed (per "no behaviour changes")

None. Re-reading `src/security/guard.ts` (`isBlockingMode`) and
`src/security/types.ts` (`SecurityMode`) directly confirmed the code already
matches T68's own description — no new disagreement between prose-adjacent
code comments and actual behaviour was found in this pass.

## Verification

| Check | Result | Raw log |
|---|---|---|
| `bun src/cli.ts ctx run -- bun test src/commands/init.test.ts` | 3 pass / 0 fail, 11 expect() calls | `2026-09-06T18-07-23-442Z_run.log` |
| `bun src/cli.ts ctx run -- bun run typecheck` | clean, exit 0 | `2026-09-06T18-07-36-501Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint src/commands/init.ts` | clean, 0 errors, 0 warnings | `2026-09-06T18-07-40-874Z_run.log` |
| `bun src/cli.ts ctx run -- bunx eslint docs/docs/architecture.md docs/docs/modules.md docs/docs/workspace-and-lifecycle.md docs/docs/cli-reference.md .metaproject/modules/security.md .metaproject/core/security/README.md` | clean, 0 errors, 6 informational warnings ("no matching configuration"/"ignore pattern" for `.md` — expected, same as T68's own precedent) | `2026-09-06T18-07-46-365Z_run.log` |
| Post-edit re-scan: `enforced.*ci\|advisory.*enforced` over all 7 changed files | 16 matches, all now read `enforced`/`ci`/`gateway` except the untouched, already-correct `cli-reference.md:2096` | `2026-09-06T18-07-15-656Z_rg.log` |

No test currently pinned the stale `init.ts:497` prompt string (confirmed by
`ctx rg` finding zero hits for the prompt text in `init.test.ts`/
`init.no-git.test.ts` before editing), so no test needed correction — the
existing 3 `init.test.ts` cases stayed green through the edit unmodified.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| AC8: no shipped guidance describes behaviour the code does not have; a reader of any description here, including one written into a user project, is told what the code actually does. | met | 15 sites corrected to `enforced`/`ci`/`gateway` (matches `isBlockingMode`/`SecurityMode` verified directly); the operator-facing `init.ts:497` prompt corrected; `.metaproject/core/security/README.md` (this repo's own generated copy) corrected to match the already-fixed generator source. |
| Every mode description site is enumerated, and each is accurate, corrected, or left with a stated reason. | met | Table above: 18 in-scope-or-adjacent sites plus 2 excluded categories, each with a disposition and reason. |
| No behaviour changes; this is a documentation and string task. | met | Only `.md` prose and one prompt string changed; no `src/security/*` file touched; `git status`-relevant diff is string-only. |
| The focused suites for anything touched stay green. | met | `init.test.ts`: 3/3 pass, unmodified. `typecheck`/`eslint` clean. |

## Concerns

None outstanding. `docs/docs/modules.md:766` was reviewed and deliberately
left unedited (already accurate); disclosed in the table above rather than
silently skipped.

## Routing audit

`graph_used: no (not-relevant — this is a text-shape/prose task over named
files and a small set of specific code comments read read-only for
verification; the graph answers structural/blast-radius questions from the
last `gdgraph build`, not the working tree, and `keryx-tooling-caveats`
project memory flags its answers as historically unreliable on this repo, so
it would not have added anything `ctx rg` did not already answer directly);
wiki_used: no (not-relevant — the normative source for "what the code does"
is the code itself, read directly at `guard.ts`/`types.ts`, and the
normative source for scope/history is the cited prior task artifacts
(T62-review.md F-004, T68-implementation.md), both read directly); ctx_used:
yes (every search via `bun src/cli.ts ctx rg`, both required aggregate
verification commands via `bun src/cli.ts ctx run`, all raw logs cited above
by path; one raw-log read was needed directly, via the `Read` tool, when the
compacted `ctx rg` summary for the broadest search undercounted
`cli-reference.md`'s hits in its rendered list versus its own header count —
noted above and in `T73-spec.md`); raw_rg_used: no — no bare
`rg`/`grep`/`cat`/`find`/`sed` was run over project code or docs in this
task; every search went through `ctx rg`, every multi-line file excerpt
through the `Read` tool at bounded offsets.`
