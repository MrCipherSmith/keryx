# Flow Journal

- 2026-08-20T15:37:07.807Z - flow created
- 2026-08-20T15:40:03.871Z - task-added: T5: Live probe against real codex mcp-server: capture elicitation request/response shapes, confirm codex_call_id version-fix status
- 2026-08-20T15:40:03.983Z - task-added: T6: src/mcp-client/: stdio MCP client module on @modelcontextprotocol/sdk
- 2026-08-20T15:40:04.085Z - task-added: T7: MCP-shaped supervisor for codex-cli: new supervision path wired into external dispatch, ExternalEvent vocabulary preserved
- 2026-08-20T15:40:04.186Z - task-added: T8: Elicitation handling: resolveApprovalDecision + requestApproval/AgentIO wiring, ElicitResult response
- 2026-08-20T15:40:04.292Z - task-added: T9: Escalation classifier (destructive/credentials) feeding resolveApprovalDecision, ADR-0010 shape
- 2026-08-20T15:40:04.384Z - task-added: T10: Three rough-edge defenses: timeout->named refusal, malformed/empty content->deny, codex_call_id version-skew
- 2026-08-20T15:40:04.485Z - task-added: T11: Capability gate: fold into gdskills.external-agents descriptor, no second toggle
- 2026-08-20T15:40:04.593Z - task-added: T12: TUI surfacing for a pending elicitation (same path as existing write-risk approval prompt)
- 2026-08-20T15:40:04.696Z - task-added: T13: Fixtures fixtures/mcp-client/codex/* + tests for AC1-AC9; confirm original external-agent-runtime AC5 suite passes unmodified
- 2026-08-20T15:40:04.808Z - task-added: T14: Revise keryx-external-agent-runtime spec/decisions to record the D-05 approval-routing layer
- 2026-08-20T15:40:40.786Z - frozen: 9 criteria; checksum recorded
- 2026-08-20T15:40:48.102Z - started
- 2026-08-20T16:00:14.024Z - task-done: T5: Live probe against real codex mcp-server: capture elicitation request/response shapes, confirm codex_call_id version-fix status
- T5 concern (DONE_WITH_CONCERNS-shaped, accepted, folded into context.md and
  plan.md rather than a new task): the live probe found the spec's data-
  contract assumptions (§5.1/§5.2) incomplete, not wrong. Real, load-bearing
  discoveries: (1) the SDK's `ElicitRequestSchema` strips codex's vendor
  fields (`codex_call_id` etc.) via Zod unknown-key stripping - a raw wire
  tap or custom schema is required, plain `setRequestHandler` is not enough;
  (2) codex's own `ExecApprovalResponse` needs a non-standard top-level
  `decision` field, not `ElicitResultSchema`'s own `content` shape, and the
  valid `decision` values are NOT a fixed enum - they come from a sibling
  `codex/event` notification (`exec_approval_request`, `available_decisions`)
  correlated by `call_id`; (3) `requestedSchema` is empty on every real
  elicitation observed (not an anomaly - AC5's "malformed content" defense
  is really "no `codex/event` correlation found -> deny safely"); (4) the
  outer `tools/call` can outlive a cleanly-declined elicitation and needs its
  own independent timeout handling. plan.md step 4 revised accordingly.
  T13's fixture list needs a follow-up live probe for the `patch-approval`
  elicitation variant's vendor fields (only the SDK-stripped view was seen
  for that one) before it can be pinned - noted in tasks.md, not a new task.
- 2026-08-20T16:47Z - task-implementer dispatch for T6+T7+T8 stalled once
  (10 min no-progress watchdog) mid-way through its own full-suite check,
  but left real, complete work on disk: `src/mcp-client/` (client.ts,
  wire.ts, elicitation.ts, types.ts + tests) and
  `src/harness/external/supervise-mcp.ts` (+ test), all following T5's
  live-probe findings correctly (raw-wire tap, codex/event correlation,
  non-standard `{action, decision}` response, zero-dep lazy-SDK-import
  policy mirroring `src/mcp/server.ts`). Verified independently: `tsc
  --noEmit` clean; new tests 41 pass/1 skip; AC8's `agent-event-bridge.test.ts`
  suite + `no-optional-imports.test.ts` + all new mcp-client/supervise-mcp
  tests together: 69 pass/1 skip/0 fail. A full local `bun test` shows ~46
  unrelated failures - verified pre-existing via `git stash` + re-run
  against clean `main` (identical failures, zero mcp-client code present);
  documented in context.md so it is not re-investigated later. T6, T7, T8
  marked done.
- 2026-08-20T17:00:01.394Z - task-done: T6: src/mcp-client/: stdio MCP client module on @modelcontextprotocol/sdk
- 2026-08-20T17:00:01.494Z - task-done: T7: MCP-shaped supervisor for codex-cli: new supervision path wired into external dispatch, ExternalEvent vocabulary preserved
- 2026-08-20T17:00:01.586Z - task-done: T8: Elicitation handling: resolveApprovalDecision + requestApproval/AgentIO wiring, ElicitResult response
- 2026-08-20T17:13:49.869Z - task-done: T9: Escalation classifier (destructive/credentials) feeding resolveApprovalDecision, ADR-0010 shape
- 2026-08-20T17:13:49.970Z - task-done: T10: Three rough-edge defenses: timeout->named refusal, malformed/empty content->deny, codex_call_id version-skew
- T9+T10 (commit `6640874`): `classifyElicitationRisk` implemented for real -
  reuses `isDestructiveCommand`/`touchesAgentCredentials` from
  `src/lib/command-risk.ts` against `vendor.codex_command`/`codex_cwd`;
  `patch-approval` elicitations escalate `destructive: true`
  unconditionally (no parsed diff hunks available at this layer, so the
  whole elicitation is treated as destructive rather than understating
  risk - documented decision, not settled by the spec). AC9 fixture proves
  both booleans independently true. AC4: `deps.requestApproval` is now
  raced against a new `elicitationTimeoutMs` (default 45s, ~10-15s margin
  under T5's observed 55-60s codex self-abort window), timing out to a
  deny with a new `ElicitationHandledRecord.timedOut` flag distinguishing
  it from an operator's real "no". AC5 and the codex_call_id version-skew
  case were verified already-correct (uncorrelated/missing-field paths
  already degrade safely) and got regression tests added, no production
  code needed. `reasons` field added to `ElicitationRiskClassification` but
  deliberately left unwired into the approval-prompt metadata, matching
  `classifyPatchRisk.reasons`'s own current (also-unwired) state in
  `agent.ts` - not a gap this flow introduced. Verified independently:
  `tsc --noEmit` clean, 80 pass/1 skip/0 fail on the relevant test set.
- 2026-08-20T17:28:50.046Z - task-done: T11: Capability gate: fold into gdskills.external-agents descriptor, no second toggle
- 2026-08-20T17:28:50.150Z - task-done: T12: TUI surfacing for a pending elicitation (same path as existing write-risk approval prompt)
- T11+T12 (commit `48360aa`): new `gatedSuperviseCodexMcpRun` in
  `supervise-mcp.ts` is the one entry point for a real codex MCP run - calls
  `resolveExternalAgentsCapability` then `agentConfig(...,"codex-cli").enabled`
  (same helpers `run-external-factory.ts` already uses for the existing
  path), no new capability id/config key/CLI flag. 4 new tests prove every
  refusal path never calls `client.connect`. `dispatch.ts`/`registry.ts`/the
  existing `codex exec` production path in `run-external-factory.ts` are
  untouched. T12: `describeElicitationPrompt` (pure, tested) turns the
  `mcp_elicitation:<id>` synthetic tool name + JSON input back into a
  readable message/command, wired into both `shell.ts` and `tui-shell.ts`'s
  approval renderers (previously would have shown raw JSON - `tui-shell.ts`
  had no generic-tool branch at all before this). Rendering closures
  themselves stay untested by design, matching this repo's existing
  convention for `apply_patch`/`shell_exec` (pure logic tested, terminal
  I/O glue is not) - the implementer flagged this explicitly rather than
  silently skipping it. Verified independently: `tsc --noEmit` clean, 433
  pass/1 skip/0 fail across the full mcp-client+external+capability test
  set, AC8's `agent-event-bridge.test.ts` untouched (24/24).
- task-done: T13 (commit `f413ee9`) and T14 (commit `02c1c79`). T13:
  discovered the T5 raw JSON payloads were never actually preserved in flow
  bookkeeping (only prose survived) - rather than hand-author fixtures from
  the prose, ran ITS OWN fresh live probe against the same real codex
  mcp-server (0.147.0) using the shipped `connectCodexMcpClient`, and
  independently re-confirmed every T5 finding. `fixtures/mcp-client/codex/`
  now has 3 genuinely `captured: true` fixtures (approve/deny/timeout) and 2
  honestly-caveated `.SYNTHETIC.` ones (malformed-empty-content,
  missing-codex-call-id), all documented in a manifest.json mirroring
  fixtures/external's house style. Added a new flag-gated live test
  (`live-elicitation.smoke.test.ts`) driving the real production supervisor
  against a real spawned codex child for both approve and decline - this is
  AC3's "verified against the live process" clause. T14 corrected two
  passages in `keryx-external-agent-runtime/decisions.md` (D-03's "kept
  idea 1", D-04's "guarded-mutation path" -> `resolveApprovalDecision`)
  without lifting that package's own worktree-write release gate, using its
  existing "Amended by flow N" precedent; bumped roadmap.md.
  Independent verification (this session, not the implementer): typecheck
  clean; 469 pass/0 fail on the full offline mcp-client+external+capability
  set; re-ran BOTH live smoke tests myself with KERYX_ALLOW_REAL_SUBPROCESS=1
  against the real codex binary - AC1 (spawn+handshake) 1/1 pass; AC3's
  decline case needed a generous timeout to observe cleanly (my first two
  attempts used too-short `--timeout` values and got killed mid-flight by
  MY OWN test-runner limit, not a supervisor hang - a clean run at 300s
  completed in 92.71s, matching the code's own internal 90s
  toolCallTimeoutMs almost exactly; no lingering codex processes after).
  All 14 tasks now done. Proceeding to AC confirmation and completion.
- All 9 AC confirmed via `keryx flow ac confirm`. Opened PR #362 against
  `main`. A concurrent, unrelated PR (#361, `keryx-skills-runtime-tools`)
  merged to `main` first and collided on `docs/requirements/roadmap.md`'s
  Changelog (both independently used version `0.22.0` for their own entry)
  — resolved by merging `origin/main` into the flow branch, renumbering
  this flow's entry to `0.23.0`, and bumping the file's own Version header
  to match. While resolving, corrected a staleness in T14's own roadmap
  entry (written before T13 landed): it originally said all 5
  `fixtures/mcp-client/codex/*` files were uncommitted `.SYNTHETIC.`
  placeholders - now accurately says 3 are `captured: true` from a real
  live run and all 5 are committed, plus names the two live smoke tests.
  `tsc --noEmit` clean after the merge; pushed; `src/commands/shell.test.ts`
  pre-push security finding confirmed identical to `main` (came in via the
  merge, not part of this flow's diff) - not investigated further.
- 2026-08-20T18:06:12.352Z - task-done: T13: Fixtures fixtures/mcp-client/codex/* + tests for AC1-AC9; confirm original external-agent-runtime AC5 suite passes unmodified
- 2026-08-20T18:06:12.438Z - task-done: T14: Revise keryx-external-agent-runtime spec/decisions to record the D-05 approval-routing layer
- 2026-08-20T18:06:49.849Z - ac-confirmed: AC1: src/mcp-client/client.smoke.test.ts: live handshake against real codex-cli 0.147.0, re-verified this session with KERYX_ALLOW_REAL_SUBPROCESS=1 (1 pass)
- 2026-08-20T18:06:49.938Z - ac-confirmed: AC2: fixtures/mcp-client/codex/approve.jsonl+deny.jsonl (captured:true from a real codex mcp-server run), replayed offline by src/mcp-client/fixtures.test.ts
- 2026-08-20T18:06:50.026Z - ac-confirmed: AC3: src/mcp-client/live-elicitation.smoke.test.ts: superviseCodexMcpRun driven against a real spawned codex mcp-server, both approve (file created) and decline (file never created) cases; re-verified this session, both pass (92.71s decline, within its own 90s internal timeout)
- 2026-08-20T18:06:50.120Z - ac-confirmed: AC4: fixtures/mcp-client/codex/timeout.jsonl (captured:true, reproduces openai/codex#11816's turn_aborted/reason:interrupted) + supervise-mcp.test.ts's elicitation-answer-timeout suite (requestApproval that never resolves still completes, recorded as ElicitationHandledRecord.timedOut:true, not a hang)
- 2026-08-20T18:06:50.207Z - ac-confirmed: AC5: buildElicitationResponse declines without a decision field for any uncorrelated elicitation (no sibling codex/event, or empty available_decisions) - the live-reconfirmed manifestation of openai/codex#23383; fixtures/mcp-client/codex/malformed-empty-content.SYNTHETIC.jsonl + supervise-mcp.test.ts/elicitation.test.ts coverage
- 2026-08-20T18:06:50.292Z - ac-confirmed: AC6: supervise-mcp.ts calls resolveApprovalDecision unconditionally for every elicitation before responding; supervise-mcp.test.ts asserts the call and gateDecision for both auto and ask modes, re-confirmed live in live-elicitation.smoke.test.ts (gateDecision:"ask" asserted in both live cases)
- 2026-08-20T18:06:50.375Z - ac-confirmed: AC7: src/mcp-client/credential-boundary.test.ts: no credential-shaped env/identifier read in src/mcp-client/ or supervise-mcp.ts; child env is forwarded verbatim from the caller (McpSpawnOptions.env), same D-01 boundary keryx-external-agent-runtime already verifies
- 2026-08-20T18:06:50.465Z - ac-confirmed: AC8: src/harness/external/agent-event-bridge.test.ts is byte-for-byte unmodified (git diff main -- that file is empty) and passes 24/24; the elicitation exchange records to ElicitationHandledRecord/elicitations, never to ExternalEvent
- 2026-08-20T18:06:50.560Z - ac-confirmed: AC9: elicitation.test.ts's classifyElicitationRisk suite: a single fixture (sudo cat .../auth.json-shaped command) independently proves destructive:true and credentials:true via reused isDestructiveCommand/touchesAgentCredentials, feeding resolveApprovalDecision exactly like classifyPatchRisk does for write
- 2026-08-20T18:07:09.732Z - task-done: T1: Collect remaining context
- 2026-08-20T18:07:09.822Z - task-done: T2: Implement per plan
- 2026-08-20T18:07:09.905Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-20T18:07:09.989Z - task-done: T4: Self-review and prepare draft PR
- PR #362 review round 1 (CI green, 11/11): dispatched the `/code-review high`
  skill (6 finders + 4 verifiers) against the full diff. It found REAL safety
  bugs the AC9/AC-confirmation pass above missed - the AC9 fixture used an
  unwrapped `sudo cat .../auth.json`-shaped command, while codex's ACTUAL
  wire shape (per fixtures/mcp-client/codex/approve.jsonl) always wraps as
  `["/bin/zsh","-lc","<command>"]`, and `classifyElicitationRisk` naively
  joins that array before checking `isDestructiveCommand`, whose
  segment-head classifier then only ever sees "/bin/zsh" - so destructive
  detection is dead code for every REAL codex command, meaning a genuinely
  destructive command (e.g. `rm -rf /`) would auto-approve under trust mode.
  Also found: `sacReviewConfirmation` hardcoded `false` instead of derived
  via `touchesSacConfirmReview` (a hard-floor bypass); `isApprovalGranted`
  never validates the approval response's `fingerprint`, unlike every other
  `requestApproval` call site's `isApprovalFor`; no `onAutoApproved`
  notification on the auto-approve path (silent under trust/auto, unlike
  every other risk gate); `connection.close()` unguarded, can discard an
  already-successful outcome; SDK-internal reach with no try/catch;
  `pendingCodexEvents` Map never cleaned up (leak on long multi-elicitation
  runs); two DRY findings (dup warning-render block, dup timeout idiom).
  Also caught a stale/overclaiming roadmap.md package-summary row (written
  by T14 before T13 landed) saying "elicitation exchange offline-verified,
  live probe unconfirmed" and "Migrated codex-cli fully onto mcp-server" -
  the latter is false, nothing wires `gatedSuperviseCodexMcpRun` into
  `dispatch.ts`/`registry.ts`'s default production routing. Fixed that
  roadmap row myself directly (text-only). Dispatched a fix-round
  task-implementer for the 8 code findings (1 CRITICAL, 1 CRITICAL, 1 HIGH,
  4 MEDIUM, 2 LOW/optional) with exact root causes and reuse targets
  (`isApprovalFor` in `agent.ts` needs exporting, not duplicating). This is
  attempt 1 of the review/fix loop (max 6 before a strategy change per
  flow-orchestrator).
- 2026-08-20T19:45:41.713Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/362 (warning: PR is not a draft)
- 2026-08-20T19:45:50.381Z - completing
- 2026-08-20T19:45:53.010Z - done: all gates passed
- 2026-08-21T17:05:11.951Z - renumbered: 182 -> 187: duplicate id 182: this flow is a local, never-committed directory; 182-2026-08-21-slate-v3-slate-22-26-private-mcp-slate-l is the shared/committed one (merged via PR #377, referenced by flow 186's own specification.md SLATE table) — renumbering the local copy to the next free id instead
