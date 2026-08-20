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

## T6 + T7 — foundations and contract (2026-08-19)

`src/harness/external/`: `types.ts` (codec port, canonical events, registry
entry shape), `registry.ts` (both agents as data, version parse/compare/judge,
availability with `not-probed` as a first-class state), `env.ts` (copy-then-strip
child environment, depth marker, entry-side nesting guard), `dispatch.ts` (the
`runtime` block and its fail-closed validator). 67 tests, all pure — no process,
no filesystem, no clock — so the whole layer runs on a machine with neither CLI
installed. `bun run typecheck` clean.

Refusal reasons carry a `code`, so the two look-alike refusals stay
distinguishable: `agent-cannot` ("this CLI does not support that sandbox") versus
`not-implemented` ("keryx does not do that yet"). Collapsing them into one string
is how an operator debugs the wrong thing. Order is fixed — identity, then
capability, then release gate, then consistency — so a refusal always names the
narrowest true reason.

`run-command` is deliberately NOT in `READ_ONLY_FORBIDDEN_ACTIONS`: an external
CLI necessarily runs commands inside its own sandbox, so rejecting the action
would refuse every dispatch. That axis belongs to the sandbox flag and the
worktree.

### The schema lives in two places, and only one is canonical

The `runtime` block was first added to
`.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json` — and the
validator kept rejecting it. The canonical file is
`src/gdskills/contracts/subagent-dispatch.schema.json`; the `.metaproject/` copy
is an export. Both now carry identical content.

Even after fixing that, `keryx skills contracts validate` still rejected the
block. **The memory constraint `stale-installed-keryx-binary` reproduced
exactly**: the `keryx` on PATH is an old build carrying its own bundled schema.
Running `bun src/cli.ts skills contracts validate` gives the right answers —
legacy dispatch without a `runtime` block valid (backward compatibility holds),
dispatch with the block valid, and a bad `sandbox` enum rejected as
`$.runtime.sandbox: Expected one of read-only, worktree-write`. Any verification
of this flow must use a locally built binary or it proves nothing.

### The suite has order-dependent tests — recorded, not swallowed

Full-suite runs with these changes present gave **2 fail, then 1 fail, then 0
fail** across three consecutive runs of identical code. The two tests involved:

- `spawn-subagent-child-slate.test.ts` — "F-001: a slate_write_seed write that
  arrives after timeout-driven cleanup begins must NOT resurrect the deleted
  ephemeral dir". It scans `tmpdir()` for leaked directories matching
  `slate`/`subagent` and found `keryx-catchup-corrupt-slate-…`, which a
  *different* file's catchup test creates.
- `src/harness/resume` — "same-size historical receipt corruption invalidates the
  checkpoint and refuses append".

Both pass in isolation. The three new test files here are entirely pure — no
filesystem, no tmpdir, no process — so they cannot produce a leaked
`keryx-catchup-corrupt-slate-*` directory; what they change is the file count
(406 → 409) and therefore bun's concurrent scheduling. The conclusion is latent
cross-file interference revealed by a perturbed schedule, not a regression.

Worth stating plainly for whoever verifies this branch: **a single red full-suite
run is not evidence of breakage here, and a single green baseline run was not
evidence of a clean baseline.** Fixing those two tests is out of scope for this
flow and belongs to whoever owns the slate and resume suites.

## T8 + T9 — the two codecs, written in parallel (2026-08-19)

Both were implemented by subagents dispatched concurrently, each against the
recorded fixtures and each forbidden from touching shared files. 163 tests in
`src/harness/external/`, typecheck clean. Their claims were re-verified here
rather than taken on trust.

### The find that justified the whole exercise

The claude agent reported honestly that **`--input-format stream-json` had never
been exercised** — every captured fixture came from a run without it. A live
probe settled it, and the answer is bad: `claude -p` with
`--input-format stream-json` **and** a positional prompt **ignores the prompt,
waits on stdin, and with stdin closed exits 0 having written zero bytes to both
streams.** No error, no transcript, every process-level signal reporting
success.

