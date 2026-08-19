# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — already satisfied by the prd-creator/trd-creator investigation in `docs/requirements/keryx-tui-busy-command-allowlist/`; mark done immediately with a journal note, no separate context-collector dispatch needed. |
| T2 | implement | Insert the five busy-branch dispatch arms into `runLine` (`src/tui/tui-shell.ts:3006-3097`) exactly per TRD §1.3. |
| T3 | test | No new automated test is added — TRD's resolved finding: `runLine`'s dispatch has zero existing test coverage for any of its 24 commands, building a harness is out of scope. This task instead confirms the existing full suite (`tsc --noEmit` + `bun test`) still passes unmodified, plus records manual/smoke verification evidence for all 5 acceptance criteria. |
| T4 | review | Run `code-verifier` then `review-orchestrator` on the diff, fix any findings, prepare the PR. |
| T5 | test | (Added 2026-08-19, operator request) Extract `runLine`'s busy-branch decision into `src/tui/busy-dispatch.ts`'s pure `classifyBusyDispatch` per trd.md §8, rewire `runLine`'s busy branch to switch on it (bodies unchanged), and add `src/tui/busy-dispatch.test.ts` covering all 13 cases (AC9/AC10). Run after T2, before T4 (review needs to see the final shape). |
