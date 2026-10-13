# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The schedule fires by itself inside `keryx serve` with no person involved: with a fake clock a due trigger starts exactly one run, a second tick inside the same slot does not start another, and a serve restart does not lose or duplicate a due run. [verify: exec `bun test src/scheduler/digest-schedule.test.ts`]
- AC2: A run calls the granted tools and stores their answers in the run report: open issues and PRs, reviews waiting for the operator and failed CI for each allowed repository, and the product index of the flow board. [verify: exec `bun test src/scheduler/digest-run.test.ts`]
- AC3: The granted-tool catalog contains no mutating `gh` command: every entry has a fixed argv, is on the read-only allowlist and names an allowed repository; adding a mutating or non-allowlisted entry fails the test. [verify: invariant `bun test src/scheduler/digest-tools-readonly.test.ts`]
- AC4: Memory between runs: after a run a snapshot of (id, updatedAt) is saved in `.metaproject/data`; the first run is marked "baseline"; a second run in a row with no changes produces a digest with no items, and with one change produces only that change. [verify: exec `bun test src/scheduler/digest-diff.test.ts`]
- AC5: The digest names what changed, what is stuck, what needs the operator's decision, and every "PR merged, flow closed, effect not checked" chain found in the product index. [verify: exec `bun test src/scheduler/digest-content.test.ts`]
- AC6: The digest is delivered to Telegram through serve into the topic of the project's remote session, or into the service topic "Digest" when there is none; a failed delivery is written in the report and retried, and a failure of `gh` or of the model writes a report entry and a status line in the topic. [verify: exec `bun test src/scheduler/digest-delivery.test.ts`]
- AC7: Limits apply per run: a dollar limit in dispatch, a memory limit and a timeout; a run that exceeds one is stopped and reported. The multi-account rule holds: `gh` runs with the account chosen by the path, and no `gh auth switch` or login is ever called. [verify: exec `bun test src/scheduler/digest-limits.test.ts`]
- AC8: TUI and CLI: the `/schedule` modal and `keryx schedule` list the digest, its next run, the last run's status and the last delivery; the digest can be paused and resumed from both. [verify: exec `bun test src/tui/digest-surface.test.ts`]
- AC9: The docs describe the digest, its configuration (repositories, schedule, topic), the read-only guarantee and the limits: the schedule guide and the CLI reference. [verify: exec `bun test src/scheduler/scheduled-digest-docs.test.ts`]
- AC10: Every test uses a fake `gh`, a fake clock and a fake Bot API; none reaches GitHub, Telegram or a model. [verify: invariant `bun test src/scheduler/no-live-network.test.ts`]
- AC11: Acceptance on the real server: at least 3 digests in a row arrive in the topic from real scheduled firings, not a manual run, with different data. [verify: judged]
- AC12: Each of those digests is understandable without opening GitHub or the board, in the operator's judgement. [verify: judged]