Specification 0.1.0 through 0.3.0 all prescribed exactly that argv, and the
shipped codec inherited it. Had this reached T14 the runtime would have launched
external children that did nothing while reporting success.

Fixed by splitting into two shapes: `buildClaudeArgv` (one-shot, positional
prompt, no `--input-format`) and `buildClaudeStreamingArgv` (steerable, no
positional prompt, prompt and later messages fed to stdin via
`encodeClaudeStdinMessage`). A second probe confirmed the streaming shape works
end to end. **Operational consequence: steerability is now a spawn-time
decision** — a one-shot run can never be sent a message afterwards, because the
flag that accepts one forbids the prompt that started it. Specification §5.2 and
§7.5 rewritten; spec → 0.4.0.

Two probe outputs became fixtures, including the zero-byte one — kept
deliberately, because it is the hardest failure to detect and the only signal is
the absence of a terminal event. That also closes the `empty output` gap the
manifest previously listed.

### Other corrections the agents surfaced

- **codex's `-s` vocabulary is not ours.** It accepts
  `read-only | workspace-write | danger-full-access`; `worktree-write` would be
  rejected with `error: invalid value`. Independently confirmed against
  `codex exec --help`. The codec translates. Dormant while only read-only is
  implemented, a latent command-line failure the moment it is not.
- **`--add-dir` is variadic too** (`--add-dir <directories...>`), and the
  ordering rule in §5.2 named only three flags.
- **`buildResumeArgv` arity** disagreed between spec (2 params) and `types.ts`
  (3). Spec corrected to match the code.
- **`num_turns` has no canonical home.** R26 wants turn count in the TUI but the
  `usage` event carries only tokens and cost. Flagged in §6.2 rather than
  quietly dropped.
- **`rate_limit_event` appears on healthy runs**, so folding it to `retry` would
  inflate the drift signal. The claude codec distinguishes
  recognised-but-unmapped from did-not-parse so the parse-skip counter stays
  meaningful.
- **My own manifest bug**: the codex entry named `not-logged-in.stdout.txt`
  while the file on disk is `.jsonl`, from my rename during T5.

### Judgement calls the agents made and defended

`parseLine` returns the terminal event where a line folds to two, because
returning `usage` instead would make every successful run classify as
"transcript ended without a terminal event" — a reporting gap traded against a
wrong verdict on every run. Success short-circuits before any failure pattern
runs, so a run that hit 401 retries and recovered is not retroactively failed.
codex's classifier admits structured event messages as well as filtered stream
lines, because its 401s live inside JSONL objects that the `^error|usage:` line
filter would never see. `assistant_text` is never admitted as evidence — that is
the `error-word` trap.

### Still unverified

Tool-call, tool-result and thinking event shapes are modelled from the vendors'
block schemas; no captured fixture exercises a multi-turn run. Both usage-limit
fixtures remain hand-authored. The codecs are not yet wired to anything — there
is no `codec/index.ts` and the registry does not reference them, which is T14's
work.

## T14 — the runtime, the real process port, and the seam (2026-08-19)

Two independent pieces went to parallel subagents (`supervise.ts` + `codec/index.ts`;
`prompt.ts`), and the orchestration, the real spawn port and the tool seam were
written here. **Full suite: 4593 pass, 0 fail. Typecheck clean.**

**`runtime.ts`** composes the whole run in a fixed, cheapest-first order —
capability gate, nesting depth, contract validation, codec resolution, version
probe, prompt assembly, worktree, spawn, classify, cleanup. The worktree is
created last among the setup steps and removed in a `finally`, so no path leaves
one behind, including a spawn port that throws; a leaked worktree is a leaked
escape hatch, because containment rests on that directory being disposable.

**`bun-spawn-port.ts`** is the real `ExternalSpawnPort` and was missing from the
plan entirely — the supervisor's port had no production implementation, so
nothing could actually run. It owns exactly three things the supervisor must
not: process creation, line framing, stream teardown. Framing lives here because
claude's `system/init` spans read chunks by construction, and a multi-byte
character split across chunks would corrupt the JSON; both cases are tested.

