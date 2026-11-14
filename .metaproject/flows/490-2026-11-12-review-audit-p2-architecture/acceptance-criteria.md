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

- AC1: A command returns, for a package, the round's current state and the next step with its inputs as JSON, derived from one typed state machine; every status in the lifecycle enum is either written by a transition or removed. [verify: exec `bun test src/review/round-state.test.ts`]
- AC2: An end-to-end test drives a fixture round from start through slice, ledger build, ingest, complete and publish using only the step command and a ledger produced by `ledger build`, with a fake reviewer host. [verify: exec `bun test src/review/round-e2e.test.ts`]
- AC3: "Is a round needed" is answered by a CLI command that calls `classifyRoundNeed`; the orchestrator skill names the command and no longer restates the rule. [verify: exec `bun test src/gdskills/review-orchestrator-preflight.test.ts`]
- AC4: Skill length ceilings are measured in bytes, cover `SKILL.md` together with its sibling detail documents, and keep the only-down ratchet; no line of a bundled skill exceeds 1000 characters. [verify: exec `bun test src/gdskills/skill-length.test.ts`]
- AC5: The combined byte size of `review-orchestrator/SKILL.md` and `SKILL.detail.md` is at most half of its size at `66ee00117` (233427 bytes), with history and measurement narrative moved to decision records. [verify: judged]
- AC6: `src/review` is grouped into stage directories (package, dispatch, ledger, gates, publish, jev); `src/commands/review.ts` dispatches through a table and is under 1500 lines; `src/review` no longer imports from `src/commands`. [verify: judged]
- AC7: The Jev reviewers read their opt-in through one shared reader and one table-driven command path; the eight per-reviewer config modules are gone. [verify: exec `bun test src/review/jev-config.test.ts`]
- AC8: One host port declares each host's capabilities (parallel dispatch, model class, operator cards, usage capture, wave budget); `host !== "keryx-shell"` checks outside that port are removed, and opencode and Grok are named hosts. [verify: exec `bun test src/review/host-port.test.ts`]
- AC9: `ingest` and `ledger build` hold the completion lock while writing, and the completion snapshot list is derived from the files the gates read. [verify: exec `bun test src/review/completion-lock.test.ts`]
- AC10: The wiki page `components/src-review.md` describes the staged layout and the round state machine. [verify: judged]
