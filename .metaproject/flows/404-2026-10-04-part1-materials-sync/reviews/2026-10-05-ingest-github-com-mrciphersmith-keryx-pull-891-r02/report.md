# Review of PR #891 (flow 404), head 848fbbe0

Acceptance criteria AC1 to AC10 were checked against the PR diff at its head: the `--since` offset fix in `src/decisions/export.ts` and `src/commands/decisions.ts`, the two-phase write and the failed-run path in `src/commands/research-sync.ts`, the page text in `src/commands/research-sync-status.ts`, the daily job and its day claim in `src/scheduler/research-sync-job.ts`, the serve wiring and the git-untracked entry check in `src/commands/serve-research-sync.ts`, the sidebar row in `src/tui/research-sync-panel.ts`, and the directory test in `src/docs/part1-materials.test.ts`. No blocking or major defect was found. The sync writes only the three `-latest`/status files, never touches git, computes everything in memory before writing, and records a failure reason without changing the `-latest` data files. Two low-impact observations are recorded as info.

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
    "evidence": "OFF_LIMITS = /frontend|backend|board|process-metrics/i is applied to countsText, exportText and statusText in compute(); no current output matches it.",
    "confidence": "medium"
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
    "evidence": "for (const item of staged) { await rename(item.temp, item.file); changed.push(...) } with the catch block only removing the remaining temp files; the header comment already says 'as far as a filesystem allows'.",
    "confidence": "medium"
  }
]
```
