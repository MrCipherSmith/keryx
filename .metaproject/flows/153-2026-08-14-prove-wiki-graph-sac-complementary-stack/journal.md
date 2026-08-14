# Journal

## 2026-08-14 — PATH reinstall + inventory

- Hard gate: `.metaproject/index.md` read.
- PATH `keryx` was 0.2.28 (no `workspace`). Reinstalled from this tree → 0.2.34.
- SAC = Shared Agent Context. Flows 143/146/148–152 already delivered the
  mechanism. This flow proves complementarity and fallback, not a new store.

## 2026-08-14 — implementation

- `workspace overview|read --explain` traces Facts / Work / Know-how.
- Installed CLI could not load SAC schemas (`dist/cli.js` + `../../docs` →
  parent of the package). Fixed with walk-up resolver + shipped schema files.
- Live run: workspace-e1b704272f124ba7, propose wiki-update from session
  efdc4c01, accept → `.metaproject/wiki/decisions/sac-proposal-a41fc4152ad147e2.md`.
- Enrich without Anthropic key: `credentialAvailable: false`, skipped 1.
  Graph/wiki/memory continued.

## Proof document

`docs/verification/wiki-graph-sac-proof.md`
- 2026-08-14T20:30:30.331Z - task-done: T1: Collect remaining context
- 2026-08-14T20:30:30.402Z - task-done: T2: Implement per plan
- 2026-08-14T20:30:30.476Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-14T20:30:30.554Z - task-done: T5: Add workspace --explain FWK trace
- 2026-08-14T20:30:30.632Z - task-done: T6: Write wiki-graph-SAC proof runbook
- 2026-08-14T20:30:30.707Z - task-done: T7: Run fallback + e2e scenario and record expected/actual
