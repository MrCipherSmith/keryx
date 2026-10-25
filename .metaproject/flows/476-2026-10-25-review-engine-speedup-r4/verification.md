# Verification — flow 476 (review-engine-speedup R4: E3.7.1–E3.7.4, D1–D4)

Acceptance by the `Verification:` fields of the package, run on copies of two closed vantage-frontend review packages
(#8111, #8158) with the build from this worktree (`bun src/cli.ts …`, cwd inside the copy). For #8158 the baseline is the
installed 0.3.131 build on a second copy. The originals were fingerprinted (path, size, mtime of every file) before and
after: both unchanged (`#8111` 100 files, hash `84edccda1e1c`; `#8158` 113 files, hash `16452b822183`). `ingest` ran on a
local clone of the #8111 repository at its head (`d10c3790f0`) with the copied `.metaproject`, never in the original.

## Result per package

| Check | Result |
|---|---|
| D1 `chunks merge`, #8111 (R-001) | prints `R-001 major src/workspace/store/workspace-routing-store.ts:218 [chunk-001]` and `1 chunk-pass findings not in round: …`; `--json` keys include `findings` (1) and `notInRound` (1) |
| D1 `chunks merge`, #8158 | text, `--json` and `chunk-pass.json` byte-identical to the 0.3.131 build (25/25 chunks, 0 findings; no `notInRound` key) |
| D2 `review complete`, #8111 | `warning: 1 chunk-pass finding(s) are not in findings.json: R-001 major … [chunk-001]. …this close does not refuse.`; exit 0; `report.md` gains `## Chunk pass findings not in the round` with R-001; a second `complete` leaves one section, not two |
| D3 `review ingest --review-id`, #8111 | `findings.json` 13 → 14; `chunk-001-R-001`, reviewer `review-regression/chunk-001`, severity major, with a class_scope; screen line `rejected=0 exempted=1`; `scope.md` and the console name the exemption; a second ingest still holds 14 findings and one R-001 |
| D3 schema | all 14 findings validate against `review-finding.schema.json` (checked that the validator rejects `source: "chunk-pass"` and a major without `class_scope`) |
| D3 ledger | `keryx review ledger build --package … --dry-run` → READY with the slashed reviewer |
| D4 skill | `review-orchestrator` Step 3b names the `chunks merge` output as part of result collection and the step "bring in pass findings"; four copies byte-identical; line ceiling held (1571) |

## Findings the text did not predict

1. **`source` is an enum** (`internal`/`external`) in a schema with `additionalProperties: false`, so "source
   `review-regression/chunk-NNN`" cannot be a `source` value. The origin lives in `reviewer` (`<reviewer>/<chunk>`).
2. **Doc 15 does not mention `class_scope`**, yet the schema requires it for blocker/major. Per the operator's choice (poll
   302) a pass finding keeps its own valid class_scope; otherwise it carries a placeholder whose `enumeration_method`
   starts `NOT ENUMERATED` and names the pass. No enumeration is invented.
3. **Ingest reads the live pass, not `chunk-pass.json`.** `computeChunkPass` computes the same result from the plan and
   the chunk results without writing, so ingest needs no prior `merge`. It also needs `--review-id` of the package where
   the chunks ran (a new ingest package has no chunk plan).
4. **A pass can finish after the report was written.** Ingest then runs again and the report is rewritten (skill step);
   `review complete` cannot know, so it warns and records the gap in `report.md` instead of refusing (variant A, poll 283).
5. **Pass findings carry no `quote`**, so they are not located against the diff and are not refused for that.
6. **R-001 and F-009 of #8111 are not merged**: F-009 is at `src/workspace/routing/…:215`, R-001 at
   `src/workspace/store/…:218` (different path). De-duplication across paths is out of scope.
7. **The exemption cannot be claimed by name.** The screen exempts by the `global_id` of findings this ingest injected, so
   a report finding that merely carries the reviewer name `review-regression/chunk-001` is still screened (test).
8. The #8111 copy cannot be completed as is: its `report.md` has no `Evidence level:` line (older format). The
   acceptance run appended that line to the copy; this is a property of the old package, not of the change.

## Requirements and how they were accepted

| Requirement | Evidence |
|---|---|
| D1 merge prints findings | #8111 copy (above); `chunk-findings.test.ts` "chunks merge prints what the pass found" (3, one byte-exact for no findings) |
| D1 unchanged without findings | #8158 copy byte-identical (text, JSON, file) |
| D2 complete warns | #8111 copy; `managed.test.ts` R4-D2 tests (warn, section idempotent, clean after ingest) |
| D3 ingest brings findings in | #8111 copy; `managed.test.ts` R4-D3 tests; `blast-radius.test.ts` "chunk-pass" (3: exemption, minor dropped, not by name) |
| D3 minor dropped by the threshold | `blast-radius.test.ts` "still dropped by the severity floor" |
| D4 skill step | diff of the four SKILL copies; `build-parity.test.ts`, `bundled-eval.test.ts` |
| Docs | `docs/docs/cli-reference.md` (chunks, ingest/complete help), `docs/docs/guides/review-with-a-record.md`, `CHANGELOG.md` `[Unreleased]`, `--help` of `review ingest` and `review complete` |

Tests: AC5 `bun test src/review/chunk-findings.test.ts src/review/blast-radius.test.ts` green; AC7 `src/gdskills/build-parity.test.ts
src/gdskills/bundled-eval.test.ts` green; AC9 `src/tui/review-panel.test.ts src/tui/review-inspector.test.ts` green (311 tests in
all eight files run together); `bun run typecheck` clean.

## TUI (AC9)

No new TUI surface is needed. The change adds no new state: `chunks merge`, `ingest` and `complete` print more lines, and the
findings an ingest brings in are ordinary round findings (reviewer `review-regression/chunk-001`), which the review panel and
the inspector already list from `findings.json`. The two TUI test files pass unchanged.

## Could not be checked

- A live review with a real chunk pass that finds something and finishes after the report (only the #8111 copy and unit tests).
- `review complete` right after an ingest on the #8111 copy: ingest rewrites the package's `report.md` without the
  `Evidence level:` line the acceptance run had appended, so the clean close is covered by unit tests only (R4-D2).
- The pull request head/merge check of `complete` (no GitHub access for the copy; the command printed its usual skip warning).
