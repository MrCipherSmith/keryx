# Review round 1 — flow 266 (background task execution P2)

Reviewed by the orchestrator against `origin/main` (`fa9c5722`), reading the code
as it stands rather than as it was intended. Recorded as
`orchestrator-self-review`: no reviewer skill ran, and in flow 265 the two that
were dispatched stalled before producing a line, so claiming otherwise would put
a name on work nobody did.

Deterministic guards for the same round: `keryx review floor --ref origin/main`
reported 0 findings over 33 files and 1 956 changed lines; the blast-radius record
covers 40 of 138 candidate files (cap) with 18 changed files absent from the code
graph.

One finding. Three things were examined closely and found sound, and they are
worth naming so the round is not read as "only one thing was looked at": the
absolute-cursor arithmetic in `readOutputSince` (`missed`, buffer index and
`nextCursor` agree under both drop paths), the abort races in `shell_exec` and
`shell_task_wait` (the listener is removed on every exit, and `all` mode cannot
settle on one task's timeout), and the observer split (proved by execution on
real processes, including that a side-worker read leaves the notification
pending).

## F-001 (major) — resolving an id across spellings can act on a stranger's task

`resolveTaskId` swapped `job-<n>-<pid>` to `task-<n>-<pid>` for every caller,
including the two kill paths and demote. Every id in a LIVE session is `task-*`,
so the swap can only ever fire for an id from an earlier session — which D-14
says must be a dead reference, because tasks do not survive a session. The swap
preserves the counter and the pid; a session's counter restarts at 1, so a stale
`job-5-<pid>` matches a live `task-5-<pid>` whenever that pid is recycled.

For a read that is a wrong answer. For `shell_job_kill` it is somebody else's
work destroyed, and D-14's guarantee — that nothing is reported as success after
a restart — is what the swap quietly weakened.

The finding also exposed a conflict inside this flow's own frozen criteria: AC5
required both spellings on BOTH aliases, which cannot be satisfied without
reopening that hole. The owner decided: resolve for reads only. AC5 was narrowed
through `keryx flow ac update` and re-sealed, and the acting paths now take the
id exactly as given.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "orchestrator-self-review",
    "severity": "major",
    "file": "src/harness/tool/builtin/background-job-registry.ts",
    "quote": "function resolveTaskId(registry: JobRegistry, id: string): string {",
    "symbol": "resolveTaskId",
    "problem": "The id-spelling swap was applied by every caller, including shell_job_kill, shell_task_kill and demoteTask. A job-* id can only come from an earlier session, which D-14 defines as a dead reference; the swap keeps the counter and the pid, the counter restarts each session, so a recycled pid lets a stale id resolve onto a LIVE task.",
    "impact": "A kill issued with an id copied from a resumed transcript could terminate an unrelated running task — work the operator never asked to discard — while D-14's guarantee that a stale handle resolves to `unknown task_id` is silently weakened. Demote would move a stranger's task aside on the same coincidence.",
    "suggested_fix": "Resolve spellings for READS only. The kill tools and the demote effect take the id exactly as given and refuse anything they do not track.",
    "evidence": "Read of the four call sites at the reviewed head: shellJobOutputTool (read), shellJobKillTool, shellTaskKillTool and demoteTask all passed the id through resolveTaskId. The collision is by construction rather than by observation — a pid collision cannot be staged on demand, which is precisely why the reasoning, not a probe, is the evidence here.",
    "confidence": "high",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/harness/tool/builtin/background-job-registry.ts — shellJobOutputTool (a READ; resolution kept)",
        "src/harness/tool/builtin/background-job-registry.ts — shellJobKillTool (acts; resolution removed)",
        "src/harness/tool/builtin/background-job-registry.ts — shellTaskKillTool (acts; resolution removed)",
        "src/harness/tool/builtin/background-job-registry.ts — demoteTask (acts; resolution removed)"
      ],
      "enumeration_method": "keryx ctx rg --all \"resolveTaskId\\(\" over src — four call sites, each classified as a read or an action; the helper's own definition is the fifth match."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "At the fixed head a new test pins the invariant: `a KILL refuses the old spelling: resolving ids across spellings is for reads only` — shell_job_kill with a job-* spelling of a live task returns a tool error naming that id and leaves the task `running`, while the read alias still accepts both spellings. Run: shell-task-tools.test.ts + background-job-registry.test.ts + shell-exec-background.test.ts, 101 pass / 0 fail. Typecheck clean.",
      "verifier": "p2-suite-run (execution, bun test over the three affected suites)"
    }
  }
]
```