**The tool seam** is an optional `runExternal` dep on `SpawnSubagentToolDeps`,
invoked **after** `spawnSubagent` so admission, the shared ledger and the
depth/child caps have already applied — an external child is gated identically to
a native one, which is the substance of AC17. The hook's type is deliberately
structural (`unknown` in, `StructuredSubagentResult` out) so
`spawn-subagent-tool.ts` needs no import from `src/harness/external/` at all.
Seven tests pin that the seam is **inert** without the hook: a runtime block with
no hook, a hook with no block, a malformed block, and a `keryx` block all fall
straight through to the native path unchanged.

### Judgement calls made here

- **The status vocabulary is mapped structurally where possible and by text
  where the port leaves no choice.** `timedOut` is a fact supervision knows;
  `cause === null` is Completed; the rest infers Denied-vs-Error from markers in
  a free-text cause. This is a **known weakness, documented at the marker list**:
  the right fix is for `classifyFailure` to return `{code, message}`, which is a
  port change and a later task. Matching only runs on already-failed runs, so a
  false positive costs a mislabelled status, never a wrong verdict on a healthy
  run.
- **`ledger.release(..., {maxToolCalls: 0})`** for external children: they spend
  the vendor's own tool budget, not this ledger's, and their cost is accounted in
  the run's reported usage instead.
- **A throwing hook returns `Error`, not an agent report.** A broken keryx seam
  must never be presented as something the vendor said.
- Added `isRecognisedCodexLine` to the codex codec, closing the gap the
  supervision agent flagged: without it a healthy codex run scored a phantom
  parse-skip for its unmapped `turn.started`, permanently polluting the
  version-drift signal.

### What T14 does NOT deliver

**No host wires `runExternal` yet.** The seam exists, is tested and is inert; the
closure that supplies it — capability descriptor, config shape, transport/CI hard
disable, `keryx agents external list|probe` — is T15, and building it there means
one change to the critical file instead of two. Nothing external can run until
then, which is the correct default given R14.

The `spawn_subagent` tool's own parameter schema does not yet declare `runtime`,
so a model cannot request an external child; only a programmatic dispatch can.
Also T15.

The real spawn port has never been pointed at a real process. Its framing and
stdin discipline are tested against a substituted `Bun.spawn`, but the
wrapper-holds-the-pipes scenario the kill race exists for is simulated, not
reproduced.

## T15 + T16 — gate, CLI surface, operator surface (2026-08-19)

Both by parallel subagents, with the call-site wiring kept back to this session
so they could not collide. **Full suite 4728 pass / 0 fail, typecheck clean.**

Verified behaviourally, not only by tests. `bun src/cli.ts agents external list`
reports `capability: unavailable` with a named reason by default, renders every
entry as `not probed`, and where a probe ran says *"installed, 0.147.0 (within
the recorded range); login not verified — keryx cannot know"*. Never a tick. The
footer states the credential boundary outright.

### Decisions worth keeping

- **There was no transport marker anywhere in `src/`.** `CHANNEL_SOURCE` exists
  only in this package's brainstorm as a borrowed anecdote, and `keryx serve`
  distinguishes callers per request, not per process. So `KERYX_TRANSPORT` was
  defined, with **unknown values reading as remote** — an unrecognised marker
  fails toward refusal. `KERYX_` is already swept by `buildExternalChildEnv`, so
  a child cannot inherit it.
- **A CI variable set to `false` is not CI.** Local tooling really does export it.
- **The manifest is not a veto, and the first reading of it was wrong.**
  `reconcileCapabilitiesOnUpdate` materialises a newly-registered ceiling as
  `enabled:false` on every `keryx update`, so a veto reading would have silently
  switched the feature off under every workspace that had ever run update.
  Corrected: no manifest → neutral; manifest present → must be enabled.
