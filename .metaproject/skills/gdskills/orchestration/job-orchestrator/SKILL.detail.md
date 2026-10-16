# Job Orchestrator - Reference Detail

Reference material moved out of `SKILL.md` to keep it within its length ceiling:
rationale, evidence and long examples. Nothing here is an instruction the agent must
follow at a step; each section is linked from the spot in `SKILL.md` that used it.

## Dry-run plan output example

```
Dry-run plan for: issue-4141--pipeline-validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 1: analyze          [issue-analyzer]           → input: issue #4141
Step 2: context          [context-collector]        → input: analysis result, project_dir
Step 3: prepare          [orchestrator]             → creates: feature/pipeline-validation worktree
Step 4: tests-creator    [tests-creator × 3]        → RED stubs, one per task
Step 5: implement        [task-implementer × 3]     → wave-parallel, 3 tasks
Step 6: sanity-check     [orchestrator]             → verifies commits exist
Step 7: verify           [code-verifier]            → lint + type-check + test + imports
Step 8: review           [review-orchestrator]      → managed round, ingested
Step 9: security         [security-audit]           → conditional: auth/API/DB/env files
Step 10: fix             [task-implementer]         → conditional: if NEEDS_FIX
Step 11: verify-post-fix [code-verifier]            → conditional: after fix
Step 12: perf-check      [perf-check]               → conditional: frontend/bundle files
Step 13: report          [orchestrator]             → aggregates all results
Step 14: pr              [orchestrator + gh CLI]    → conditional: if create_pr
Step 15: deploy          [deploy]                   → conditional: if user asks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Estimated sub-agent calls: 11-14 (varies with tasks and review findings)
No changes will be made. Use without --dry-run to execute.
```

## Post-mortem document template

```markdown
# Post-Mortem: <job-name>

## Timeline
(from .metaproject/jobs/<job-name>/journal.md — every line as recorded)
- <ISO timestamp> - created
- <ISO timestamp> - step: implement in-progress (retries 0)
- <ISO timestamp> - step: implement in-progress (retries 1)
- <ISO timestamp> - step: implement failed (retries 1) — <reason>

## What Went Wrong
- <Step name> failed with: <error class> — <error message>
- Recorded retries: <metrics.steps[].retries>
- Root cause hypothesis: <analysis>

## What Worked
- <N> tasks completed successfully
- Context collection was accurate

## Recommendations for Retry
- Fix <specific issue> before re-running
- Consider splitting task-3 into smaller subtasks
```

## Metrics table in the report

**Aggregated in the report:**
```markdown
## Metrics
| Step | Duration | Retries |
|------|----------|---------|
| Analyze | 45s | 0 |
| Context | 30s | 0 |
| Implement | 5m 22s | 1 |
| Review | 1m 10s | 0 |
| **Total** | **7m 47s** | **1** |
```
