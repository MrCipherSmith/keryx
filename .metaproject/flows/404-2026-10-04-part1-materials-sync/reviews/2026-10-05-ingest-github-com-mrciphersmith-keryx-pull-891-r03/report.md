# Review of PR #891 (flow 404), round 3, head 848fbbe0 (fix evidence at merge a2c5ab5b)

Round 3 re-raises the two info findings of round 2 after their fix landed in PR 898 (merge a2c5ab5b). Both are checked against that commit: the off-limits guard in `src/commands/research-sync.ts` now matches whole words only, and a rename that fails part-way restores the files already replaced. Each finding is verified by running the research-sync tests at the merge commit.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/commands/research-sync.ts",
    "line": 35,
    "problem": "The off-limits guard is a plain substring test (`board`, `frontend`, `backend`, `process-metrics`) over all three output texts, so any unrelated word that contains one of them makes the whole sync fail.",
    "impact": "A future counts key or value such as `onboarding` or `dashboard` would fail every daily run, and a failed day is not retried until the next UTC day.",
    "suggested_fix": "Match whole words, or limit the guard to the repository names it exists to keep out.",
    "confidence": "medium",
    "evidence": "Fixed in b3ff46af (PR 898, merged as a2c5ab5b): OFF_LIMITS now matches whole words only (lookarounds), exported as namesOffLimits; test: dashboard and keyboard pass, a standalone board still fails."
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/commands/research-sync.ts",
    "line": 235,
    "problem": "Phase two renames the staged files one after another, so a rename that fails after an earlier one succeeded leaves the three files of different generations while the status page says the failed run changed nothing.",
    "impact": "In that rare filesystem-level failure the earlier file is already replaced, which is not the 'previous -latest files untouched' behaviour AC8 states for a failed run.",
    "suggested_fix": "Accept it and say so in the README, or keep a backup of each replaced file and restore it when a later rename fails.",
    "confidence": "medium",
    "evidence": "Fixed in b3ff46af (PR 898, merged as a2c5ab5b): files already renamed are restored from their previous content when a later rename fails; test injects a rename failure on the second file and asserts the previous files are intact, no temp file left."
  }
]
```
