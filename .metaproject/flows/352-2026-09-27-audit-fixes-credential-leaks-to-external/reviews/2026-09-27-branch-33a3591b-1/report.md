# Managed Review Report — Flow 352

**Target**: retrospective audit of an already-merged, already-squashed commit
**Range**: `33a3591b~1..33a3591b` (PR #770, "fix(security): audit fixes — credential leaks, sub-agent cancel, shell lease (0.3.15)"), branch `main`
**Head**: `33a3591b43797f1383e58a4399e72e365540ab8c`
**Mode**: diff, pre-filter scope: 30/30 files retained, 82/82 change blocks retained, 0 dropped (`droppedByReason` all zero) — see `scope.md`
**Flow**: 352 (`audit-fixes-credential-leaks-to-external`), acceptance criteria AC1–AC8

## Reviewers dispatched

Selected per the review-orchestrator's own routing (no explicit flags given; fallback + stack-scoping + judgment for a security-domain diff): `review-logic`, `review-architecture`, `review-security-code`, `review-highload`, `review-testing-practices`. `review-backend`/`review-frontend`/mobx/nestjs/prisma-gated reviewers excluded by `keryx review stack` (none of those tags detected in `package.json`). No convention reviewers matched (`src/core/**`, `src/core/flow/**`, React/Tailwind paths — none touched). Dispatched as `general-purpose` sub-agents carrying each reviewer's persona (native agent types for these names are not available in this runtime), per "Agent Runtime Compatibility".

`review-testing-practices`'s normal mutation-sweep (delete a guard, confirm red) was withheld under this task's explicit read-only constraint; it instead reasoned about each assertion against the diffed implementation and ran the full touched-test set read-only (542 tests, 0 failures).

No `review-verifier` (Wave C) sub-agent was dispatched. In its place, the orchestrator (this session) independently re-read the code behind every blocker/major finding below — the exact file, function and line ranges cited as evidence — before including it, rather than accepting reviewer claims on say-so. `verification_mode` is recorded as `off` on ingest: no automated verifier ran, and that absence is stated rather than papered over.

## Stage 1 gate — spec compliance (AC1–AC8 vs. the diff)

Owned by `review-logic` (no `issue_url`/Jev-contract enabled; PR body / flow AC file used as spec), cross-checked independently by `review-highload`:

| AC | Claim | Verdict |
|---|---|---|
| AC1 | `buildExternalChildEnv` strips credential-shaped vars, keeps only the target CLI's own key | **Holds.** `env.ts` reuses `isDeniedForMcpChild` from `spawn-env.ts` (not forked); allow-list is per-runtime and traced for both directions. |
| AC2 | `SandboxedWebTransport.fetchRaw` drops credential on cross-origin redirect | **Holds.** Origin comparison via `URL.origin` traced through 2+-hop, protocol-relative and same-host-different-port redirects; no leak path found. |
| AC3 | Timeout exit uses the same quarantine/fold as other exits | **Holds.** Same `foldChildSummary` called on timeout, success and error paths. |
| AC4 | `isDeniedForMcpChild` denies glued credential names, allows ordinary vars | **Holds**, with one unanchored-regex `info` note (see below). |
| AC5 | `serverFingerprint` covers the `oauth` block | **Holds.** clientId/scopes(sorted)/callbackPort all mixed into the hash. |
| AC6 | Abort reaches sequential, concurrent-batch and budget-wrap-up spawn_subagent paths | **Holds** for the abort-delivery wiring itself, but see MAJOR-1 below for a related reporting gap in the wrap-up round, once aborted. |
| AC7 | A throwing turn still releases the lease and leaves the bus; SIGINT/SIGTERM sweeps jobs | **Fails, in part — blocker.** The fix was applied only to `runAgentRepl` (agent-mode REPL). The sibling `runShell` (chat-mode REPL) has no equivalent try/finally; see BLOCKER-1. SIGINT/SIGTERM sweep (`makeSignalShutdown`/`JobRegistry.sweepAll`) is genuinely race-free (`Promise.all` over per-item-guarded kills) — that half of AC7 holds. |
| AC8 | typecheck/lint/tests pass; CHANGELOG + version bumped | **Holds.** `package.json` 0.3.14→0.3.15, CHANGELOG entry present; full touched-test set green (542/542). |

## Memory search

`keryx memory search "credential leak external agent child env sandboxed web transport redirect trust fingerprint oauth abort spawn subagent shell lease" --status accepted` — 10 results, none scoped to these modules with high relevance; closest was a general lesson ("a shell allowlist matched against a raw command string is not a security boundary") and a known-mistake about a trust tag not actually changing a policy decision (`gdctx-redaction-ignores-trust-tag`) — worth keeping in mind for `trust.ts`, but AC5's `oauth` fingerprint fix was independently confirmed to actually change the hash output, so that specific failure mode does not recur here.

## Findings

### BLOCKER-1 — AC7's lease/bus release fix covers only the agent-mode REPL, not chat-mode

- **Severity**: blocker (unimplemented acceptance criterion — AC7 says "keryx shell", not "keryx shell in agent mode")
- **File**: `src/commands/shell.ts`
- **Reported independently by**: `review-logic` (id L1) and `review-highload` (id H1) — same defect, merged; class_scope below uses `review-highload`'s more complete enumeration. Confirmed directly by the orchestrator (this session) by reading the cited lines.
- **Evidence, read directly**:
  - `runAgentRepl`'s whole loop is wrapped in one try/finally (`try` at line 2473, `finally` calling `leaveBus()`/`releaseLease()` at ~2902–2906), with an explicit comment at line 2462: *"AC7 (flow 352 audit): the whole loop is wrapped in one try/finally so `leaveBus()`/`releaseLease()` run EXACTLY once, on every way this loop can end… Before this, a thrown turn error left the loop — and the whole function — without either call ever running, parking the session lease held and the bus membership joined."*
  - `runShell` (chat-mode REPL, lines 738–1197) has **no such wrapper**. Its `for await (const line of io.lines)` loop (line 913) calls `leaveBus()`/`releaseLease()` only at the `/exit`/`/quit` branch (lines 921–924, then `return`) and at the loop's natural EOF fall-through (lines 1195–1196). Several branches inside the loop are not individually guarded and can throw: `loadInspectorWorkspaces`/`loadInspectorFlows`/`loadSessionLimits` in the session-info block (~939–957), `loadInspectorFlows` in the `/flows` block (~962), `/theme`'s `applyThemeId`/`persistThemeId` (~972–986), `compactSession` (`/compact`, ~1029), and `makeActive()` in `/model`/`/provider` (~1049, ~1073).
  - `runWithLeaseChoice` (line 633) only catches `SessionLeasedError`; every other exception rethrows.
  - The call site in `shellCommand`'s chat-mode branch (line 4393–4406, `else` arm) has no wrapping try/finally of its own; the outer `finally` at line 4408 only closes `readlineMcp`/`rl` — never touches `leaseBox`/`busBox`. Contrast: the TUI chat branch a few hundred lines earlier (~3867…3960–3982) DOES wrap in try/finally releasing `chatLeaseBox`/`chatBusBox` unconditionally — the plain readline chat-mode path is the one sibling that was missed.
- **Impact**: in `keryx shell` chat mode (the default when no `--agent` flag and no TUI), a turn or slash command that throws leaves the session lease held and the bus joined for the rest of the process's life. The next `-r` on that session then needs `--take-over` — exactly the regression this release's own CHANGELOG claims is fixed ("`keryx shell` releases its session lease when a turn fails").
- **class_scope** (sites, `review-highload`'s enumeration): `shell.ts:939` (`loadInspectorWorkspaces`/`loadInspectorFlows`), `shell.ts:947` (`loadSessionLimits`), `shell.ts:962` (`loadInspectorFlows`, `/flows`), `shell.ts:1029` (`compactSession`, `/compact`), `shell.ts:1049` (`makeActive()`, `/model`), `shell.ts:1073` (`makeActive()`, `/provider` explicit-name branch).
- **Suggested fix**: wrap `runShell`'s main loop in the same try/finally `runAgentRepl` now uses — move the two inline `leaveBus()`/`releaseLease()` calls into one `finally` around the `for await` loop, removing the now-redundant inline calls at `/exit`/EOF, mirroring the comment already at `shell.ts:2462–2472`.
- **Disposition**: **open** — not fixed in this commit. This is a real defect; it is reported, not corrected (per task instructions, no source edits were made).

### MAJOR-1 — `finishWithBudgetSummary` never checks `round.aborted`; an abort during the wrap-up round is misreported as "no progress"

- **Severity**: major
- **File**: `src/commands/agent.ts`
- **Reported by**: `review-highload` (H2). Confirmed directly: read `streamWrapUpRound` (line 3600, sets `aborted=true` at 3646/3697 without setting `thrownError`), `finishWithBudgetSummary` (line 3729; its only post-round checks are `round.thrownError` at 3822 and `round.assistantText.length` at 3825 — no `round.aborted` check anywhere), its sole call site (`agent.ts:3502`, inside the `noProgress` branch, unconditionally followed by `return { finishReason: "no-progress" }` at line 3509), and its sibling `finishWithSubmitResult` (line ~3909), which DOES check `if (round.aborted || signal?.aborted === true) { return { aborted: true }; }` immediately after the same `streamWrapUpRound` call, under an explicit "Review F-006" comment.
- **Impact**: if the parent turn is aborted while inside this specific wrap-up round, the caller still unconditionally reports `"no-progress"` rather than an interrupted outcome; any partial `assistantText` streamed before the abort is pushed into history as a normal, complete assistant turn with no record it was cut off, and an empty result prints the misleading "[budget] No wrap-up text from the model. Re-run your request…" message for what was actually a user-initiated interruption, not the model producing nothing.
- **Suggested fix**: mirror `finishWithSubmitResult` — check `round.aborted || signal?.aborted === true` right after the `streamWrapUpRound` call in `finishWithBudgetSummary` and branch to an interruption-specific message/outcome instead of falling through to the no-progress/no-text path.
- **class_scope**: sole call site `agent.ts:3502`, sole function `finishWithBudgetSummary` at `agent.ts:3729`.
- **Disposition**: **open** — pre-existing gap made newly reachable by this commit's own abort-wiring fix (AC6 now threads a real `signal` into this round for the first time; before this commit the round was uninterruptible by construction and the question didn't arise the same way). Reported, not fixed.

### MAJOR-2 — `deep-enrich.ts`'s `composed.dispose()` is skipped on the function's own catch-all exception path (listener leak on a batch-shared `AbortSignal`)

- **Severity**: major
- **File**: `src/wiki/deep-enrich.ts`
- **Reported by**: `review-highload` (H3). Confirmed directly: read `enrichPageDeep` in full (`composed = composeAbortSignals(input.signal, abort.signal)` at line 314; `composed.dispose()` called on exactly three exit paths — line 376 (non-positive-budget early return), line 414 (timeout), line 425 (normal-outcome fall-through after the `Promise.race` at line 401) — but the function-level `catch (cause)` at line 448 does **not** call it). If `await Promise.race([turn.then(() => "done"), expired, cancelled])` at line 401 rejects (the `turn` promise itself rejecting, rather than resolving to `"done"`), the exception passes through the `finally` at 402–407 (which only clears the timer/listener, not `composed`) straight to the outer catch at 448, where `composed.dispose()` never runs.
- **Impact**: `composeAbortSignals` attaches an `{once:true}` `abort` listener onto the caller-supplied external signal. `src/wiki/enrich.ts` (`runDeepSingle`, ~line 1246–1256) passes the **same** `ctx.input.signal` — one shared cancellation signal for the entire wiki-enrich batch — into every `enrichPageDeep` call for every page in the run (confirmed: `ctx.input.signal` is checked repeatedly across the file, e.g. lines 1155/1193/1240/1262, consistent with a per-page loop sharing one signal). Each page that hits this uncaught-exception path during a batch leaves one more undisposed listener (and its closure) on that shared, long-lived signal, growing with the number of pages that hit it before the batch signal itself ever fires.
- **Suggested fix**: call `composed.dispose()` in the catch block at line 448 (idempotent-safe, matching the other three exit paths), or restructure with an outer try/finally that disposes unconditionally.
- **class_scope**: sole occurrence, `deep-enrich.ts:213` `enrichPageDeep` (composed created line 314, undisposed catch line 448). `spawn-subagent-tool.ts`, the classifier's other production caller, does dispose in its own catch (line 1874) — confirmed not to share this gap.
- **Disposition**: **open**. Not introduced by this commit's stated scope (deep-enrich.ts's change here was a pure extraction of `composeAbortSignals` into the new shared `src/lib/abort-compose.ts`, confirmed by `review-architecture`) but newly relevant because this commit is what gave `composeAbortSignals` a second production caller with a batch-shared signal shape. Pre-existing gap, surfaced by this audit; reported, not fixed.

