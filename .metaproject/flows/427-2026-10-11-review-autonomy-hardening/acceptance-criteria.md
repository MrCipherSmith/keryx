# Acceptance Criteria

- AC1: BLOCKED A + DONE B не закрывает A; slice claims вне конкретного dispatch не дают coverage. [verify: exec `bun test src/review/ledger.test.ts`]
- AC2: Изменение manifest/content инвалидирует covered/stalls/not-run, включая legacy state без identity. [verify: exec `bun test src/review/slice-dispatch.test.ts src/commands/review-slice.test.ts`]
- AC3: Отказ write/delegate сохраняется до auto-approval при изменении untrustedOrigin. [verify: judged]
- AC4: Untagged ask_user с action/untrustedContent обращается к human host. [verify: exec `bun test src/tui/ask-user-bridge-arbiter.test.ts`]
- AC5: Общий parser принимает bare/fenced/marked JSON, malformed input не даёт coverage. [verify: exec `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts`]
- AC6: DONE с open needs_context даёт actionable context решение вместо accepted. [verify: exec `bun test src/review/slice-dispatch.test.ts`]
- AC7: Cache arbiter возвращает ID текущих options. [verify: exec `bun test src/commands/review-arbiter.test.ts`]
- AC8: Watchdog учитывает nested artifacts и same-size changes, неизменные artifacts распознаёт как stall. [verify: exec `bun test src/review/completion-gate.test.ts`]
- AC9: Восемь regressions и deterministic lifecycle fixture проходят; typecheck/CI результаты или blockers записаны. Нет реальных review-прогонов. [verify: judged]
