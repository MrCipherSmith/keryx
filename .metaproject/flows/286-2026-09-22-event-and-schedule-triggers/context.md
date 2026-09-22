# Context

Collected deterministically by `keryx flow init` at 2026-09-22T18:18:39.356Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.948] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
2. [1.847] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.823] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
4. [1.8] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.719] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-21T08:21:59.610Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

### T5 — survey: what already fires, and where triggers should live

**What already runs without a person present, today:**

- `keryx sync install-hooks` / `uninstall-hooks` — `src/commands/sync.ts:18-31` wires the
  subcommand; the actual hook writer is `src/sync/hooks.ts`. `installSyncHooks`
  (`src/sync/hooks.ts:80-86`) writes a managed block into `post-merge` and `post-checkout`
  (`SYNC_HOOKS`, `src/sync/hooks.ts:14`) under a single block id `"keryx-sync"`
  (`src/sync/hooks.ts:13`). The hook body it writes (`hookBody`, `src/sync/hooks.ts:20-37`)
  just runs `keryx sync` (advisory, non-blocking, exit ignored: `keryx sync 2>/dev/null || true`,
  `src/sync/hooks.ts:33`) — it never runs `--apply`, so a pull/checkout only REPORTS drift; the
  operator still runs `keryx sync --apply` by hand to reconcile graph/wiki/memory
  (`src/commands/sync.ts:6-11`, header comment). Managed-block discipline: `writeManagedHook`
  (`src/sync/hooks.ts:39-58`) regex-replaces only its own `# keryx:keryx-sync:begin/end` block
  and preserves everything else already in the hook file, and `stripManagedHook`
  (`src/sync/hooks.ts:60-78`) removes only that block on uninstall.

