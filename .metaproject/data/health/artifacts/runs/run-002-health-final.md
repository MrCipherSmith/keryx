# Code Health

Gate: **WARN**
Generated: 2026-07-10T12:21:47.614Z
Scope: changed:HEAD (strict)
Git: 34409f6
Schema: 1
Run: run-002-health-final
Worktree: /private/tmp/keryx-execution-observability

## Gate Reasons

- WARN: health regression 6 vs baseline

## Score Summary

- health_score: **89** (trend: regressed, regression: 6)
- risk_score: 355
- findings: 71 (P0 0, P1 0, P2 71)
- coverage: n/a
- churn: 52622
- complexity: max 125, 104 above threshold
- hotspot: 3399315
- loc: 53101

## Sources

| Source | Status | Mode | Required | Findings | Tool |
|--------|--------|------|----------|----------|------|
| eslint | skipped | auto | yes | 0 | - |
| typescript | available | auto | yes | 0 | Version 5.9.3 |
| tests | available | auto | no | 0 | bun-script |
| dependencyAudit | available | auto | no | 0 | 1.3.14 |
| sonarqube | skipped | disabled | no | 0 | - |
| coverage | missing | import | no | 0 | - |
| complexity | available | auto | no | 71 | - |

## Top Findings

- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 11) (src/agents/bootstrap.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 18) (src/assets/command.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 15) (src/assets/lock.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 31) (src/cli.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 25) (src/commands/agents.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 15) (src/commands/ctx.ts)
- [P2] complexity: 2 function(s) exceed cyclomatic complexity 10 (max 17) (src/commands/flow.ts)
- [P2] complexity: 3 function(s) exceed cyclomatic complexity 10 (max 24) (src/commands/gdgraph.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 11) (src/commands/health.ts)
- [P2] complexity: 2 function(s) exceed cyclomatic complexity 10 (max 125) (src/commands/init.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 14) (src/commands/mcp.ts)
- [P2] complexity: 2 function(s) exceed cyclomatic complexity 10 (max 14) (src/commands/memory.ts)
- [P2] complexity: 2 function(s) exceed cyclomatic complexity 10 (max 28) (src/commands/metrics.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 26) (src/commands/modules.ts)
- [P2] complexity: 1 function(s) exceed cyclomatic complexity 10 (max 12) (src/commands/review.ts)

## Hotspots

- src/lib/templates.ts: score 537300 (churn 2700 × complexity 199)
- src/commands/update.ts: score 388531 (churn 1573 × complexity 247)
- src/commands/init.ts: score 375402 (churn 1691 × complexity 222)
- src/wiki/service.ts: score 287168 (churn 1282 × complexity 224)
- src/commands/skills.ts: score 249024 (churn 1297 × complexity 192)
- src/testing/service.ts: score 124560 (churn 865 × complexity 144)
- src/commands/gdgraph.ts: score 90628 (churn 652 × complexity 139)
- src/commands/ctx.ts: score 85239 (churn 861 × complexity 99)
- src/commands/security.ts: score 84420 (churn 670 × complexity 126)
- src/gdskills/learn.ts: score 58038 (churn 569 × complexity 102)

## Affected Scopes

- src/commands: score 86, findings 18, risk 90
- src/gdgraph: score 86, findings 8, risk 40
- src/health: score 85, findings 8, risk 40
- src/security: score 91, findings 7, risk 35
- src/memory: score 89, findings 6, risk 30
- src/standard: score 83, findings 3, risk 15
- src/assets: score 86, findings 2, risk 10
- src/ctx: score 91, findings 2, risk 10
- src/gdskills: score 96, findings 2, risk 10
- src/mcp: score 95, findings 2, risk 10

## Skill Scopes

- gdgraph/module: score 86, findings 8, risk 40
- metaproject/init-command: score 95, findings 1, risk 5

## Next Action

Review warnings; address regressions and low-coverage scopes.
