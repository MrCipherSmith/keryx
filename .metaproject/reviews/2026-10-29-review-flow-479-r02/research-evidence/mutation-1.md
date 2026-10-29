# Mutation pass

Command: `bun test src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` (baseline exit 0, 701 ms). Run in a scratch copy; the worktree was not written.

Bail: applied (mutants ran with --bail; baseline in full).

Cost: provenance 66 ms, copy 6594 ms, mutants 8061 ms, load 0.9/1.6/1.9.

started 2026-10-28T11:07:50.088Z, head c69cc5177ea0, treeHash aca207db8029.

Killed 14, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| D1 | src/review/degradation.ts:102 | ` \|\| hasEvidenceKind(clean)` → `` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D2 | src/review/degradation.ts:110 | `lowered.blocking_merge = false;` → `lowered.blocking_merge = true;` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D3 | src/review/degradation.ts:29 | `["blocker", "major"];` → `["blocker"];` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D4 | src/review/degradation.ts:108 | `severity: "info", evidence_screen: marker` → `severity: "minor", evidence_screen: marker` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D5 | src/review/degradation.ts:99 | `const outOfList = finding.evidence_kind !== undefined && !hasEvidenceKind(finding);` → `const outOfList = false;` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D6 | src/review/degradation.ts:96 | `    screened += 1; ` → `` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| D7 | src/review/degradation.ts:190 | `if (record.screened === 0) {     return [];` → `if (record.screened === 99) {     return [];` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P1 | src/review/degradation-payload.ts:71 | `Math.max(0, Math.trunc(input.cap))` → `Math.trunc(input.cap)` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P2 | src/review/degradation-payload.ts:89 | ` \|\| barrels.has(dependent.path)` → `` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P3 | src/review/degradation-payload.ts:96 | `b.fanIn - a.fanIn` → `a.fanIn - b.fanIn` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P4 | src/review/degradation-payload.ts:97 | `ranked.slice(0, cap)` → `ranked.slice(0, cap + 1)` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P5 | src/review/degradation-payload.ts:99 | `const capped = dropped.length > 0;` → `const capped = dropped.length >= 0;` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| P6 | src/review/degradation-payload.ts:123 | `seed.names === "*" \|\| seed.names.length > 0` → `seed.names === "*"` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |
| R1 | src/review/slice-routing.ts:104 | `/^[+-]\s*export\s+(\*\|` → `/^[+]\s*export\s+(\*\|` | killed | `bun test --bail src/review/degradation-screen.test.ts src/review/degradation-payload.test.ts src/review/slice-routing.test.ts src/commands/review-degradation-ingest.test.ts` | 1 |

No survivor.
