# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review chunks merge` on a copy of the closed package vantage-frontend #8111 prints the pass finding R-001 (`src/workspace/store/workspace-routing-store.ts:218`, major, chunk-001) and the line `1 chunk-pass findings not in round`; `--json` carries `findings` and `notInRound`. [verify: judged]
- AC2: `keryx review chunks merge` on a copy of #8158 (a pass without findings) prints exactly what the unchanged build prints, byte for byte. [verify: judged]
- AC3: `keryx review complete` on a copy of #8111 whose `findings.json` lacks R-001 warns about it in its output and in `report.md`, and still completes (exit code 0, no refusal). [verify: judged]
- AC4: `keryx review ingest` on a copy of #8111 brings R-001 into `findings.json` with reviewer `review-regression/chunk-001`, it is not in the screen's `rejected`, and a repeated ingest does not add it twice. [verify: judged]
- AC5: for a pass finding the screen does not apply `outside-set` and `no-link-to-change` and its record (`scope.md`, `blast-radius` JSON) names the exemption; a minor pass finding is still dropped by `minSeverity`; a non-pass `review-regression` finding is screened as before. [verify: exec `bun test src/review/chunk-findings.test.ts src/review/blast-radius.test.ts`]
- AC6: a major or blocker pass finding passes the schema through the decided `class_scope` handling (the operator's choice of poll), the ingested package validates, and `keryx review ledger build` on the ingested copy succeeds with the slashed reviewer. [verify: judged]
- AC7: the `review-orchestrator` skill has the step "bring in pass findings": the `merge` result is part of result collection, and with passes finished after the report was written ingest and report are repeated. The four copies (`SKILL.md` and `SKILL.detail.md`, project and bundled) are byte-identical. [verify: exec `bun test src/gdskills/build-parity.test.ts src/gdskills/bundled-eval.test.ts`]
- AC8: `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`, the `chunks`/`complete` help and `CHANGELOG.md` describe the new behaviour. [verify: judged]
- AC9: no new TUI surface is needed: the findings are ordinary round findings once ingested, and the existing review panel and inspector tests pass; this statement and what was checked are written in `verification.md`. [verify: exec `bun test src/tui/review-panel.test.ts src/tui/review-inspector.test.ts`]
- AC10: `bun run typecheck` is clean and the tests of the touched review modules pass. [verify: exec `bun run typecheck`]
- AC11: acceptance ran on copies; the originals of #8111 and #8158 have the same path, size and mtime before and after (fingerprints in `verification.md`). [verify: judged]
- AC12: `verification.md` lists per requirement D1-D4 the evidence of its `Verification:` field, the doc-vs-code discrepancies, and what could not be checked. [verify: judged]
- AC13: nothing is committed or pushed before the operator's word, and no AI attribution appears in files, branch names, commit messages, PR text or flow text. [verify: judged]
