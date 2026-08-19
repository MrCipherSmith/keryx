# Flow Journal

- 2026-08-19T17:59:35.989Z - flow created
- 2026-08-19T18:02:23.409Z - task-added: T5: Record JSONL fixtures for codex-cli and claude-cli (success, not-logged-in, limit, bad argv, empty, resume, error-word)
- 2026-08-19T18:02:23.494Z - task-added: T6: Foundations: external/types.ts codec port, registry.ts with both entries, env.ts deny lists and prefix sweeps
- 2026-08-19T18:02:23.585Z - task-added: T7: Contract: runtime block on subagent-dispatch schema + pure validator (agent, sandboxModes, read-only vs allowed_actions, worktree-write refusal)
- 2026-08-19T18:02:23.675Z - task-added: T8: Codec codex-cli: argv, JSONL parser, failure classifier (subtract prompt, error/usage lines only), resume argv
- 2026-08-19T18:02:23.766Z - task-added: T9: Codec claude-cli: argv, stream-json parser, failure classifier (login refusal on stdout with exit 0), resume argv
- 2026-08-19T18:02:23.852Z - task-added: T10: Runtime: supervise.ts process lifecycle + raced kill, runtime.ts spawnChild integration, worktree lifecycle, ledger, result validation
- 2026-08-19T18:02:23.939Z - task-added: T11: Capability gate, config shape, remote/CI hard disable, keryx agents external list|probe
- 2026-08-19T18:02:24.029Z - task-added: T12: TUI: external session kind, modal tabs Work/Meta/Command, per-addressee queue on generalised main-queue helpers, force as kill+resume
- 2026-08-19T18:02:24.116Z - task-added: T13: Docs: README and docs site updated alongside the code; package status moved off spec-ready only for what shipped
- 2026-08-19T18:03:12.969Z - task-done: T10: Runtime: supervise.ts process lifecycle + raced kill, runtime.ts spawnChild integration, worktree lifecycle, ledger, result validation
- 2026-08-19T18:03:13.148Z - task-done: T11: Capability gate, config shape, remote/CI hard disable, keryx agents external list|probe
- 2026-08-19T18:03:13.324Z - task-done: T12: TUI: external session kind, modal tabs Work/Meta/Command, per-addressee queue on generalised main-queue helpers, force as kill+resume
- 2026-08-19T18:03:13.497Z - task-done: T13: Docs: README and docs site updated alongside the code; package status moved off spec-ready only for what shipped
- 2026-08-19T18:03:13.685Z - task-added: T14: Runtime: supervise.ts process lifecycle + raced kill, runtime.ts spawnChild integration, worktree lifecycle, ledger, result validation
- 2026-08-19T18:03:13.861Z - task-added: T15: Capability gate, config shape, remote/CI hard disable, keryx agents external list|probe
- 2026-08-19T18:03:14.040Z - task-added: T16: TUI: external session kind, modal tabs Work/Meta/Command, per-addressee queue on generalised main-queue helpers, force as kill+resume
- 2026-08-19T18:03:14.216Z - task-added: T17: Docs: README and docs site updated alongside the code; package status moved off spec-ready only for what shipped

## Note on T10–T13 (skipped, not abandoned)

T10–T13 were added with wrong `dependsOn` edges: `keryx flow task add` assigns
ids sequentially, and the `--depends` arguments had been written against an
intended numbering rather than the assigned one. The result was T10 depending on
itself, and T11/T12 depending on the claude codec instead of the runtime task.

The CLI exposes only `task add` and `task done`, and `flow.json` is CLI-owned
and must not be hand-edited, so the four entries were closed with
`--disposition skipped` and re-added as T14–T17 with correct edges. **No work
was dropped** — T14–T17 carry the identical titles and kinds. The intended
graph, now in force:

```text
T1 discovery ─┬─ T5  fixtures ──┬─ T8  codec codex ─┬─ T14 runtime ─┬─ T15 capability ─┬─ T17 docs
              └─ T6  foundations┤                    │              └─ T16 TUI ────────┘
                                ├─ T9  codec claude ─┘
                                └─ T7  contract ─────┘
```

