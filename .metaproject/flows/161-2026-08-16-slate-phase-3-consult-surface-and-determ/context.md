# Context

Collected deterministically by `keryx flow init` at 2026-08-16T14:38:57.116Z,
enriched by manual research against live code (gdgraph/gdctx routed) before
freeze.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

gdgraph, gdctx, gdskills, memory, tasks, health, testing, gdwiki, security, mcp

## Agent Findings (manual research pass, before freeze)

### Already shipped (Phase 1/2) — reuse, do not duplicate

- `src/session/slate.ts`: `Slate`/`SlateAnchors`/`SlateCourse`/`SlateSeed`
  types, `readSlate`/`writeSlate`/`archiveSlate`/`openSlateAtomic`/
  `appendSeed`/`dedupeSeeds`. `writeSlate` is the locked read-modify-write
  primitive any new Anchors-mutation helper must go through — never a second
  ad hoc lock.
- `src/session/slate-lifecycle.ts`: `computeAnchors`, `openSlate`/`closeSlate`,
  `SlateSessionRef` (`{dir, cwd, opened}`, caller-owned mutable per-process
  state), `ensureSlateOpened`/`closeSlateSession`, `isCourseDone`,
  `isClosePhrase`, `mintTimestampAttemptId`. `computeAnchors` always sets
  `touched: []` — its own doc comment says appending to `touched` after this
  point is "the harness's own tool-execution wiring (Phase 3+, out of this
  Flow's scope)" — THIS is that phase.
- `src/session/slate-course.ts`: `readCourse`/`courseFromSlate` — live Flow
  projection, fail-closed to `{state:"unbound"}` on any read error. Reuse
  as-is for `slate_read`.
- `src/commands/agent.ts`: `runAgentTurn`/`runAgentTurnCore` already accept
  `options.slateSession?: SlateSessionRef` and already call
  `ensureSlateOpened`/`closeSlateSession` on action-intent/close-phrase/
  flow-done. **Both** `src/commands/shell.ts` (readline agent REPL, line
  ~1034 `slateSession` declared, line ~1306 `runAgentTurn(...,
  {slateSession})`) and `src/tui/tui-shell.ts` (OpenTUI, line ~1819
  `slateSession` declared, line ~2798 `runAgentTurn(...)`) already thread it
  — Phase 2 already closed the cross-surface gap for OPEN/CLOSE. This
  phase's OWN cross-surface risk is different (see below): Anchors
  auto-inject's `/model`-switch trigger and `slate_read`/`slate_write_seed`'s
  session-dir threading are NOT yet wired to both surfaces and must be
  verified by grep, not assumed.
- `src/harness/tool/builtin/workspace-context-tool.ts`: shape to mirror for
  `slate_read`/`slate_write_seed` — a factory taking constructor args,
  returning `InteractiveTool` with `definition.risk` and an `invoke` that
  NEVER throws (returns `{output, isError}` instead), matching
  `executeCall`'s bare `return tool.invoke(input);` in `agent.ts` (NOT
  wrapped in try/catch — a throwing `invoke` propagates uncaught through
  `runAgentTurnCore` and out of `runAgentTurn`, past its own `finally`, and
  crashes the caller's turn loop; every new tool's `invoke` must catch
  internally).
- `src/commands/interactive-agent-tools.ts`: `buildInteractiveAgentTools` —
  THE single factory both `shell.ts` and `tui-shell.ts` call (only 2 real
  call sites: `shell.ts:1581` inside `makeAgentDeps`, used by the TUI path
  via `opts.makeAgentDeps`, and `shell.ts:1761` for the readline agent
  fallback). Adding a new tool here reaches BOTH surfaces automatically —
  this is the correct single wiring point for `slate_read`/`slate_write_seed`.
- `src/commands/harness.ts`: `ParsedArgs`/`parseArgs` already has
  `unattended?: boolean` (Phase 2, T7) — parse-and-store only, no
  `runAgentTurn`/wrap-up pipe wired to it yet (documented deferral in its own
  doc comment). `harness run` executes through a DIFFERENT, older
  `HarnessRunInput`/`RunResult` machinery (Release-0 read-only vertical
  slice), not `runAgentTurn` — no tools are registered there today.

### Real touch points for this phase's 4 items

**SLATE-2a (Anchors auto-inject, AC4).**
- `src/ctx/assembly.ts`: `assembleContext({candidates, maxItems, maxTokens,
  traceRef, configurationRevision, policyRef, policyRevision})` — the PURE
  bounding function (no side effect). `assembleAndRecordContext` is a
  DIFFERENT wrapper that also writes a `.metaproject/context-operations/
  traces/*.json` record — the spec cites `assembleContext` specifically for
  SLATE-2a; do NOT use the recording wrapper (would spam a trace file per
  tool call).
- `src/gdgraph/repomap.ts`: `estimateTokens(text): number` — existing
  token-estimate helper (chars/4-ish heuristic), already reused elsewhere
  (`repomap.ts`, tests). Reuse for `ContextCandidate.tokens`, do not
  reimplement.