- **`spawnDecision: "ask"` with no approver is fail-closed**, which is the
  shipped default: a host that cannot ask must not self-approve. Consequence to
  be aware of — until an approver is wired or the operator sets `"allow"`, every
  model-initiated external spawn is Denied by design.
- **`force` never prefers stdin even where stdin exists.** Writing there queues
  the message behind the turn already in flight, which is precisely what the
  operator asked not to happen. So force is kill+resume, or an honest
  `kill-only` when there is nothing to resume.
- **`user_message` is emitted on delivery, not on queueing** — otherwise the
  parent's folded view would report the child received something it never did.
- **Turn count is derived from the transcript and labelled as such**, since §6.2
  established `num_turns` has no canonical home.

### Gaps closed here after their reports

- The factory now forwards `onSpawned`. Without it the operator surface could
  compute a delivery intent and a supervision kill but execute neither, because
  both happen while the run is still in flight.
- `ExternalChildOutcome` now carries `worktreePath`. It was being taken from the
  port and kept internal, so the Meta view's Worktree row could only ever render
  empty.
- `createLazyRunExternal` resolves the gate on first use, so a synchronously
  constructed tool needs no startup restructuring for a feature that is off by
  default. Wired at the single `createSpawnSubagentTool` construction site in
  `shell.ts`, which serves both the readline and TUI paths.

### What is NOT operable yet — stated plainly

The feature is installable, inspectable and gated, but **not yet drivable from
the TUI**:

1. **No `/delegate` command.** R25 wants both the operator and the parent to be
   able to start an external run; only the parent path exists.
2. **The live steering loop is not connected.** The TUI computes delivery
   intents and the handle is now forwarded, but nothing joins the two inside
   `tui-shell.ts`.
3. **External children are not marked in the subagent sidebar** (§8.2). Their
   record shape differs from `SubagentSession`, and adapting it needs a decision
   about the sidebar's contract rather than a guess.
4. **No approver is wired**, so the shipped `ask` default denies every
   model-initiated spawn.
5. **The real spawn port has still never been pointed at a real process.**

Items 1–4 are one more integration task; item 5 is a live smoke test that costs
subscription quota. Neither is T17 (docs), so the flow needs a task for them.

## T18 — the operator loop (2026-08-19)

By subagent, with the follow-up fixes here. External subsystem + TUI: **687
tests, 0 fail.** Typecheck clean. Full suite varies 0–2 failures across runs,
always the same pre-existing order-dependent test (`same-size historical receipt
corruption…`, which passes 29/29 in isolation) — characterised at T6/T7 and not
this work.

Delivered: the live steering loop joined through a new module-level bridge and
an `ExternalOperator`; an approver reusing the shell's existing composer-choice
prompt; `/delegate <agent> <task>`; and an optional `runtime: "external"`
discriminator marking external children in the existing sidebar rather than a
parallel one. Changes to `tui-shell.ts` are nine small blocks, each justified in
the agent's report by something that exists only in that scope.

### The bug it found in my code, and the fix

**The stdin route was unreachable.** `runtime.ts` called `superviseExternalRun`
with no `stdin` field, so it defaulted to `"ignore"`; no run was ever launched
steerable, `writeStdin` always returned false, and every operator message routed
to resume. AC10's stdin half could not be satisfied end to end — and the agent
reported it loudly instead of quietly routing around it, which is exactly right.

Fixed properly rather than by special-casing: `ExternalAgentCodec` gains optional
`buildStreamingArgv` / `encodeStdinMessage`, present exactly on the codec whose
registry entry declares `streamingInput: true`. `RunExternalChildInput` gains
`steerable`, the factory forwards it, and the shell sets it — it renders the
transcript and offers a queue, so it pays for the open pipe. Asking for steerable
on codex degrades to one-shot silently, which is correct: that CLI has no mid-run
input channel at all. Five new tests pin both shapes, including that stdin is
never inherited in either.

### Two spec deviations recorded rather than papered over