`keryx flow check` reports no issue against this flow; its one finding concerns
flow 002 and predates this work.

## T1 discovery — findings (2026-08-19)

Four of the four unknowns recorded in `context.md` are now answered. Three
overturned an assumption carried in specification 0.1.0, which is bumped to
0.2.0; `decisions.md` D-08 is amended to 0.2.0. **No frozen acceptance criterion
is invalidated** — AC17's substance (no parallel spawn path, ledger, depth
accounting or event stream) still holds, because authorisation still runs
through `spawnChild`.

**1. The execution seam is not `spawnChild` — it does not exist yet.**
`spawnChild` (`src/harness/child/spawn.ts:119`) is a *pure* authorisation and
contract builder: guard order caps → budget → policy → model, returns a
`ChildContractExtension` + session-entry payload + provenance, executes nothing,
and its only deps are `idSeq` and `clock`. Execution lives one layer up at
`src/harness/tool/builtin/spawn-subagent-tool.ts:873`, which calls
`runAgentTurn(...)` through a **static import — not injectable**.
`SpawnSubagentToolDeps` (`:206`) injects `makeProvider`, i.e. the *provider*,
not the *runner* — precisely the seam D-02 rejected as wrong for whole-agent
CLIs.
→ T14 must add an optional `runChild` strategy to `SpawnSubagentToolDeps`,
defaulting to today's `runAgentTurn` path. That is the same additive-optional
idiom the file already uses for `getSlateSession` and `onLedgerReady`, so it is
a small change — but it is a change that did not exist in the plan.

**2. `--tools` is a real allow-list, and it changes the containment design.**
Probed live: `--tools Read Grep Glob` → `system/init` reports exactly
`["Glob","Grep","Read"]`. Future tools are excluded by default. The reference
implementation's lesson was about `--allowed-tools`, a different flag which
genuinely does not restrict; 0.1.0 conflated them and specified a deny-list.
Ground truth for why this matters: with `--disallowed-tools Bash Edit Write
Task`, the probe was still offered **27** tools including `NotebookEdit` (a
write tool), `Monitor`, `Workflow`, `Skill`, `TaskCreate`/`TaskUpdate`/
`TaskStop`, `WebFetch`, `WebSearch`, `CronCreate`, `RemoteTrigger`,
`ScheduleWakeup` and `ToolSearch`.
→ Specification §5.3 rewritten; D-08 amended. The worktree remains the
guarantee — a roster governs which tools exist, not what `Read` can reach.

**3. `--safe-mode` is required and was missing.** Without it the probe emitted
`system/hook_started` / `system/hook_response`: the operator's `SessionStart`
hooks ran *inside the child*, and ~130 slash commands were loaded. With it, no
hook events and 46 built-ins. Critically it is **not** `--bare`, which forces
API-key auth and would defeat running on the subscription.

**4. `src/capability/` is an empty framework.** `CAPABILITY_REGISTRY`
(`registry.ts:23`) is `[]`; the only descriptor is
`REFERENCE_CAPABILITY_DESCRIPTOR`. This feature would be the registry's first
real entry, so T15 budgets for registering against the
`CapabilitySpec`/`CapabilityAdapter` seam, not for reading a flag.

**Bonus — the variadic-flag bug reproduced live.** A probe that placed the
prompt directly after `--mcp-config` failed with `MCP config file not found:
…/Rep` — the CLI consumed the prompt's first word as a path. This is exactly the
failure AC4 exists to prevent, now witnessed rather than inherited. The argv
uses `--session-id <uuid>` as the trailing single-valued separator rather than
`--model`, because the model is deliberately left unpinned while a session id is
always assigned.

**Event shapes captured** (codex 0.147.0, claude 2.1.220) and folded into
specification §6.2: codex emits `thread.started` carrying a `thread_id` it
generates itself (so the resume handle is *read*, not assigned, unlike claude's
`--session-id`), plus `turn.started`, and a richer `turn.completed.usage` than
assumed. claude's `system/init` is multi-KB because it enumerates the whole tool
roster and command list — the parser must not assume short lines.

