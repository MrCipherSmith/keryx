# Implementation Plan

Status: frozen for execution

## Approach

Wire Phase 1's pure storage skeleton (`src/session/slate.ts`) into real
harness code paths for the first time. Four independent-but-sequenced areas,
each with its own implement task so context stays bounded per subagent:

1. **Anchors + open/close lifecycle** (SLATE-2, SLATE-5). New lifecycle
   wiring (likely a small new module, e.g. `src/session/slate-lifecycle.ts`,
   kept out of `slate.ts` itself per its own doc comment: "wiring it into the
   harness's open/close lifecycle ... is Phase 2 and later"). Hooks into
   `src/commands/agent.ts`'s `runAgentTurn` around the existing
   `isActionRequest(userLine)` call (~L574, right after the user message is
   pushed to history) to open a slate on first action-intent in an unclosed
   session dir, and into `src/commands/shell.ts` for `/new`/shell-exit close
   triggers (not yet located precisely — implementer reads shell.ts before
   writing this task).
   - **Anchors** populated from `resolveProjectRoot()` (`src/session/paths.ts:52-68`)
     plus worktree-resolve (locate the existing worktree-resolution helper —
     research did not pin an exact call site; check `src/harness/child/*`
     and `src/lib/contained-path.ts` before inventing a new one) — always a
     fresh computation, never restored from a prior `slate.json`.
   - **attemptId** has no prior art anywhere in `src/session/*` (confirmed).
     Recommended design (not mandatory — implementer may deviate with a
     one-line rationale in the journal): mint the archive-time id lazily,
     from the *archival* moment, not the open moment — e.g.
     `new Date().toISOString().replace(/:/g, "-")` — sanitized to satisfy
     `archiveSlate`'s `[A-Za-z0-9._-]+` regex. This avoids inventing a new
     persisted field on the informal `Slate` data contract and avoids
     needing any in-memory "current attempt" tracking that would not
     survive a process crash/restart.
   - **Open logic**: on a detected action-intent, if `readSlate(dir)`
     returns a value (any live `slate.json` is, by construction, an
     *unclosed* prior attempt — a proper close always archives+clears it,
     see below), call `archiveSlate(dir, mintAttemptId())` first, then
     `writeSlate(dir, () => freshSlateWithComputedAnchors)`. This is AC3's
     mechanism, reusing Phase 1's `archiveSlate` unmodified.
   - **Close logic**: on flow-done / explicit close phrase / `/new` / shell
     exit, archive-and-clear the live slate via `archiveSlate` so the next
     open sees no unclosed prior slate. Flow-done detection should reuse
     Course's live Flow projection (see area 2) rather than inventing a
     second Flow-status mechanism.
   - **Fork safety** (AC2): `forkSession()` (`src/session/store.ts:588-626`)
     already never touches `slate.json` (confirmed — `slate` has zero
     references outside `slate.ts`/`slate.test.ts` today). Task is to make
     this explicit and regression-proof: add a `store.test.ts` assertion
     that a forked session dir has no `slate.json` even when the source
     session dir has one, plus a short code comment at the fork boundary
     noting the intentional omission (mirroring `specification.md`'s "No
     code path may special-case fork to carry `slate.json` across").

2. **Course + Seeds** (SLATE-3 feature half, SLATE-4). A `readCourse(dir,
   slate)`-shaped helper that re-derives Course from the live `FwkWork`
   projection (`src/sac/fwk-service.ts`, already has Phase 1's try/catch
   fix — reuse it, do not build a second flow-read path) every time it is
   consulted — never a cached value. `slate.course.flowRef` remains a
   pointer only; nothing here calls `flow complete`. Seeds: an append
   helper on top of `writeSlate` plus a `dedupeSeeds(seeds)` pure function
   doing exact-trimmed-text dedup only (no similarity/embedding model — this
   is itself worth a direct unit test given SLATE-4/AC-23's explicit "no
   embedding model in v1" framing, even though full wrap-up consumption is
   Phase 4).

3. **Unattended checkpoint** (SLATE-8) — security-sensitive, real design
   judgment required, route to the strongest available model. Read the full
   bodies of `ProposalLifecycleService.review()`
   (`src/sac/proposal-lifecycle.ts:122-152` plus constructor `L41-68`),
   `authorizeSacUse` (`src/sac/index.ts:582-590`), `TrustedActorContext`
   (`src/sac/index.ts:548`), `withAuthorizedActor`
   (`src/sac/workspace-service.ts:130`) and `requireAuthorization`
   (`src/sac/workspace-service.ts:330-334`) before implementing —
   research-phase summaries above are navigation aids, not final design.
   Constraints the implementation must satisfy regardless of exact
   placement:
   - Deny only `decision === "accepted"` when `interactive === false`;
     `propose`/`create()` and non-accept (`rejected`) decisions are
     unaffected (AC6).
   - The `interactive` value consumed by the gate must be a parameter
     supplied by the caller at the harness/CLI/MCP boundary — never derived
     from anything the model/agent-controlled proposal or actor input can
     set (AC5's spoofing protection). The only two real call sites of
     `.review(` today are CLI `workspace review`
     (`src/commands/workspace.ts:127`, a human directly at the terminal —
     `interactive: true`) and MCP `tools.ts:138` (spec explicitly names this
     an acknowledged, not-fixed-here gap — pass `interactive: true` there
     too, matching current MCP trust posture; do not silently invent a
     stricter MCP policy this Flow was not scoped to build).
   - Prove the `keryx serve` case (AC4) via a direct unit test constructing
     a review-call context with `interactive: false` — mirroring
     `src/lib/serve-turn.ts`'s own hardcoded `interactive: false` value
     (L592-606) — since no live route today calls `.review(` from a serve
     session (confirmed by research; this is a latent-but-real property to
     lock in, not an end-to-end HTTP test).
   - Add the boolean `--unattended` flag to `src/commands/harness.ts`
     (`ParsedArgs`, `parseArgs()` around L236-294) as a small, separate,
     mostly-mechanical follow-on task: parse-and-store only for this Flow
     (no live `harness run` → `review()` pipe exists yet to wire it into —
     confirmed by research); a parse-correctness test is sufficient
     evidence for this Flow's scope. Must remain a plain boolean, never a
     `--profile <name>` selector (spec's explicit warning against
     conflating the two axes).

4. **Cross-cutting test/AC pass.** After the three implement tasks land,
   run one consolidated pass proving each frozen ACn against a real test:
   AC1 (Anchors always fresh on restart/resume/fork), AC2 (fork empty
   slate), AC3 (unclosed-reopen archives), AC4 (serve-equivalent accept
   denial), AC5 (interactive not self-flippable), AC6 (propose still
   succeeds when accept is denied).

## Risks

- attemptId design has no prior art — implementer discretion is expected;
  the plan's recommendation is not binding, but any deviation must still
  satisfy AC3 without adding a persisted field that breaks Phase 1's frozen
  `Slate` type/tests.
- The exact wiring point for `/new`/shell-exit close in `src/commands/shell.ts`
  was not read this pass — implementer must locate it directly, not guess.
- Worktree-resolve call site for Anchors was not pinned by research —
  implementer must locate it directly (check `src/harness/child/*`,
  `src/lib/contained-path.ts`) rather than inventing a parallel mechanism.
- The interactive-gate placement (`authorizeSacUse` vs `review()` vs both)
  is a genuine design choice with codebase-wide blast-radius implications
  (`TrustedActorContext`/`action` union are used elsewhere) — implementer
  must pick the narrowest change that satisfies AC4-AC6 and document the
  choice in the journal, not widen a shared type/enum without checking
  other callers first.