- **R25 amended (prd 0.4.0).** `/delegate` does not pass `decide()`. Routing it
  there would ask the operator to approve their own explicit command, and the
  TUI has no tool-invocation path to do it through. The operator path keeps every
  other control — capability, per-agent enable, depth ceiling, worktree — and the
  accepted consequence is that it also bypasses the MAE admission ledger, so an
  operator-initiated run is not counted against the per-turn child budget.
- **R15 is UNMET (specification 0.4.1).** None of §7.6's five supervision
  triggers exists; the folded view has no consumer, so the parent receives an
  external child's result and nothing before it. The seam is there — the
  supervisor emits events live and the operator surface already consumes them —
  so this is an unbuilt consumer, not a missing mechanism. Marked inline because
  that section otherwise reads as shipped behaviour.

### Other honest gaps from the report

`user_message` reaches the store's stream, not `ExternalChildOutcome.events` (the
supervisor's array is internal and cannot be injected mid-run). Resume argv is
built and surfaced in the Command tab but never spawned — and note the deeper
reason: the disposable worktree is removed the instant the run ends, so there is
nothing left to resume *into* from the shell. A run refused at the gate leaves no
store record, because the closure never runs; the refusal still reaches the
operator through `/delegate`'s printed line and the failed sidebar row.

Nothing has been rendered on a real terminal, and no vendor process has been
spawned. That is T19.

## T17 — documentation, and the bug it exposed (2026-08-19)

User-facing docs by subagent (`README.md`, `harness.md`, `cli-reference.md`,
`modules.md`, `architecture.md`); the requirements package corrected here,
because a status line is exactly where a reader stops and overclaiming there is
the failure mode the docpack rules exist to prevent.

### The package said things that had become false

- **Status.** `specification ready (future) — nothing below is implemented` was
  a flat untruth. Now `implemented (read-only release), never run against a real
  process`, followed immediately by the three things that does *not* mean.
- **Storage structure** listed nine modules; seventeen were built. `dispatch.ts`,
  `bun-spawn-port.ts`, `codec/index.ts` and the whole TUI layer were missing.
- **The seam's name.** The spec promised `runChild`; it shipped as `runExternal`.
  Small, and exactly the kind of drift that makes a document stop being checkable.
- **The capability paragraph** still explained that the registry was empty and
  that T15 should budget for populating it. Replaced with how the three-layer
  gate actually behaves, including that `reconcileCapabilitiesOnUpdate` will
  write a disabled entry into every workspace's manifest on the next update.
- **R15 marked UNMET in three places** — README status, specification §7.6 and
  agent-protocol §4. That whole section describes behaviour that does not exist,
  and unmarked it reads as description of behaviour that does.

### The docs agent found a real bug by refusing to write what it was told

The brief stated that claude runs are launched steerable and take operator
messages on stdin. The agent verified instead of transcribing, found that
`ExternalOperator` hard-coded `launchedStreaming: false`, and documented the
feature as unreachable — flagging it as a code fix, not a doc fix.

It was right. `shell.ts` set `steerable: true` and `runtime.ts` piped stdin, but
the operator never learned that, so `planExternalDelivery`'s
`streamingInput && launchedStreaming && running` was never satisfied and **every
operator message took the resume path, including for claude**. The stdin route
existed in the codec, the runtime and the delivery executor, and was unreachable
end to end.

Fixed by making the fact travel rather than be guessed: `ExternalRunHandle` now
carries `streaming`, set by the supervisor from the stdin mode it actually used,
and the operator reads it on `spawned`. Two regression tests pin both
directions. The test fakes carry the field too — a fake that always claimed
streaming would have hidden precisely this.

That is three times in this flow a subagent's honesty caught something a
confident report would have buried: the `--input-format` silent no-op, the
missing `onSpawned` forwarding, and now this.

### Also fixed

`keryx init --external-agents` was absent from `init --help`, while the
capability's own refusal message tells the operator to run exactly that. A flag
nothing documents is a dead end, so it is listed now.

### State

