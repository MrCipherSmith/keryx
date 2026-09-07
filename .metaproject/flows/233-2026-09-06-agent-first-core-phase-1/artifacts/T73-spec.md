# T73 spec — closing T62 F-004's remaining disclosed sites (prompt string + five docs)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before any edit, per `tdd-workflow.mdc`. This task is documentation/string-only
— no behaviour change, per the dispatch's own constraint.

Ownership for this task: `src/commands/init.ts` and its focused tests,
`.metaproject/modules/security.md`, `docs/docs/architecture.md`,
`docs/docs/modules.md`, `docs/docs/workspace-and-lifecycle.md`, and
`docs/docs/cli-reference.md` (every line except the already-corrected gateway
lines around 2086-2099, which T68 fixed and this task must not re-touch). Not
touching `src/security/self-protect.ts`, `src/security/templates.ts`,
`src/security/guard.ts`, `src/security/types.ts`, `src/security/config.ts`,
`src/security/service.ts`, `src/health/run.ts`, or `src/security/exfil.ts`
(two other workers are concurrently editing the exfil/health files — stay
out).

## What the code actually does (read-only verification, T68's own change)

`src/security/guard.ts:212-213` (`isBlockingMode`), verified by direct read:
"Whether this mode may stop a controlled write (§7a). `advisory` alone
reports and continues; `enforced`, `ci` and `gateway` block." The comment
block above it (`guard.ts:7-10`) states the same for the module as a whole,
plus: an unusable/unrecognized config forces the strictest posture (blocks
even under `advisory`), and `incomplete` engine evidence blocks too, never
silently passes. `src/security/types.ts:93` confirms `SecurityMode =
"advisory" | "enforced" | "ci" | "gateway"` — four modes, not two blocking
labels. This matches T68-implementation.md's own resolution: gateway blocks
identically to enforced/ci at the write seam, the flow completion gate, and
every command's exit code; only gateway's own Phase-4 proxy/backend behaviour
remains unimplemented.

## Enumeration method

1. Started from T68-implementation.md's own disclosed-not-fixed list (its
   "Concerns" section) and T62-review.md's `[F-004]` finding text (read
   directly, both matched byte-for-byte).
2. Independently re-derived the list with `bun src/cli.ts ctx rg` over
   `docs`, `.metaproject/modules`, `src/commands`, `src/security` for the
   patterns `advisory.*enforced|enforced.*advisory|enforced/ci|enforced, ci|
   advisory, enforced|gateway.*not implemented|not implemented.*gateway`,
   then again for `gateway` alone across `docs` + `.metaproject/modules` +
   `.metaproject/core/README.md` + `src/commands/init.ts`, then again for
   `enforced.*ci|advisory.*enforced|advisory.*never block|only.*modes.*block|
   two modes` across all of `docs`. Read the raw log
   (`.metaproject/data/gdctx/raw/2026-09-06T18-04-00-233Z_rg.log`) directly
   for the last search rather than trusting the compacted summary, per the
   dispatch's own warning that the summary has been observed truncating a
   match list without saying so — confirmed the summary undercounted here
   (`cli-reference.md: 6` in the header, only 4 shown in the rendered list;
   the raw log has all 5 project-relevant lines: 330, 754, 912, 993, 1058).
3. For every hit, read the surrounding paragraph with `Read` (not the search
   snippet alone) to judge whether the sentence actually asserts blocking
   behaviour for a closed set of modes, or is unrelated prose that merely
   contains the words "gateway"/"enforced"/"advisory" (e.g. LLM-provider
   "gateways" in `cli-reference.md:229,444` and `harness.md:28`, which are a
   different sense of the word and not touched).
4. Checked one more generation-adjacent site by inference rather than by
   grep hit alone: `.metaproject/core/security/README.md` is this
   repository's own checked-in output of `renderSecurityCoreReadme()`
   (confirmed via `update.ts:444`), the same generator function T68 already
   fixed at the source (`templates.ts:124`). Since this repo runs its own
   tooling on itself, the on-disk copy predates that fix and still carries
   the stale enumeration — read directly and confirmed stale.
5. Checked requirements/analysis hits that matched the same regexes
   (`docs/analysis/**/report.md`, `docs/requirements/slate/specification.md`,
   `docs/requirements/shared-agent-context-*`, `docs/requirements/keryx-
   memory-reliability/*`, `docs/requirements/roadmap.md`) and excluded them:
   they are either dated historical analysis snapshots (point-in-time
   reports, not living guidance) or planning/spec prose for unrelated
   features that mentions "advisory/enforced/CI" as generic vocabulary, not
   an assertion about this module's mode-blocking behaviour. None describes
   what `keryx security` currently does.
