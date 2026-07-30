# Flow Journal

- 2026-07-12T15:16:49.352Z - flow created
- 2026-07-12T15:16:49.427Z - task-added: T5: EV-01: git mv corpus/gate/tests src/harness -> src/eval + fix external importer + green gates
- 2026-07-12T15:16:49.480Z - task-added: T6: Update live docs (architecture/modules/fixtures README) + EV-01 compat-map (OPEN-4 resolved)
- 2026-07-12T15:16:49.531Z - task-added: T7: W3 verification: code-verifier (tsc + full bun test 554/0) + frozen-pkg untouched + no stray src/harness importers
- 2026-07-12T15:18:50.897Z - frozen: 5 criteria; checksum recorded
- 2026-07-12T15:18:51.009Z - started
- 2026-07-12T15:18:51.066Z - task-done: T1: Collect remaining context
- 2026-07-12T15:22:00.099Z - task-done: T5: EV-01: git mv corpus/gate/tests src/harness -> src/eval + fix external importer + green gates
- 2026-07-12T15:25:33.815Z - task-done: T6: Update live docs (architecture/modules/fixtures README) + EV-01 compat-map (OPEN-4 resolved)
- 2026-07-12T15:29:00.788Z - task-done: T7: W3 verification: code-verifier (tsc + full bun test 554/0) + frozen-pkg untouched + no stray src/harness importers
- 2026-07-12T15:29:00.844Z - task-done: T2: Implement per plan
- 2026-07-12T15:29:00.895Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-12T15:29:00.945Z - task-done: T4: Self-review and prepare draft PR

## Orchestrator notes — W3/EV-01 verification & concerns

- **Baseline (pre-move):** corpus+Block-D+mcp = 15 pass/0; full `bun test` = 554
  pass/0. Captured before any move.
- **Relocation:** 4 files `git mv` `src/harness/`→`src/eval/` — git recorded RENAMES;
  `git diff -M --stat` = 0 insertions/0 deletions (byte-identical, behavior preserved
  by construction). `src/harness/` emptied → reserved for W5+ runtime.
- **Imports:** internal imports UNCHANGED (src/eval same depth as src/harness).
  Single external importer `src/security/detect/mcp.test.ts` repointed to
  `../../eval/{corpus,gate}`. `ctx rg "harness/(corpus|gate)" src` → 0 matches.
- **Docs:** live docs updated (architecture.md, modules.md, fixtures/README.md);
  new deliverable `docs/decisions/keryx-harness/EV-01-corpus-relocation.md`
  RESOLVES ADR-0001 OPEN-4 = **direct rename** (not staged alias). Frozen
  requirements package + ADR-0001 NOT touched (git-verified empty).
- **Green after move:** targeted 15/0; full `bun test` 554/0 (baseline parity);
  `tsc --noEmit` clean. Independently re-verified by orchestrator + T7 review.
- **T7 review: CLEAN** — 7/7 checks PASS, AC1–AC5 PASS.
- **One cosmetic LOW (non-blocking, deferred):** the EV-01 doc's import illustration
  uses shorthand `{corpus,gate}` symbol names rather than the literal exports
  (`runCorpus, loadCorpusCases` / `gateCorpus`); the path change (lines 9–10,
  `../../harness/`→`../../eval/`) is accurate. Left as-is.
- **Minor routing deviation logged:** T7 used one raw `grep -nE "^import"` on the 4
  moved files to cross-check literal import line numbers; results matched ctx rg.
- **Note:** gdgraph index (`keryx gdgraph build`) is generated data and may be
  refreshed post-merge to reflect the new module path; out of commit scope.
- 2026-07-12T15:53:50.522Z - ac-confirmed: AC1: git mv 4 files src/harness->src/eval; renames recorded (R), 0 ins/0 del; src/harness emptied.
- 2026-07-12T15:53:50.577Z - ac-confirmed: AC2: mcp.test.ts imports src/eval/*; ctx rg harness/(corpus|gate) src = 0; internal imports unchanged (same depth).
- 2026-07-12T15:53:50.626Z - ac-confirmed: AC3: src/eval corpus+block-D+mcp 15/0; full bun test 554/0 (baseline parity); tsc --noEmit clean.
- 2026-07-12T15:53:50.676Z - ac-confirmed: AC4: architecture/modules/fixtures README -> src/eval; frozen requirements + ADR-0001 untouched (git empty); OPEN-4 resolved in EV-01-corpus-relocation.md (direct rename).
- 2026-07-12T15:53:50.726Z - ac-confirmed: AC5: runCorpus/gateCorpus byte-identical (0 ins/0 del); compat-map covers 4 files + 1 importer; no other evaluator ref in code. T7 review CLEAN.
- 2026-07-30T16:12:26.610Z - completing: merged commit: 092b94a3c31c538371534ed790f6ee4f0efcf70e
- 2026-07-30T16:12:26.622Z - done: all gates passed