- The **post-commit** hook that rebuilds the graph is a *different*, more general mechanism:
  `installManagedHook(projectRoot, hookName, blockId, content)` in `src/commands/update.ts:1449-1482`
  (mirrored in `src/commands/init.ts:1510`) writes MULTIPLE independently-named managed blocks
  into the SAME `post-commit` file — one call per module: `gdgraph-post-commit`
  (`src/commands/update.ts:466`, runs `keryx gdgraph build` when graph-relevant files changed —
  see `src/lib/templates.ts:1974-1977`), `gdwiki-post-commit` (`update.ts:482`),
  `gdskills-post-commit` (`update.ts:498`), `health-post-commit` (`update.ts:508`), and others.
  Each block is delimited by its own `# keryx:<blockId>:begin/end` markers
  (`src/commands/update.ts:1463-1465`) and a regex-replace using the **function form** of
  `String.replace` (`() => managedBlock`, not the string form) specifically because these hook
  bodies are shell scripts full of `$`, and the string-replace special sequences (`$'`, `` $` ``)
  would otherwise splice/duplicate blocks (`src/commands/update.ts:1470-1478`, comment explains
  a real bug this fixed). `removeManagedHook` (`src/commands/update.ts:1487-1512`) is the
  matching per-block uninstaller. **This is the pattern T9 (`keryx trigger install`) should
  reuse**, not `src/sync/hooks.ts`'s narrower one: it already proves "extend, don't replace" —
  a hook file with N independently-managed blocks, any one of which can be added/updated/removed
  without touching the others — which is exactly AC5's requirement.

- **Background tasks / `keryx serve`**: `src/commands/serve.ts:1-32` — the loopback-bound HTTP
  door (flow 128/roadmap R4b). `keryx serve` starts a listener (`startServeListener`,
  `src/lib/serve-server.ts`) that stays up and accepts turns via `assembleSubmitTurn`
  (`src/lib/serve-runner.ts`); `keryx serve status`/`token issue|rotate|revoke`/`config
  init|set|show` manage it. This is the closest thing keryx has to a long-lived daemon today,
  and it is explicitly loopback-only / not a public endpoint. Background AGENT tasks (as opposed
  to the serve HTTP door) live under `src/harness/tool/builtin/background-job-registry.ts` — a
  registry for tasks a running agent spawned into the background (`shell_exec` background jobs,
  etc.), not a scheduler; nothing here fires unprompted.

- **The agent bus** (`src/bus/`): `src/bus/schema.ts`, `paths.ts`, `enabled.ts`, `send.ts`,
  `inbox.ts`, `leases.ts`, `presence.ts` etc. implement a file-backed pub/sub + presence +
  pause-lease system for coordinating multiple already-running keryx agent instances (parent/child
  spawns, peer notification — `src/bus/peer-notification.ts`). It assumes participants that are
  already live processes with an identity (`BusClient`, instance ids, presence heartbeats). A
  triggered run from cron/CI is a **cold start** — no existing bus identity, no peer to notify
  yet, and firing outside of any agent conversation. Decision (see below): a triggered run should
  be a **plain CLI invocation** (`keryx trigger run <name>`), not a bus participant. It MAY emit a
  bus event afterward (e.g. to notify a running interactive session that a trigger fired) but
  that is an enhancement for T7/T11, not a requirement — the bus is not the entry point.

- **Existing locking** (what stops two keryx processes from corrupting shared state today):
  `withFileLock` in `src/lib/fs.ts:76-148` is the one primitive — `mkdir(lockPath)` as the atomic
  acquire, an `owner.json` sidecar (`{pid, token}`) written with `wx` flag, a heartbeat
  (`utimes`) while held, and stale-lock reclaim keyed off `DEFAULT_LOCK_STALE_MS = 30000`
  (`src/lib/fs.ts:74`) + liveness-check of the recorded owner pid (`isLockHeld`,
  `src/lib/fs.ts:163-172`). It is used for: the session store (`slate.json.lock` —
  `src/session/slate.ts`, `src/session/external-slate.ts`), flow state
  (`withFileLock(flowLockPath(cwd, dir), ...)` — `src/flow/service.ts:128,176,585`), SAC
  workspaces (`src/sac/workspace-service.ts:121,209`), SAC proposals
  (`src/sac/proposal-evidence.ts:264,271,320`), and the routing-entrypoint installer
  (`src/lib/routing-entrypoint.ts:124`, `.routing-entrypoint.lock`). **Gap found: `src/gdgraph/`
  and `src/wiki/` themselves have NO `withFileLock`/lock-path usage at all** (`keryx ctx rg
  "withFileLock|lockPath" src/gdgraph src/wiki` → 0 matches). Graph/wiki artifact writes rely on
  `writeFileAtomic` (`src/lib/fs.ts:46-66`, temp-file + rename) for not being torn mid-write, but
  nothing today SERIALIZES two concurrent `keryx sync --apply` / `keryx gdgraph build` runs
  against each other — two such runs racing could each read the same stale provenance, both
  rebuild, and last-writer-wins the artifact (no corruption of a single file, given atomic
  rename, but a lost update / wrong provenance is possible). **This matters directly for AC3**:
  T7 (`keryx trigger run`) cannot assume "the same lock the interactive commands take" already
  exists for a reconcile/rebuild action — for THAT action kind it will need to either introduce a
  project-level lock (a new `withFileLock` call, e.g. over a `.metaproject/data/.trigger-run.lock`
  or reuse `flowLockPath`-style project scoping) or explicitly document that reconcile/rebuild
  triggers are safe only because of atomic-rename-per-artifact, not because of serialization. For
  the `open-flow`/`flow-next` action kinds, `src/flow/service.ts` ALREADY takes `withFileLock` per
  flow directory, so those two action kinds get real concurrency safety for free; `reconcile`/
  `rebuild` do not.

- **The spend ceiling / budget refusal** (needed for AC8): the ceiling and its evaluation are
  currency-denominated (USD), not token-denominated, by deliberate design — see the long
  rationale comment at `src/review/caps.ts:221-247` (`DEFAULT_SPEND_CEILING_USD = 3`). The pure
  decision function is `evaluateSpendCap(spent, {ceiling})` (`src/review/caps.ts:289-...`),
  returning a `SpendCapEvaluation` with `status: "under" | "over" | "not-recorded"` and
  `stop: boolean` — `stop` is `true` only for `"over"`. The refusal is produced (not just
  evaluated) by `runBudget` in `src/commands/review.ts:688-736` (`keryx review budget`): it
  prints the evaluation, and when `spend.stop` it prints a `STOP:` line to stderr and sets
  `process.exitCode = 1` (`src/commands/review.ts:729-735`) — refusing BEFORE the spend happens,
  per the doc comment at `src/commands/review.ts:681-686` ("this refuses first, with a non-zero
  exit, which is the only signal an orchestrator reliably notices"). `evaluateSpendCap` is also
  consulted (not enforced) inside `src/review/managed.ts:326-337` when a round's spend is
  recorded after the fact. **For T7/T8/AC8**: a triggered run whose action would call a model
  (an `open-flow`/`flow-next` action that dispatches agent work) should call
  `evaluateSpendCap` the same way `keryx review budget` does, and on `stop: true` record the
  outcome (T8's fired-trigger record) as a distinct, non-crash outcome kind — e.g.
  `outcome: "budget-refused"` alongside `"ok"`/`"failed"`/`"no-op"` — rather than reusing
  `process.exitCode = 1` unconditionally, since AC2 already reserves non-zero exit for "the
  action itself failed" and a budget refusal is explicitly NOT that (AC8: "not as a crash"). That
  exit-code-vs-outcome-kind distinction is a decision for T7/T8, flagged here rather than made.

### T5 — decision: where the trigger config lives

See `journal.md` (`- note (implementer):` line) for the recorded decision: **`.metaproject/triggers.json`**,
loaded by `src/trigger/config.ts` (new, flow 286 T6). Reasoning, in short: `.metaproject/metaproject.json`
(the module manifest, `src/commands/init.ts`/`update.ts`) and every `<module>.config.json` next to it
(`gdctx.config.json`, `health.config.json`, `memory.config.json`, ...) are **machine-managed** —
rewritten by `keryx init`/`update` under the documented "one writer" discipline
(`src/lib/routing-entrypoint.ts:45-51` comment). A trigger list is the opposite: hand-authored,
grows/shrinks by direct operator edits, and never wholesale-regenerated. Putting it inside a
generated manifest risks losing hand-edited entries on the next `keryx update`. The closer
precedent is `src/lib/provider-config.ts`'s `llm-providers.json` — an operator-owned collection of
independently-valid entries with its own file, deliberately kept separate from the neighbouring
`auth.json` for the same reason. `.metaproject/triggers.json` is also literally the path the flow's
own `description.md` names first.