Full suite 4788 pass, 1 fail — the same pre-existing order-dependent
`same-size historical receipt corruption…`, confirmed again by name and passing
in isolation. Typecheck clean. Roadmap → 0.16.0.

## T19 — the live smoke, and the three bugs only it could find (2026-08-20)

The real spawn port and the real git worktree port pointed at the real CLIs,
through the whole runtime. Three cases: codex one-shot, claude one-shot, claude
steerable. **All three Completed.** Kept as `scripts/smoke/external-agents.ts`,
deliberately outside `bun test` because it spends subscription quota — and
deliberately kept, because the whole design rests on vendor CLI behaviour that
drifts and no offline test can see a drift.

Everything before this was verified against recorded transcripts with a fake
process port. That verification was real, and it was also not the same thing as
running the binary. The first live run proved the difference three times over.

**1. `"ok\nok"` — every claude answer was duplicated.** `collectAssistantText`
appended the terminal event's text to the assistant stream, and claude's
`result.result` repeats what its `assistant` blocks already carried. A one-word
reply exposed it; a real report would have been silently doubled. Fixed by
letting a terminal event's text *win outright* rather than append, with the
stream as the fallback — correct for codex too, whose terminal event carries no
text at all, and without branching on the agent.

**2. Every healthy run scored a phantom parse-skip.** Both codecs had a line
recogniser; the runtime never passed it to the supervisor. So the version-drift
counter read 1 at rest — for codex's unmapped `turn.started` and claude's
`rate_limit_event`, which appears on *successful* runs. A drift signal that is
noise at rest is not a signal. Now 0 for both, so a genuine schema change will
actually stand out.

**3. Cost was structurally unreportable.** The supervisor called only the
singular `parseLine`, which on a terminal line returns the terminal event and
drops the `usage` beside it. Both codecs already had a plural parse; nothing
used it. So R26's cost reporting could never have worked, and the smoke showed
`cost: MISSING` for the agent whose registry entry says `reportsCost: true` and
whose transcripts carry `total_cost_usd`. Added `parseEvents?` to the port, wired
both codecs, and the supervisor prefers it. Now `$0.0296` for claude and still
`MISSING` for codex — which is right, since codex reports no monetary cost at
all and a missing figure must stay missing rather than become zero.

Four supervisor tests had pinned the event sequence without `usage`; those
expectations were the bug's fingerprint, not the fix's cost, and are updated
with a comment saying why.

All three now have offline regression tests, so the fixes do not depend on
anyone re-running a paid smoke to stay fixed.

**Containment held.** The repository working tree was byte-unchanged across every
run and no smoke worktree remained registered — the guarantee D-08 rests on,
observed rather than asserted for the first time.

Full suite 4794 pass, 0 fail. Typecheck clean.

## Acceptance criteria — 14 of 17 confirmed, 3 deliberately not (2026-08-20)

Each confirmation carries the specific evidence rather than a tick. The three
left unconfirmed were checked before deciding, and confirming them would have
been the one thing this flow spent itself avoiding.

**AC5 — half unmet.** The codecs parse every recorded fixture into the canonical
event sequence, and that half is solid. The other half — "and `reduceAgents`
folds that sequence without modification" — is **not demonstrated by anything**.
`ExternalEvent` and `reduce.ts`'s `AgentEvent` are different types and nothing
bridges them. Two module headers claim the fold works unchanged; that claim is
aspirational and should be either implemented or removed from the comments.

**AC12 — unmet.** Supervision triggers do not exist (R15). Already marked in
specification §7.6, agent-protocol §4 and the package README.

**AC13 — unmet, and the reason is upstream of the criterion.** `resultSchemaPath`
is set only in tests: the runtime never passes it, so no structured result is
ever requested, so R22's validation against `subagent-result` never runs and
"a schema-invalid result yields Error" has nothing to fire on. The codecs *build*
the flag correctly (`--output-schema` / `--json-schema`); nothing asks them to.

