# Implementation Plan

Status: formalized (flow-orchestrator, 2026-08-19)

## Approach

No brainstorm/alternatives needed — the TRD already resolved the single
viable shape (docs/requirements/keryx-tui-busy-mode-command/trd.md
§1.2-§1.3) with no blocking gap found: extract `/mode`'s existing inline
logic into a reusable `runModeCommand` function, call it from both the
existing idle-path arm and one new busy-branch case. Single implementer
task, one code-verifier + review pass — same small-surgical-fix shape as
flow 172.

## Steps

1. **T1 (implement)** — per TRD §1.2: extract `/mode`'s current inline
   block (`tui-shell.ts:3569-3644`) into `const runModeCommand = (line:
   string): void => {...}`, declared alongside `showWorkspace`/`showReview`
   (`tui-shell.ts:2447-2471`). Replace the idle-path block with a 3-line
   call. Per TRD §1.3: add `"mode"` to `BusyDispatchTarget`
   (`busy-dispatch.ts:12-25`), add the `commandName === "/mode"` arm to
   `classifyBusyDispatch`, add `case "mode": { runModeCommand(line); return;
   }` to the busy switch. Extend `busy-dispatch.test.ts` per TRD §8: one
   case asserting `"/mode"` → `"mode"`, one asserting `/model` still →
   `"deferred"` (guard against the two commands' name similarity).
2. **T2 (verify)** — `code-verifier`: typecheck + full `bun test` suite.
3. **T3 (review)** — `review-orchestrator` on the diff (small, 2 source
   files + 1 test file, TUI domain).
4. Fix any findings via a dedicated follow-up task, re-verify, before PR.
5. PR → review-orchestrator against the PR/branch → merge into `main` only
   once clean → `keryx flow implemented --pr` → confirm AC evidence →
   `keryx flow complete`. Per the operator's standing instruction for this
   session: PR, then review orchestrator, only merge once it returns clean.

## Risks

- Very low risk: this is a smaller, more mechanical change than flow 172
  itself — a pure extraction (no logic rewrite) plus one new dispatch case,
  reusing a call pattern (`classifyBusyDispatch` + switch) already proven
  in production.
- Main risk is the extraction accidentally changing `/mode`'s idle-path
  behavior (e.g. dropping the `input.focus()` calls, or changing overlay
  option ordering) — implementer must diff the extracted function against
  the original inline block line-by-line, not retype it from memory.
- Watch for the flow-id collision risk noted in context.md — resolve via
  `keryx flow renumber` at merge time if it recurs, same as flow 173→174.
