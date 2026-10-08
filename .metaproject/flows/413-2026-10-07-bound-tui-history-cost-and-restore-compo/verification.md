# Verified handoff

Worktree `.worktrees/tui-input-latency`, branch `fix/tui-input-latency`. No merge/push/release; changes uncommitted. Flow remains in-progress.

Completed history is capped at 256 unprotected top-level nodes, with recursive destruction and block bookkeeping cleanup. Streaming/focused nodes are protected; expansion alone does not protect history. A trimming notice is shown; archives are untouched, but evicted history is no longer scrollable in this mounted transcript. Focus restoration respects newer choices/modals and nested fallback; reset/empty stream finalization destroys containers; deferred anchoring respects user scrolling.

Focused tests: 150 pass / 0 fail / 913 expectations (shell-chrome, composer-choice, transcript-blocks, modal-host); tsc --noEmit exit 0, task-42-92560. Independent final static review: no concrete findings, did not rerun tests or inspect diff. Parent scope/whitespace checks passed.

Final PTY: task-45-21456 exit 0, artifacts /tmp/keryx-live-tui.b_do7p22/summary.json. All120 probes appeared during streaming; Main and Side delivery verified, prompt focused after both choices, subsequent AFTER_* text retained.

| Messages | Nodes | Median ms | p95 ms | Max ms |
|---:|---:|---:|---:|---:|
| 0 | 93 | 10.9 | 17.8 | 48.5 |
| 100 | 643 | 10.1 | 38.7 | 72.9 |
| 500 | 795 | 14.1 | 38.5 | 77.1 |
| 1000 | 795 | 14.6 | 24.2 | 730.7 |
| 2000 | 795 | 14.9 | 99.4 | 264.7 |
| 4000 | 795 | 25.5 | 134.6 | 161.0 |

20 probes per point, nearest-rank p95; PTY input to matching render-buffer text, not terminal presentation. Before fix at4000:22093 nodes,median145.4ms,p95185.7ms. Controlled synthetic provider, not c053e35 or production network. Rare long stalls remain (max730.7ms at1000); cause not established, no freeze-free guarantee. Bound is completed top-level nodes, not descendants/bytes; active/focused exemptions can grow total size. Full suite and production soak not run.