6. Checked the direction of the error too (T62 F-002's own concern): searched
   for `gateway.*not implemented|not implemented.*gateway|still pending` to
   find places that might *understate* gateway's implementation status in
   the other direction (calling its blocking behaviour unimplemented when it
   is not). Found `docs/docs/architecture.md:634` ("Security — gateway mode
   still pending") and `docs/docs/modules.md:766` ("the always-on gateway
   mode (Phase 4) remains not implemented"). Judged separately below —
   `modules.md:766` is already correctly qualified ("always-on"), matching
   T68's own resolution wording; `architecture.md:634`'s *heading* drops that
   qualifier and reads as unqualified "gateway mode still pending", which is
   the same ambiguity T62 F-004 flagged and T68 already rewrote once in
   `cli-reference.md:2095-2099`.

## Sites and planned disposition

| # | Site | Current text (paraphrased) | Disposition |
|---|---|---|---|
| 1 | `src/commands/init.ts:497` | prompt: "...block pushes on secret/critical findings (enforced/ci mode only)? Recommended" | correct: add `gateway` |
| 2 | `.metaproject/modules/security.md:47-48` | "`enforced`/`ci` block the push...on a secret/critical finding" | correct: add `gateway` |
| 3 | `docs/docs/architecture.md:547` | "enforced/ci blocks or suppresses the guarded write" | correct: add `gateway` |
| 4 | `docs/docs/architecture.md:563` | "enforced/ci blocks or suppresses the write with a masked category+count reason" | correct: add `gateway` |
| 5 | `docs/docs/architecture.md:634` | heading "Security — gateway mode still pending." | correct: disambiguate heading only (body's "always-on gateway/proxy mode" phrasing is already accurate, left alone) |
| 6 | `docs/docs/modules.md:865` | "enforced/ci blocks or suppresses the write with a masked category+count reason" | correct: add `gateway` |
| 7 | `docs/docs/modules.md:874` | "advisory...never blocks; enforced/ci block" | correct: add `gateway` |
| 8 | `docs/docs/modules.md:881` | "advisory exits 0/warns; enforced/ci exit non-zero and block the push" | correct: add `gateway` |
| 9 | `docs/docs/modules.md:766` | "the always-on gateway mode (Phase 4) remains not implemented" | leave: already accurate — qualifies "always-on", matches T68's own Phase-4-proxy resolution, does not claim `mode: "gateway"` is inert |
| 10 | `docs/docs/workspace-and-lifecycle.md:339` | "the opt-in security pre-push gate (blocks in `enforced`/`ci` mode)" | correct: add `gateway` |
| 11 | `docs/docs/workspace-and-lifecycle.md:350` | table cell "advisory (default) warns, enforced/ci block" | correct: add `gateway` |
| 12 | `docs/docs/cli-reference.md:330` | "blocks the push only in `enforced`/`ci` mode" | correct: add `gateway` |
| 13 | `docs/docs/cli-reference.md:754` | "`enforced`/`ci` mode can suppress a draft's write" | correct: add `gateway` |
| 14 | `docs/docs/cli-reference.md:912` | "`enforced`/`ci` mode can suppress raw-log persistence" | correct: add `gateway` |
| 15 | `docs/docs/cli-reference.md:993` | "`enforced`/`ci` mode can skip an entry's write" | correct: add `gateway` |
| 16 | `docs/docs/cli-reference.md:1058` | "`enforced`/`ci` mode can fail the gate and hold the flow in `in-progress`" | correct: add `gateway` |
| 17 | `docs/docs/cli-reference.md:2086-2099` | already fixed by T68 | leave untouched, per constraint |
| 18 | `.metaproject/core/security/README.md:17-18` | "in `advisory` mode `check` never throws; in `enforced`/`ci` mode a `fail`/`needs-approval` decision must stop the write" | out of the named ownership list, but plainly the same sentence as `templates.ts`'s `renderSecurityCoreReadme()` output, already fixed at the generator source by T68 — correcting per the dispatch's own exception clause, disclosed here |
| — | `.metaproject/core/README.md` | generic core README, not security-specific | checked, no mode-blocking prose found, not touched |
| — | `docs/analysis/**`, `docs/requirements/slate/*`, `docs/requirements/shared-agent-context-*`, `docs/requirements/keryx-memory-reliability/*`, `docs/requirements/roadmap.md` | matched the search regexes | out of scope: historical snapshots or unrelated-feature planning prose, none describes this module's current mode-blocking behaviour; not touched, not this task's ownership |
| — | `docs/docs/cli-reference.md:229,444`, `docs/docs/harness.md:28` | "gateway(s)" as LLM-provider gateways (openrouter etc.) | different sense of the word, unrelated to security modes, not touched |

## Fix pattern

Every "add `gateway`" correction is the same minimal, surgical edit T68 used
in `templates.ts`: extend the closed enumeration `enforced`/`ci` (or
`enforced/ci`) to `enforced`/`ci`/`gateway` (or `enforced/ci/gateway`) at the
exact point each sentence names the blocking modes, preserving surrounding
wording, formatting (backticks/bold), and markdown-table cell structure
byte-for-byte otherwise. No new sentences are added except at site 5
(heading-only disambiguation) and site 1 (prompt string, where "mode only"
must also change since a three-item enumeration is no longer "only" two
named modes — read the exact prompt UX wording before editing to keep it
natural).

## Verification plan

1. `bun src/cli.ts ctx run -- bun test src/commands/init.test.ts` before and
   after (must already pass before, since no test currently pins the stale
   string — confirmed by `ctx rg` finding zero hits for the prompt text in
   `init.test.ts`/`init.no-git.test.ts`).
2. `bun run typecheck`.
3. `bunx eslint` on every source file touched (`src/commands/init.ts` only —
   the rest are Markdown, no eslint config for `.md`, expected no-op per
   T68's own precedent).
4. `T73-implementation.md` (full disposition table + code-defect disclosure
   if any), `T73-result.json` validated against `subagent-result` schema.
5. Routing audit line.

## Code defects noticed while reading (reported, not fixed — out of scope: "no behaviour changes")

None found while doing this pass. `isBlockingMode`, `MODE_RANK`, and the
`SecurityMode` union all agree with each other and with T68's own resolution
(re-verified by direct read of `guard.ts` and `types.ts`, not assumed from
prior task artifacts).