**AC8 confirmed with a stated limit**: worktree removal is tested on every path
including a throwing port, and working-tree containment was observed live across
three real runs. No transcript "containing write attempts" was used, because a
fake port cannot write and the assertion would be theatre — the guarantee rests
on the disposable worktree, and that is what was tested.

**AC6 confirmed with a stated limit**: the usage-limit fixtures are hand-authored
and marked SYNTHETIC. A real quota exhaustion has never been captured, so that
one branch pins our mapping rather than the vendor's wording.

T2 and T3 (the scaffold's generic "implement per plan" / "add tests") are closed
as skipped: the work happened in T5–T19, which carry the evidence.

**The flow cannot legitimately complete.** Completion requires every AC
confirmed, and three are not. That is the correct state, not an obstacle to route
around: the feature is genuinely useful and genuinely incomplete in three named
places.
- 2026-08-19T18:03:33.662Z - frozen: 17 criteria; checksum recorded
- 2026-08-19T18:03:33.876Z - started
- 2026-08-19T18:10:59.027Z - task-done: T1: Collect remaining context
- 2026-08-19T18:23:01.828Z - task-done: T5: Record JSONL fixtures for codex-cli and claude-cli (success, not-logged-in, limit, bad argv, empty, resume, error-word)
- 2026-08-19T18:40:45.295Z - task-done: T6: Foundations: external/types.ts codec port, registry.ts with both entries, env.ts deny lists and prefix sweeps
- 2026-08-19T18:40:45.501Z - task-done: T7: Contract: runtime block on subagent-dispatch schema + pure validator (agent, sandboxModes, read-only vs allowed_actions, worktree-write refusal)
- 2026-08-19T18:58:40.781Z - task-done: T8: Codec codex-cli: argv, JSONL parser, failure classifier (subtract prompt, error/usage lines only), resume argv
- 2026-08-19T18:58:40.973Z - task-done: T9: Codec claude-cli: argv, stream-json parser, failure classifier (login refusal on stdout with exit 0), resume argv
- 2026-08-19T19:22:47.094Z - task-done: T14: Runtime: supervise.ts process lifecycle + raced kill, runtime.ts spawnChild integration, worktree lifecycle, ledger, result validation
- 2026-08-19T19:59:49.539Z - task-done: T15: Capability gate, config shape, remote/CI hard disable, keryx agents external list|probe
- 2026-08-19T19:59:49.748Z - task-done: T16: TUI: external session kind, modal tabs Work/Meta/Command, per-addressee queue on generalised main-queue helpers, force as kill+resume
- 2026-08-19T20:00:18.919Z - task-added: T18: Operator loop: /delegate command, live steering (join onSpawned handle to the addressee queue), external marker in the subagent sidebar, approver for spawnDecision=ask
- 2026-08-19T20:00:19.138Z - task-added: T19: Live smoke: point the real spawn port at a real codex and claude run end to end (spends subscription quota)
- 2026-08-19T20:56:15.331Z - task-done: T18: Operator loop: /delegate command, live steering (join onSpawned handle to the addressee queue), external marker in the subagent sidebar, approver for spawnDecision=ask
- 2026-08-19T21:16:52.869Z - task-done: T17: Docs: README and docs site updated alongside the code; package status moved off spec-ready only for what shipped
- 2026-08-20T05:11:54.601Z - task-done: T19: Live smoke: point the real spawn port at a real codex and claude run end to end (spends subscription quota)
- 2026-08-20T05:25:46.551Z - ac-confirmed: AC1: dispatch.test.ts + registry.test.ts: unknown agent -> unknown-agent; sandbox absent from sandboxModes -> agent-cannot, exercised against a synthetic entry since both shipped entries declare both modes. Pure, offline.
- 2026-08-20T05:25:46.638Z - ac-confirmed: AC2: dispatch.test.ts: read-only rejected for write/network/spawn-subagent, each named in the reason; run-command alone accepted, since an external CLI necessarily runs commands in its own sandbox.
- 2026-08-20T05:25:46.723Z - ac-confirmed: AC3: dispatch.test.ts: worktree-write passes schema and sandboxModes, then refused with code not-implemented — asserted distinct from AC1's unknown-agent code.
- 2026-08-20T05:25:46.808Z - ac-confirmed: AC4: codex-cli.test.ts + claude-cli.test.ts: argv asserted element-by-element across every optional-field combination, incl. that no prompt follows a variadic flag and that --input-format never accompanies a positional prompt.
- 2026-08-20T05:25:46.894Z - ac-confirmed: AC6: codex-cli.test.ts + claude-cli.test.ts against recorded fixtures: not-logged-in (claude exit 0 via result.subtype), bad argv, empty output, and the error-word trap (successful run whose message begins 'error:'). LIMIT CASE PROVISIONAL: usage-limit fixtures are hand-authored and marked SYNTHETIC in the manifest; a real exhaustion has never been captured.
- 2026-08-20T05:25:58.058Z - ac-confirmed: AC7: env.test.ts: every named denial and both prefix sweeps removed from a synthetic parent env; depth marker added AFTER the KERYX_ sweep so the sweep cannot eat it; parent env not mutated.
- 2026-08-20T05:25:58.149Z - ac-confirmed: AC8: runtime.test.ts: worktree removed after success, after failure, when the spawn port throws, and a failing remove does not mask the result. Working-tree containment OBSERVED LIVE in scripts/smoke/external-agents.ts across three real runs (byte-unchanged, no worktree leaked). Caveat: no fixture transcript specifically containing write attempts was used — a fake port cannot write, so the assertion would be theatre; the guarantee rests on the disposable worktree, which is what was tested.
- 2026-08-20T05:25:58.239Z - ac-confirmed: AC9: external-agents.test.ts + runtime.test.ts: capability disabled, remote transport and CI each refuse with a named reason and create no process; verified behaviourally via bun src/cli.ts agents external list under CI=true and KERYX_TRANSPORT=remote.
- 2026-08-20T05:25:58.324Z - ac-confirmed: AC10: external-operator.test.ts: user_message emitted on DELIVERY not queueing; streaming handle -> stdin write; non-streaming -> resume argv. The stdin route was unreachable until T17 (launchedStreaming was hardcoded false) and is now pinned in both directions; proven end to end against a real claude run in the T19 smoke.
- 2026-08-20T05:25:58.409Z - ac-confirmed: AC11: external-delivery.test.ts + external-operator.test.ts: force builds the resume argv carrying the session handle and the message BEFORE killing, and degrades to kill-only with lost:true when no handle was ever announced.
- 2026-08-20T05:26:07.715Z - ac-confirmed: AC14: runtime.test.ts: a failing agent returns its own named status and exactly one process is created — nothing is retried with another agent, runtime or the parent's model. decisions.md D-07.
- 2026-08-20T05:26:07.800Z - ac-confirmed: AC15: package.json dependencies unchanged across the whole flow; @opentui/core remains the pre-existing optional dependency and the TUI modules degrade without it.
- 2026-08-20T05:26:07.886Z - ac-confirmed: AC16: fixtures/external/{codex-cli,claude-cli}/ with manifest.json naming, per file, the CLI version, the exact argv, and captured-vs-hand-authored. Captured: success, resume, no-credentials, bad-argv, error-word, ephemeral-resume refusal, streaming-input, empty-output. Hand-authored and marked SYNTHETIC: both usage-limit files.
- 2026-08-20T05:26:07.971Z - ac-confirmed: AC17: spawn-subagent-external-seam.test.ts: the hook is invoked AFTER spawnSubagent, so admission, the shared ledger and the depth/child caps have already applied; seven tests pin that the seam is inert without it. No second spawn path, ledger, depth accounting or event stream exists — verified by review of src/harness/child/ and by the tool holding no import from src/harness/external/.
- 2026-08-20T05:26:16.075Z - task-done: T2: Implement per plan
- 2026-08-20T05:26:16.162Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-20T05:27:53.565Z - task-done: T4: Self-review and prepare draft PR