- Trigger mapping to real code (no separate "worktree resolved" tool/effect
  exists in the reachable interactive-agent path — the closest real
  correlate is `computeAnchors`'s `resolveProjectRoot()` call, which IS a
  worktree resolution, fired once per slate open/reopen):
  1. tool call completed → `src/commands/agent.ts` `runAgentTurnCore`'s
     per-call loop, right after the existing
     `history.push({role:"tool",...})` for a call that actually executed
     (not budget-skipped).
  2. worktree resolved → `ensureSlateOpened`'s `openSlate`→`computeAnchors`
     path (the moment `root`/`tree` are freshly computed) — inject right
     after `ensureSlateOpened` succeeds and actually opened a slate.
  3. `/model` switch → readline agent mode has NO `/model` command at all
     (`READLINE_AGENT_COMMANDS` in `shell.ts` omits it; the doc comment at
     `shell.ts:121-126` says model switching is TUI-only). Only
     `src/tui/tui-shell.ts`'s `/model` handler (`command.name === "/model"`,
     ~line 2549) needs wiring — chat mode (`runShell`) has no slate at all
     (no tools, no `runAgentTurn`), so its own `/model` (shell.ts:328) is
     out of scope by construction. VERIFY this by grep before relying on it.
  4. subagent spawn/return → same tool-call loop as (1): `spawn_subagent` IS
     a tool call in the parent's loop, so (1)'s wiring covers it as long as
     the extraction logic also fires for `call.name === "spawn_subagent"`
     (e.g. appending a `subagent:<label>` marker to `touched`).
- `touched` extraction: no per-tool special casing exists; a generic
  extractor pulling string values from conventional field names (`path`,
  `file`, `dir`, `target`) off the parsed tool input covers `read_file`,
  `list_dir`, `graph_affected`, etc. without a maintained per-tool map.
  Dedupe against the existing `touched` array (append-only per spec) before
  deciding whether anything actually changed (only inject when it did).
- Bound the RENDERED view via `assembleContext`'s `maxTokens`/`maxItems` even
  though on-disk `touched` storage stays unbounded/append-only (spec
  requirement) — order candidates most-recent-first so trimming drops the
  OLDEST entries from the rendered block, not the newest.

**SLATE-3a (`slate_read`/`slate_write_seed`, AC5).**
- New `src/harness/tool/builtin/slate-tool.ts`, mirroring
  `workspace-context-tool.ts`. `slate_read` input `{}` (no required fields),
  returns `{course: CourseProjection, seeds: SlateSeed[], workspaceId?:
  string}` via `courseFromSlate`/`readSlate`. `slate_write_seed` input
  `{text: string, kind?: SlateSeedKind}`, appends via `appendSeed` with a
  freshly-minted id/ts (injected `idSeq`/`clock`, not `Date.now`/`randomUUID`
  baked in — mirrors `spawn-subagent-tool.ts`'s injected-clock pattern).
  MUST catch `appendSeed`'s thrown "no open slate" error internally (see
  `executeCall`'s bare `return tool.invoke(input)` note above) and degrade
  to `{isError: true}`, never throw.
- Both tools need the SESSION DIR, not just `cwd` — `cwd` alone identifies
  the project, not which session's `slate.json` to read/write.
  `buildInteractiveAgentTools`'s `InteractiveAgentToolsInput` currently has
  no session-dir field at all. Threading a STATIC dir at tool-build time
  does not work: in `tui-shell.ts`, `deps = await opts.makeAgentDeps(sel)`
  (line ~1340) runs BEFORE `slateSession` is assigned (line ~1962) — the
  session dir is not yet known when tools are first built. The fix is a
  LAZY getter, `getSessionDir: () => string | undefined`, threaded through
  `makeAgentDeps`'s signature (`shell.ts` defines it, `tui-shell.ts` calls it
  via `opts.makeAgentDeps`) down into `buildInteractiveAgentTools` and into
  the two new tool factories — each surface passes a closure reading ITS OWN
  `slateSession?.dir` variable BY REFERENCE (not a snapshot), safe because
  the closure is only ever INVOKED once a turn is running, well after
  `slateSession` is assigned, even though the closure is CREATED earlier
  (plain JS `let`-capture-before-declaration is fine as long as the closure
  body only reads the variable after the `let` has executed — TDZ is a
  call-time concern, not a closure-creation-time one). Update every real
  call site (not test-only ones) that builds/rebuilds `AgentDeps`.
