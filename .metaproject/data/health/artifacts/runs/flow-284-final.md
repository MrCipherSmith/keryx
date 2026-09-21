# Code Health

Gate: **PASS**
Coverage: **PARTIAL**
Generated: 2026-09-21T22:27:30.992Z
Scope: project
Git: 624a7a58
Schema: 1
Run: flow-284-final
Worktree: /Users/Goodea/goodea/keryx-session-execution-plan

## Gate Reasons

- OPTIONAL: tests source skipped
- OPTIONAL: dependencyAudit source skipped
- OPTIONAL: sonarqube source skipped
- PASS: no gate conditions triggered
- COVERAGE: partial — optional source(s) produced no result: tests, dependencyAudit

## Score Summary

- health_score: **98** (trend: improved, regression: -5)
- risk_score: 0
- findings: 0 (P0 0, P1 0, P2 0)
- coverage: n/a
- churn: 514619
- complexity: max 161, 589 above threshold
- hotspot: 59433728
- loc: 472555

## Sources

| Source | Status | Execution | Parse | Mode | Required | Findings | Tool |
|--------|--------|-----------|-------|------|----------|----------|------|
| eslint | available | completed | parsed | auto | yes | 0 | v10.10.0 |
| typescript | available | completed | parsed | auto | yes | 0 | Version 5.9.3 |
| tests | skipped | not-run | not-run | auto | no | 0 | - |
| dependencyAudit | skipped | not-run | not-run | auto | no | 0 | - |
| sonarqube | skipped | not-run | not-run | disabled | no | 0 | - |

## Top Findings

- none

## Wiki Freshness

wiki freshness: 8% (8/95 scorable pages), 36 needing attention

## Hotspots

- src/tui/tui-shell.ts: score 15475770 (churn 13830 × complexity 1119)
- src/commands/shell.ts: score 4093626 (churn 5662 × complexity 723)
- src/commands/agent.ts: score 2122260 (churn 4890 × complexity 434)
- src/tui/tui-shell.test.ts: score 1287376 (churn 4733 × complexity 272)
- src/commands/agent.test.ts: score 1147203 (churn 4721 × complexity 243)
- src/security/detect/exfil.test.ts: score 958985 (churn 3565 × complexity 269)
- src/security/detect/exfil.ts: score 910937 (churn 3109 × complexity 293)
- src/commands/review.ts: score 847595 (churn 2779 × complexity 305)
- src/wiki/enrich.ts: score 689931 (churn 2323 × complexity 297)
- src/lib/templates.ts: score 678831 (churn 3187 × complexity 213)

## Affected Scopes

- none

## Skill Scopes

- gdgraph/module: score 98, findings 0, risk 0
- metaproject/init-command: score 98, findings 0, risk 0

## Next Action

No blocking issues. Keep the baseline updated with `keryx health baseline update`.