### MAJOR-3 — `credential-boundary.test.ts` claims AC1/D-01 coverage for a code path that has no real caller yet

- **Severity**: major
- **File**: `src/mcp-client/credential-boundary.test.ts`
- **Reported by**: `review-testing-practices` (T1). Confirmed directly: `keryx ctx rg "gatedSuperviseCodexMcpRun|superviseCodexMcpRun" src` shows every non-test reference is inside `src/harness/external/supervise-mcp.ts` itself (definition and its own doc comments — *"the ONE entry point **a future caller** uses"*, *"ready for **a future task** to wire into an actual dispatch path"*) plus one doc-comment mention each in `acp-client.ts` and `mcp-client/client.ts`. No production module outside `supervise-mcp.ts` calls either function.
- **Impact**: this commit updated the file's header comment to fold in the AC1 exemption story (`EXTERNAL_RUNTIME_CREDENTIAL_ALLOW`) and claims equivalence to the already-wired "line-stream path" (`superviseExternalRun`, genuinely wired via `runtime.ts:476/587` with a real per-agent `runtimeId`). But the test file's three `describe` blocks only grep source text for a literal `process.env` token and four hardcoded identifier strings inside `src/mcp-client/`/`supervise-mcp.ts` — none exercise `buildExternalChildEnv`, `isDeniedForMcpChild`, or a real environment value. The suite stays green today only because `supervise-mcp.ts` has no caller to leak through; once a future caller wires it with the wrong `runtimeId`, a raw `process.env`, or no scrubbing at all, this suite would not catch it.
- **Suggested fix**: either narrow the docstring's claim to what the file actually checks (much smaller than "D-01 evidence"), or add a real assertion once a caller exists that builds an env via `buildExternalChildEnv` with a representative `runtimeId` and asserts it round-trips scrubbed through `superviseCodexMcpRun`'s `client.connect` call.
- **class_scope**: sole site, `credential-boundary.test.ts:6-23` (header comment + all three `describe` blocks) — confirmed unique to this file among the AC1–7 test set (no other touched test file makes an equivalent unverified "D-01 evidence" claim).
- **Disposition**: **open** — a documentation/coverage-claim mismatch, not a shipped leak (there is nothing to leak through yet). Reported, not fixed.