Probe cost: ~$0.08 of subscription quota across four runs, all in a scratch
directory outside the repository.

## T5 fixtures — recorded, with four more corrections (2026-08-19)

Transcripts live in `fixtures/external/{codex-cli,claude-cli}/` with
`manifest.json` recording, per file, the CLI version, the exact argv, and
whether it was **captured** or **hand-authored**. Specification and
security-policy → 0.3.0.

**1. `--ephemeral` forbids resume — the spec contradicted itself.** 0.1.0's
codex argv carried `--ephemeral` while the registry promised `resumable: true`.
A resume of an ephemeral thread fails: `no rollout found for thread id …
(code -32600)` (kept as `resume-refused-ephemeral.stderr.txt`). Resume is what
makes operator messages (R18) and `force` (R20) work for codex, so `--ephemeral`
is dropped and runs leave a rollout in the operator's `CODEX_HOME` — the same
thing a hand-run `codex` does. Redirecting `CODEX_HOME` is not an escape:
`--ignore-user-config` documents that auth still resolves from it, so moving it
loses the subscription. **Judgement call made rather than escalated**, because
the alternative silently drops a requirement the operator asked for by name.

**2. `codex exec resume` has a narrower flag set than `codex exec`** — no
`-s/--sandbox`, no `-C/--cd`, no `--color`. So the sandbox level cannot be
re-asserted on resume (the worktree carries the containment, D-08), and the
resume process must be spawned with **cwd set to the worktree** rather than
pointed at it by flag.

**3. Retry events are non-terminal and arrive in bulk.** codex emits top-level
`{"type":"error","message":"Reconnecting… n/5 …"}` — the captured
no-credentials transcript has **ten**, with an `item.completed` in the middle,
before its single terminal `turn.failed`. claude emits `system/api_retry` —
**eight** before its terminal `result`. A classifier keying on the first error
event would report every transient hiccup as a dead run. Only `turn.failed` and
`result` are terminal; `result.subtype` (`success` vs `error_during_execution`)
is claude's discriminator, preferred over `is_error`.

**4. The claude login-refusal behaviour asserted in 0.1.0 does not reproduce.**
The borrowed claim was that a present `ANTHROPIC_API_KEY` makes the CLI answer
`Not logged in · Please run /login` on stdout with exit 0. On 2.1.220 a bogus
key initialises normally, burns eight retries, then ends
`error_during_execution`. The failure is *slow*, which is worse, so the rule to
strip `ANTHROPIC_*` stands — but it now rests on a fixture rather than an
anecdote.

**Captured** (real runs): codex success, error-word, resume, no-credentials,
bad-argv, ephemeral-resume refusal; claude success, resume, bad-credential,
bad-argv. The `error-word` fixture is the classifier trap made concrete — a
successful run whose message is literally `error: nothing is actually wrong`,
exit 0, terminal event present. Both resumes were verified to retain context:
each recalled its own prior answer.

**Hand-authored, and named so**: `usage-limit.SYNTHETIC.jsonl` for both agents.
A quota exhaustion cannot be provoked on demand. The codex wording is
second-hand from a reference implementation's source comment about an older
version; the claude one is built around the real `rate_limit_event` type plus a
plausible terminal `result`. **AC6's limit case is provisional** until a real
exhaustion is captured, and `manifest.json` says so in the file itself.

**Gaps recorded rather than papered over**, in `manifest.json`: no `empty
output` fixture (neither CLI produced one under any prompt tried), both limit
fixtures synthetic, and no multi-turn run with tool calls — so tool-call event
shapes remain modelled rather than recorded.

Cost: ~$0.15 of subscription quota across seven runs.
- 2026-08-19T18:03:33.662Z - frozen: 17 criteria; checksum recorded
- 2026-08-19T18:03:33.876Z - started
- 2026-08-19T18:10:59.027Z - task-done: T1: Collect remaining context
- 2026-08-19T18:23:01.828Z - task-done: T5: Record JSONL fixtures for codex-cli and claude-cli (success, not-logged-in, limit, bad argv, empty, resume, error-word)