- Reachability for AC5 ("never silently injected every round"): SLATE-2a's
  Anchors block must never include Course/Seeds content — keep the two
  concerns in genuinely separate code paths (Anchors renders only
  `anchors.*`; Course/Seeds are ONLY reachable via the new tools' `invoke`).
  A grep-based test asserting `renderAnchorsBlock`'s output never contains
  `course`/`seeds` JSON keys is cheap, cheap insurance for this AC.

**SLATE-11 (`TerminalState`, AC3).**
- Replaces `finishWithBudgetSummary`'s free-text push
  (`src/commands/agent.ts:976-1087`, the literal `"Do NOT call tools."`
  string) ONLY when `AgentDeps.unattended === true` (new optional field,
  default undefined/false — every existing interactive call site is
  byte-for-byte unaffected). Also intercepts an `ask_user` tool call in the
  same `unattended` mode (`runAgentTurnCore`'s tool-execution loop, next to
  the existing `reserveToolAttempt`/budget-exhaustion handling) — deny
  BEFORE invoking the real `ask` callback (no human is present to answer)
  and stop the turn with a `TerminalState` (`reason:
  "ask_user_unanswerable"`) instead of looping.
- `TerminalState` type (per spec's Data Contracts section): `{status:
  "blocked", reason: "ask_user_unanswerable"|"budget_exhausted"|"other",
  courseSnapshot: Slate["course"], anchorsSnapshot: Slate["anchors"],
  occurredAt: string}`. New home: co-located with the other Slate types —
  either `src/session/slate.ts` or a new sibling module
  (`src/session/slate-terminal-state.ts`, matching the existing
  one-concept-per-file convention of `slate.ts`/`slate-lifecycle.ts`/
  `slate-course.ts`). Modeled on `KERYX_INSTALLATION_RESULT`
  (`docs/docs/agent-installation-playbook.md:290-309`) — a printed sentinel
  block for human/log visibility — but ALSO a real typed object (not only
  text) so a future SLATE-10 catch-up can consume it programmatically.
  Emit via a NEW `io.onTerminalState?: (state: TerminalState) => void`
  callback (additive, optional — existing `AgentIO` implementations are
  unaffected) AND a rendered text block through `io.onSystem`/`io.write` for
  visibility; critically, `history` receives NOTHING in the unattended
  terminal-state path (no free-text instruction is pushed at all — this is
  what makes AC3's "no instruction persists into any later turn" hold
  trivially, by construction, not by a value check).
- Evidence for AC3 is a direct `runAgentTurn` unit test with `unattended:
  true` in `AgentDeps` (mirrors how Phase 2's T6 proved SLATE-8 directly
  against `authorizeSacUse`/`ProposalLifecycleService.review()`, not via a
  full CLI E2E path) — `keryx harness run --unattended` does not call
  `runAgentTurn` yet (see Out of Scope), so there is no real CLI path to
  exercise end-to-end this phase; that gap is disclosed, not hidden.

**SLATE-15 (`/goal`, AC1/AC2).**
- `src/sac/workspace-service.ts`: `WorkspaceService.show({request,
  requestCorrelationId, workspaceId})` throws `WorkspaceServiceError` with
  `.code` `"not_found"`/`"access_denied"`/etc. for an invalid or
  actor-invisible id — this IS the existing role-check to reuse.
  `src/commands/workspace.ts`'s `service()` (line 17) is the exact
  construction pattern (`new WorkspaceService({workspaceRoot: process.cwd(),
  authorizationServer: localWorkspaceAuthorizationServer(), strictGuard:
  {mode:"strict", availability:"available", decision:"pass",
  policyRevision:"local-offline-v1"}})`) — reuse verbatim via a small shared
  helper (e.g. exported from `workspace-service.ts` or duplicated with the
  exact same literal — check whether `workspace.ts`'s `service()` is already
  exported/reusable before duplicating).
- `/goal` ordering for AC1: validate `--workspace <id>` FIRST (before any
  slate open); on failure, print a clear rejection and DO NOT open/reopen the
  slate and DO NOT run the turn — "rejects... rather than opening a slate
  that only discovers the problem at wrap-up" means the whole command is
  refused, not degraded to unbound. On success (or no `--workspace` given),
  explicitly call `ensureSlateOpened` (bypassing `isActionRequest`'s
  heuristic — `/goal` is the "deterministic alternative" per spec), set
  `slate.workspaceId` via a locked `writeSlate` update if given, THEN run the
  turn with `<text>` as the userLine (`runAgentTurn(io, deps, history, text,
  {slateSession})` — `ensureSlateOpened` having already run means
  `runAgentTurn`'s own internal re-open check is a safe no-op).
- Wire in BOTH readline (`shell.ts`'s agent-mode command switch, ~line 1287,
  alongside `/search-connect`) and TUI (`tui-shell.ts`'s command switch,
  alongside its `/model` handler) — per the Phase 2 cross-surface lesson,
  verify both by grep, do not assume symmetry.
- `keryx harness run --goal "<text>" --workspace <id> [--unattended]`:
  mechanical flag parsing in `ParsedArgs`/`parseArgs`
  (`src/commands/harness.ts`) — `--goal` becomes the effective `prompt` when
  given (so the flag is not parsed-and-ignored); `--workspace` gets the SAME
  fail-closed validation as `/goal` (reuse the shared helper) before the
  command proceeds at all. No `runAgentTurn`/slate wiring into `harness run`
  itself this phase (see Out of Scope) — this is disclosed CLI-flag-level
  scope, not full end-to-end wiring.
