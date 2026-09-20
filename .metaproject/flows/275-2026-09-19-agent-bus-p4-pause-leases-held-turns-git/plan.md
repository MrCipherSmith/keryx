# Implementation Plan

Status: approved for freeze

## Steps

1. **T5 (sonnet), library and gate: first, it defines the contract.**
   - **`src/bus/pause.ts`:**
     - `createPauseLease(root, { holder, toLabel, scope, ttlMs, reason, now })` writes the lease file together with its `pause-request` event under one `append.lock` hold. It refuses `lease-already-held`, `ttl-out-of-range`, `unknown-recipient` and `recipient-not-live`, plus `lease-already-held` for a second active CLI-origin lease in the clone.
     - `resumePauseLease(root, { leaseId, by })` writes `resume` and deletes the file. Only the holder or origin `cli` may end a lease; anyone else gets `not-lease-holder`.
     - `overridePauseLease(root, { leaseId, by })` writes an `override` event.
     - `leasesApplyingTo(root, instanceId, overrides, { now, liveness })` returns the active leases for this instance and scope.
     - `createLeaseView(...)` is a cached reader for the surfaces. It exposes `appliesToMe(scope)`, `held()` (a `turns` lease applies and has not been overridden), `banner()`, `override(leaseId)` and `refresh()`.
   - **`src/lib/command-risk.ts`:** add `isPublishCommand` covering `git push`, `git tag` combined with a push, `gh release`, `gh pr merge`, `npm publish` and `bun publish`.
   - **`src/commands/permission-mode.ts`:** add `ApprovalGateInput.publishLease`, which forces `ask` in every mode and is checked after the `readOnly` deny.
   - **`ApprovalMeta.publishLease`, and `evaluateShellApproval`**, which excludes it from auto-approval so the prompt does not offer "always allow".
   - **`BusClient`:** add `pause`/`resume`/`override` wrappers (origin operator or agent), `leaseView()`, and resume of its own leases in `leave()`.
2. **T6 (sonnet), agent side: runs in parallel with T7a and T7b after T5.**
   - `bus_pause` in `src/bus/agent-tools.ts`, with `risk: "write"`. Its actions are `pause` and `resume`. It is never offered to children or side workers.
   - In `executeCall`, the `write` branch's escalation becomes tool-specific: `classifyPatchRisk` runs only for `apply_patch`, and `bus_pause` has no escalation dimension.
   - In the shell branch, compute `publishLease` as `isPublishCommand(command) && deps.busLeases?.appliesToMe("git-publish")` and pass it to the gate and to the approval meta.
   - Put the conduct text from `agent-protocol.md` §2 in the prompt when the bus is joined.
3. **T7a (sonnet), TUI.**
   - Held turns: gate `runLine`'s main dispatch, side-worker dispatch, `/queue force`, the task-notification wake and the bus wake on `leaseView.held()`. Lines stay queued. `/bus` is always allowed.
   - A persistent status-bar banner showing holder, reason and remaining TTL.
   - Release the hold on resume, expiry or override. The queue then drains.
   - `/bus pause|resume|override` in `bus-command.ts` and the TUI handler.
   - The wake controller's `isIdle` includes "not held".
4. **T7b (sonnet), readline and CLI.**
   - Readline: an operator line while held prints a held notice. The line is kept and runs automatically when the hold is released.
   - `/bus pause|resume|override`.
   - CLI: `keryx bus pause <@name|@all> --reason … [--scope] [--ttl]` and `keryx bus resume <leaseId>`, with the D-13 refusal when `KERYX_TOOL_CALL=1` is set. Register them in the command registry and cli-reference.
5. **T8 (sonnet), process tests.**
   - A pauses `@all` with scope `turns`. B's operator line is held and runs after resume; B's `/bus override` releases B.
   - A is killed, and exactly one `lease-expired` is written.
   - With a `git-publish` lease from A, B's `git push` needs approval under `auto`, even with a saved allowlist.
   - A clean exit resumes the holder's leases.
6. **T9 (haiku):** docs.
7. **Review:** opus for r1, sonnet for verification. Before any push, workers run the source-audit tests that read `tui-shell.ts` or `shell.ts` (see the memory rule).

## Risks

- `tui-shell.ts` and `shell.ts` have many source-audit tests, so each lane must run them.
- The approval floor is security-relevant and must only escalate, never deny (ADR-0009).
- Local runs are targeted only. CI covers the full suite.