### MINOR-1 — Shared credential-shape classifier lives in a feature-specific module (`spawn-env.ts`) that a sibling subsystem (`harness/external`) reaches into

- **Severity**: minor
- **File**: `src/harness/external/env.ts`
- **Reported by**: `review-architecture` (A1).
- **Detail**: `isDeniedForMcpChild` and its regexes are correctly reused (not forked) by `buildExternalChildEnv`, but they still live in `src/mcp-servers/spawn-env.ts` — a module named/scoped for one specific feature — rather than a neutral shared location. `env-deny.ts` was extracted in this same commit for the by-name deny lists precisely to avoid an import cycle, but the shape-classifier function was not given the same treatment.
- **Suggested fix**: move `isDeniedForMcpChild` and its regex constants into `env-deny.ts` or a new neutral module (e.g. `src/lib/credential-shape.ts`), leaving MCP-specific by-name lists in `spawn-env.ts`.
- **Disposition**: **open**, cosmetic/maintainability — no runtime defect.

### INFO-1 — `env.ts`'s own first-pass name/prefix check is case-sensitive, unlike its fallback

- **Severity**: info
- **File**: `src/harness/external/env.ts`
- **Reported by**: `review-security-code` (S1). No reachable input currently demonstrates a leak (every name in `EXTERNAL_ENV_DENY`/`EXTERNAL_ENV_PREFIX_SWEEPS` is re-checked case-insensitively by `isDeniedForMcpChild`'s own fallback). Noted as a defense-in-depth fragility: the safety currently depends on that fallback continuing to re-test those lists case-insensitively.
- **Disposition**: **open**, informational only.

### INFO-2 — `GLUED_SECRET_RE` is an unanchored substring match

- **Severity**: info
- **File**: `src/mcp-servers/spawn-env.ts`
- **Reported by**: `review-logic` (L2). No false positive found against any real variable name in this codebase's env lists; theoretical over-match risk only.
- **Disposition**: **open**, informational only.

### INFO-3 — One AC7 test is a source-text audit, not a runtime assertion (redundant, not load-bearing)

- **Severity**: info
- **File**: `src/commands/shell-bus.test.ts`
- **Reported by**: `review-testing-practices` (T2). The equivalent real-behavior guard is independently and directly verified in `shell-agent-repl.test.ts`'s "a crashing turn still leaves the lease released and the bus joined-then-left" test, which does exercise real `runAgentRepl()` end-to-end.
- **Disposition**: **open**, informational only.

## Regressions the fixes introduced

None found. MAJOR-1 and MAJOR-2 are gaps in code this commit touched (and in MAJOR-1's case, newly *reachable* because of this commit's own fix), but neither is a new defect this commit's changes caused in previously-correct behavior — both are pre-existing gaps this audit surfaced while checking the surrounding fix.

## Suite status

All touched test files run green: 542 tests across the 10+ files listed in `scope.md`, 0 failures (confirmed by `review-testing-practices`, read-only — no mutation edits made per task constraint).

## Routing audit (this orchestrator)

- `graph_used`: not-relevant — exact commit range and file list were already known from the flow's acceptance criteria; no navigation query needed.
- `wiki_used`: not-relevant — the flow's own `acceptance-criteria.md` was the authoritative spec.
- `ctx_used`: yes — all cross-file symbol/text search by this orchestrator went through `keryx ctx rg`.
- `raw_rg_used`: no — the historical-commit-range reads (`git diff`, `git show`) used the task-authorized `# keryx:raw <reason>` escape where the routed tools do not support a fixed historical range; no bare `grep`/`cat`/`git diff` without that marker.

```json keryx:findings
[
  {
    "id": "BLOCKER-1",
    "severity": "blocker",
    "file": "src/commands/shell.ts",
    "line": null,
    "quote": "for await (const line of io.lines) {",
    "problem": "runShell (the plain chat-mode readline REPL) has no wrapping try/finally around its main loop; leaveBus()/releaseLease() only run at the /exit branch and at the loop's natural EOF fall-through, so a throw from an unguarded slash-command handler (session-info, /flows, /theme, /compact, /model, /provider) propagates out uncaught, past runWithLeaseChoice (which rethrows anything but SessionLeasedError) and past shellCommand's outer finally (which only closes readlineMcp/rl, never leaseBox/busBox). AC7 claims this is fixed shell-wide; the fix (a wrapping try/finally, present at shell.ts:2473/2902-2906 in the sibling runAgentRepl, explicitly commented 'AC7 (flow 352 audit)') was applied only to runAgentRepl, not to runShell.",
    "impact": "In keryx shell chat mode (the default without --agent/TUI), a turn or slash command that throws leaves the session lease held and the bus joined for the rest of the process's life. The next `-r` on that session then needs `--take-over`, exactly the regression the release's own CHANGELOG says was fixed.",
    "suggested_fix": "Wrap runShell's main for-await loop (shell.ts:913-1196) in the same try/finally pattern runAgentRepl now uses: move the two inline leaveBus()/releaseLease() calls (lines 921-924, 1195-1196) into one finally around the loop.",
    "evidence": "Read src/commands/shell.ts runShell (line 738) end-to-end: no wrapping try/finally around the loop (line 913). Read runAgentRepl (line 1607), confirmed try at 2473 / finally at ~2902-2906 releasing leaveBus()/releaseLease(), with an explicit 'AC7 (flow 352 audit)' comment at line 2462 describing exactly this defect as what was fixed there. Read runWithLeaseChoice (line 633): rethrows anything but SessionLeasedError. Read shellCommand's readline chat-mode branch (else arm, ~4387-4406) and its outer finally (4408-4423): closes readlineMcp/rl only, never leaseBox/busBox. Contrasted with the TUI chat branch (~3867/3960-3982), which does release chatLeaseBox/chatBusBox in its own try/finally.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "ac7-runshell-lease-leak-on-throw",
    "class_scope": {
      "sites": [
        "src/commands/shell.ts:939 (loadInspectorWorkspaces/loadInspectorFlows, isSessionInfoCommand branch)",
        "src/commands/shell.ts:947 (loadSessionLimits)",
        "src/commands/shell.ts:962 (loadInspectorFlows, isFlowsCommand branch)",
        "src/commands/shell.ts:972-986 (applyThemeId/persistThemeId, /theme)",
        "src/commands/shell.ts:1029 (compactSession, /compact)",
        "src/commands/shell.ts:1049 (makeActive(), /model)",
        "src/commands/shell.ts:1073 (makeActive(), /provider explicit-name branch)"
      ],
      "enumeration_method": "Independently reported by review-logic and review-highload; sites merged from review-highload's enumeration (grep of every leaveBus()/releaseLease() call site in shell.ts, and every unguarded branch inside runShell's loop body), then confirmed directly by the orchestrator reading shell.ts lines 738-1197, 2440-2530, 2860-2910, 3860-3985, 4380-4423."
    }
  },
  {
    "id": "MAJOR-1",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "line": null,
    "quote": "const round = await streamWrapUpRound(io, deps, request, signal, system);\n  if (round.thrownError !== undefined) {\n    system(`\\n[error] wrap-up failed: ${round.thrownError}\\n`);\n  }\n  if (round.assistantText.length > 0) {",
    "problem": "finishWithBudgetSummary threads the real abort signal into streamWrapUpRound (this commit's AC6 fix) but never checks round.aborted / signal?.aborted after the round settles, unlike its sibling finishWithSubmitResult, which explicitly does (`if (round.aborted || signal?.aborted === true) { return { aborted: true }; }`, commented 'Review F-006').",
    "impact": "An abort during this specific wrap-up round is misreported: the caller (agent.ts:3502-3509) unconditionally returns finishReason 'no-progress' regardless, any partial assistantText that streamed before the abort is pushed into history as a normal complete turn with no record it was cut off, and an empty result prints '[budget] No wrap-up text from the model. Re-run your request…' for what was actually a user-initiated interruption.",
    "suggested_fix": "Mirror finishWithSubmitResult: check `round.aborted || signal?.aborted === true` immediately after the streamWrapUpRound call in finishWithBudgetSummary and branch to an interruption-specific outcome instead of falling through to the no-text/no-progress path.",
    "evidence": "Read agent.ts:3600-3723 (streamWrapUpRound: sets aborted=true at lines 3646/3697, never sets thrownError on that path). Read agent.ts:3729-3840 (finishWithBudgetSummary: post-round checks only round.thrownError at 3822 and round.assistantText.length at 3825, no round.aborted check). Read the sole call site agent.ts:3500-3509 (unconditional `return { finishReason: \"no-progress\" }`). Read the sibling finishWithSubmitResult (~agent.ts:3909-3915): explicit round.aborted check immediately after the same streamWrapUpRound call.",
    "confidence": "high",
    "reviewer": "review-highload",
    "dedupe_key": "finish-budget-summary-abort-misreported-as-no-progress",
    "class_scope": {
      "sites": ["src/commands/agent.ts:3729 finishWithBudgetSummary (sole call site agent.ts:3502)"],
      "enumeration_method": "grep for finishWithBudgetSummary( across src/commands/agent.ts returned exactly one call site; compared its post-round handling against its structural sibling finishWithSubmitResult. Confirmed directly by the orchestrator reading both functions and the call site."
    }
  },
  {
    "id": "MAJOR-2",
    "severity": "major",
    "file": "src/wiki/deep-enrich.ts",
    "line": null,
    "quote": "  } catch (cause) {\n    return { fallback: true, reason: `deep enrich failed: ${errorMessage(cause)}`, toolCalls };\n  }\n}",
    "problem": "enrichPageDeep's composed AbortSignal (composed = composeAbortSignals(input.signal, abort.signal), line 314) is disposed on three of its exit paths (lines 376, 414, 425) but not on the function-level catch at line 448. If the awaited Promise.race([turn.then(...), expired, cancelled]) (line 401) rejects because the underlying turn promise itself rejects, the exception reaches this catch with composed.dispose() never called.",
    "impact": "composeAbortSignals attaches an {once:true} abort listener onto the caller-supplied external signal. src/wiki/enrich.ts's runDeepSingle passes the SAME ctx.input.signal — one shared cancellation signal for the whole wiki-enrich batch run — into every enrichPageDeep call across every page. Each page that hits this uncaught-exception path during a batch leaves one more undisposed listener on that shared, long-lived signal, growing with the number of pages that hit it before the batch signal itself fires.",
    "suggested_fix": "Call composed.dispose() in the catch block at deep-enrich.ts:448 (idempotent-safe, matching the other three exit paths), or restructure with an outer try/finally that disposes unconditionally on every path.",
    "evidence": "Read src/wiki/deep-enrich.ts:290-451 in full: composed created line 314, disposed at 376/414/425, NOT disposed in the catch at 448. Read src/wiki/enrich.ts around lines 1155-1262: ctx.input.signal passed to enrichPageDeep at ~1256 and checked repeatedly (1155/1193/1240/1262), consistent with one shared signal across a per-page batch loop. Read src/harness/tool/builtin/spawn-subagent-tool.ts:1725-1888, confirmed composed.dispose() IS called in its own catch (line 1874) — the other production caller of composeAbortSignals does not share this gap.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "dedupe_key": "deep-enrich-composed-signal-dispose-skipped-on-exception",
    "class_scope": {
      "sites": ["src/wiki/deep-enrich.ts:213 enrichPageDeep (composed created line 314, undisposed catch line 448)"],
      "enumeration_method": "Repo-wide search for composeAbortSignals found exactly 2 non-test production call sites; the other (spawn-subagent-tool.ts) traced and confirmed to dispose on every exit path, leaving this as the sole member of the class. Confirmed directly by the orchestrator."
    }
  },
  {
    "id": "MAJOR-3",
    "severity": "major",
    "file": "src/mcp-client/credential-boundary.test.ts",
    "line": 6,
    "quote": "// `gatedSuperviseCodexMcpRun` in, exactly like `superviseExternalRun`'s own",
    "problem": "This commit updated the file's header comment to fold in the AC1 exemption story, implying this module's cross-boundary credential handling is proven 'exactly like the existing line-stream path'. But none of the file's three describe blocks exercise buildExternalChildEnv, isDeniedForMcpChild, or any real environment value — they only grep source text for a literal process.env token and 4 hardcoded identifier strings. The functions this file is about (gatedSuperviseCodexMcpRun/superviseCodexMcpRun) have zero non-test callers anywhere in src/ today.",
    "impact": "A reader (or a future reviewer citing this file as AC1 evidence) is told this integration point's credential handling is proven, when the only real proof is that supervise-mcp.ts has no caller to leak through yet. Once a caller is wired, a mistake in that wiring (wrong runtimeId, raw process.env, or no scrubbing) would ship with this suite still green.",
    "suggested_fix": "Either narrow the docstring's claim to what the file actually checks, or add a real assertion once a caller exists: build an env via buildExternalChildEnv with a representative runtimeId and assert it round-trips scrubbed through superviseCodexMcpRun's client.connect call.",
    "evidence": "Read src/mcp-client/credential-boundary.test.ts in full (91 lines), diffed against pre-commit. Read src/harness/external/supervise-mcp.ts (spawnOptions construction at line 228: env: input.env). keryx ctx rg \"gatedSuperviseCodexMcpRun|superviseCodexMcpRun\" src confirmed every non-test reference lives inside supervise-mcp.ts itself (definition + its own 'a future caller'/'a future task' doc comments) plus one doc-comment mention each in acp-client.ts and mcp-client/client.ts — no production caller anywhere. bun test src/mcp-client/credential-boundary.test.ts passes.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "credential-boundary-claim-vs-behavior-ac1",
    "class_scope": {
      "sites": ["src/mcp-client/credential-boundary.test.ts:6-23 (header comment + all 3 describe blocks)"],
      "enumeration_method": "Read the full file (91 lines); grepped the same touched-file list for 'D-01'/'proves' — this unverified-claim pattern is unique to this file. Confirmed directly by the orchestrator via keryx ctx rg re-enumeration of every call site."
    }
  },
  {
    "id": "MINOR-1",
    "severity": "minor",
    "file": "src/harness/external/env.ts",
    "line": null,
    "quote": "import { isDeniedForMcpChild } from \"../../mcp-servers/spawn-env\";",
    "problem": "The shared credential-shape classifier (isDeniedForMcpChild) and its supporting regexes live in src/mcp-servers/spawn-env.ts, a module named/scoped for one specific feature, rather than a neutral shared location; src/harness/external/ (a sibling, independent subsystem) imports a concrete function out of it. env-deny.ts was correctly split out as a new leaf module for the by-name deny lists for exactly this reason, but the shape-classifier function itself was not given the same treatment.",
    "impact": "A future contributor refactoring or extracting src/mcp-servers/ as a self-contained unit is likely to miss that harness/external depends on one exported function from it.",
    "suggested_fix": "Move isDeniedForMcpChild and its regex constants into env-deny.ts or a new neutral module (e.g. src/lib/credential-shape.ts); keep MCP-specific by-name lists in spawn-env.ts.",
    "evidence": "Read src/harness/external/env.ts, src/mcp-servers/spawn-env.ts, and src/harness/external/env-deny.ts in full; confirmed via git diff 33a3591b~1..33a3591b that env-deny.ts was newly extracted in this commit specifically so spawn-env.ts could avoid importing env.ts back, while the shape classifier was left in spawn-env.ts and pulled the other direction.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "dedupe_key": "credential-classifier-cross-subsystem-import"
  },
  {
    "id": "INFO-1",
    "severity": "info",
    "file": "src/harness/external/env.ts",
    "line": null,
    "quote": "if (denied.has(key)) continue;\n    if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => key.startsWith(prefix))) continue;",
    "problem": "buildExternalChildEnv's own first-pass name/prefix checks are case-sensitive, unlike isDeniedForMcpChild's internal re-checks of the same lists, which uppercase both sides.",
    "impact": "No current leak: every name in EXTERNAL_ENV_DENY/EXTERNAL_ENV_PREFIX_SWEEPS is still caught for a lower/mixed-case variant via isDeniedForMcpChild's case-insensitive fallback. Defense-in-depth note only: safety currently depends on that fallback continuing to re-test these lists.",
    "suggested_fix": "Uppercase both sides in env.ts's own first-pass checks, or comment at spawn-env.ts's re-checks that env.ts relies on their case-insensitivity.",
    "evidence": "Read src/harness/external/env.ts lines 108-124 against src/mcp-servers/spawn-env.ts lines 303-330.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "dedupe_key": "external-env-case-sensitivity-defense-in-depth"
  },
  {
    "id": "INFO-2",
    "severity": "info",
    "file": "src/mcp-servers/spawn-env.ts",
    "line": null,
    "quote": "const GLUED_SECRET_RE = /(PRIVATE|SECRET|ACCESS|REFRESH|SESSION|CLIENT|API|APP)(KEY|TOKEN|SECRET)|DB(PASS|PWD)/;",
    "problem": "Unanchored substring match — matches the glued shape anywhere inside a longer variable name, not just as the whole name.",
    "impact": "No concrete false positive found against any real env var name in this codebase or the AC4 test list; theoretical over-match risk only.",
    "suggested_fix": "Not necessary given current coverage; if revisited, anchor with (^|_)/($|_) like the sibling SECRET_SEGMENT_RE.",
    "evidence": "Read the regex and traced it against every name in AC4 and the file's own comments; no false-positive site found.",
    "confidence": "low",
    "reviewer": "review-logic",
    "dedupe_key": "spawn-env-glued-regex-unanchored"
  },
  {
    "id": "INFO-3",
    "severity": "info",
    "file": "src/commands/shell-bus.test.ts",
    "line": 226,
    "quote": "test(\"/exit and end-of-input both return from inside the loop's try, whose one finally leaves the bus before releasing the lease\", () => {\n    const tryIndex = replBody.indexOf(\"  try {\\n    for (;;) {\");",
    "problem": "This AC7 test is a source-text audit (string-index checks on the stringified function body) rather than an executed behavioral assertion.",
    "impact": "None currently: the equivalent real-behavior guard is independently and directly verified in shell-agent-repl.test.ts's 'a crashing turn still leaves the lease released and the bus joined-then-left' test, which exercises real runAgentRepl() end-to-end. Redundant/supplementary, not load-bearing on its own.",
    "suggested_fix": "No action required given the redundant runtime test exists.",
    "evidence": "Read src/commands/shell-bus.test.ts lines 214-248 and cross-referenced shell-agent-repl.test.ts's AC7 describe block.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "shell-bus-source-text-audit-ac7"
  }
]
```
