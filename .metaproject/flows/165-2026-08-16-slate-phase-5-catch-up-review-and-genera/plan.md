# Implementation Plan

Status: frozen for execution (revise via journal.md if reality diverges; AC
wording itself only changes via `keryx flow ac update`)

## Approach

Four small, mostly-independent primitives (isLockHeld, listProposedProposals/
listVisibleProposedProposals, TerminalState persistence, SessionSummary
fields) converge into one read-only classifier used by two new CLI
subcommands. Built as: shared primitives first (Track A), then the
classifier + CLI (Track B) on top of them, after one shared test-writing
pass. No SAC authorization/review semantics change — everything here is
either a new read-only helper or a new pure-read CLI surface.

### Track A — Shared primitives

1. **`isLockHeld` (`src/lib/fs.ts`)**, next to `withFileLock`. First extract
   the currently-inline `30000` literal (`withFileLock`'s
   `options.staleMs ?? 30000`) into an exported named constant, e.g.
   `export const DEFAULT_LOCK_STALE_MS = 30000;`, and use it as both
   `withFileLock`'s own default and `isLockHeld`'s default — spec's
   "unknown classification" paragraph and this flow's frozen AC5 both
   require reusing "the same `staleMs` threshold `withFileLock`'s own
   stale-lock reclaim already uses", not a second hardcoded number.
   `isLockHeld(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS):
   Promise<boolean>` mirrors `removeStaleLock`'s own staleness logic
   (`fs.ts:96-108`) exactly, read-only:
   - `stat(lockPath)` — ENOENT or any read failure → `false` (not held).
   - `Date.now() - stats.mtimeMs <= staleMs` → `true` (held, not stale).
   - Otherwise (older than `staleMs`): read `owner.json`
     (`readLockOwner`, already private in this file — `isLockHeld` can call
     it directly, same module) and return `true` iff the owner pid is
     alive (`processIsAlive`, also already private/same-module) — mirrors
     `removeStaleLock`'s "an old lock whose owner process is still alive is
     NOT reclaimed" rule. No owner file / unreadable / dead pid → `false`.
   - This function must never mutate/remove the lock directory — it is
     read-only by contract, unlike `removeStaleLock`.

2. **`listProposedProposals`/`listVisibleProposedProposals`
   (`src/sac/proposal-lifecycle.ts`)**, new methods on
   `ProposalLifecycleService` (both need `this.root`/`this.options.workspaces`,
   already private fields on the class):
   - `async listProposedProposals(workspaceId: string): Promise<Proposal[]>`:
     `readdir(path.join(this.root, ".metaproject", "workspaces", workspaceId,
     "proposals"))` (ENOENT → `[]`, matching every other optional-dir read
     in this file), then for each `.json` entry try `JSON.parse` + check
     `recordType === "proposal-created"` (skips `.decision.json`/
     `.approval.json`/`.write-result.json`/`.write-intent.json` sidecars,
     which share the `.json` suffix but have a different `recordType` or a
     dotted id segment — checking `recordType` is more robust than a
     filename regex, since it doesn't need to know every sidecar suffix).
     Then read that workspace's `activity.jsonl` via the existing private
     `records()` helper, collect every `proposal-transition` record's
     `proposalId` where `toStatus` is a `Terminal` value (`accepted |
     rejected | dismissed | stale`), and filter those ids out. Return the
     remaining (non-terminal / still-`"proposed"`) proposals.
   - `async listVisibleProposedProposals(actor: TrustedActorContext):
     Promise<Array<{ workspace: WorkspaceManifest; proposals: Proposal[] }>>`:
     calls the new `workspaces.listForActor({ actorContext: actor,
     includeArchived: true })` (Track A item 3 below) — **hardcoded
     `includeArchived: true`, never a caller-toggle** — then, for every
     visible manifest, `listProposedProposals(manifest.id)`; omit workspaces
     with zero pending proposals from the returned array (an empty
     "proposal" section per-workspace is not itself an item).

3. **`WorkspaceService.listForActor` (`src/sac/workspace-service.ts`)**, new
   method mirroring `showForActor` (`workspace-service.ts:111-122`)'s
   "already-issued `TrustedActorContext`, no `request` re-authentication"
   shape: `async listForActor(input: { actorContext: TrustedActorContext;
   includeArchived?: boolean }): Promise<WorkspaceManifest[]>` — same body as
   `list()` (`workspace-service.ts:84-99`) minus the `requireActor()` call
   at the top (the actor is already trusted/supplied), reusing
   `requireStrict("read")`, the `readdir(storageRoot)` walk, and
   `currentRole()` visibility filter unchanged. `list()` itself is
   unchanged (still the plain request-based entry point every other
   `workspace` subcommand uses) — this is an ADDITIVE actor-based sibling,
   not a signature change.

4. **`TerminalState` persistence (`src/session/slate-terminal-state.ts` +
   `src/commands/agent.ts`)** — the gap found while grounding this flow
   (see description.md). New `writeTerminalState(dir: string, state:
   TerminalState): Promise<void>` in `slate-terminal-state.ts`, using
   `writeFileAtomic` (already imported pattern in `slate.ts`; add the same
   import here) to write `path.join(dir, "terminal-state.json")` — a
   sibling file to `slate.json`, same session dir, so catch-up's per-session
   scan (Track B) finds it the same way it finds `slate-archive/`. This
   module currently has "no dependency on `commands/*`/`harness/*`" per its
   own doc comment — `fs`/`path` are fine (mirrors `slate.ts`'s own
   layering, which already does file I/O). `emitTerminalState`
   (`agent.ts:699-721`) gets ONE new call, `await writeTerminalState(ref.dir,
   state)`, guarded the same way `resolveTerminalStateSnapshots` already
   guards on `options.slateSession`/`ref.opened` (no session dir → no write,
   never throw the turn over a persistence failure — wrap in try/catch,
   matching this file's existing swallow-and-degrade convention at
   `agent.ts:684-686`). No new trigger, no new call site — same one that
   already exists for both the `ask_user`-unanswerable and
   budget-exhausted paths.

5. **`SessionSummary` fields (`src/session/store.ts`)**: add
   `runMode?: "interactive" | "unattended"` and `courseStatus?: "unbound" |
   "active" | "blocked" | "done"` to the `SessionSummary` interface
   (`store.ts:36-52`) and to `readSummaryFile`'s reconstruction
   (`store.ts:187-221`), following the exact same
   `typeof o.field === "string" ? { field: o.field } : {}` optional-spread
   pattern every other optional field already uses — but validate against
   the literal union (not just `typeof === "string"`) so a corrupt/foreign
   value degrades to "field absent" rather than passing through unchecked.
   Nothing writes these fields yet in this flow (no real producer exists —
   `createSession`/whatever future call site sets them is out of scope);
   they exist so catch-up's classifier and a future producer have a place
   to read/write, matching the spec's literal "two new optional fields"
   framing. `keryx sessions list`/any other `SessionSummary` consumer must
   keep working unchanged (purely additive optional fields — verify no
   exhaustive `Object.keys`/strict-shape check elsewhere breaks; `grep` for
   other `SessionSummary` construction/validation sites before assuming
   this is risk-free additive).

### Track B — Classifier + CLI

6. **Evidence-freshness read-only check (`proposal-lifecycle.ts`)**: extract
   a public method, e.g. `async isEvidenceFresh(proposal: Proposal, actor:
   TrustedActorContext): Promise<boolean>`, that runs the SAME hash-compare
   `targetWriteOrStale`/`validateEvidence(evidence, true, actor,
   workspaceId)` already does (`proposal-lifecycle.ts:196`/`258`) but never
   throws and never attempts a write — `true` if every evidence item's
   current content still hashes to its pinned `revision`, `false` on the
   first mismatch or read failure (same "fail toward stale, not toward
   fresh" posture `targetWriteOrStale`'s own `catch` block already takes at
   line 197). This is Track A conceptually (lives in `proposal-lifecycle.ts`
   next to the other new methods) but is listed here because Track B's
   catch-up classifier is its only caller.

7. **Catch-up classifier**, new module (e.g. `src/sac/catch-up.ts`, mirrors
   `machine-wrap-up.ts`'s "new module, `src/commands/workspace.ts` composes
   it" placement) exporting `async buildCatchUp(input: { cwd: string;
   workspaceId?: string }): Promise<CatchUpReport>` where `CatchUpReport`
   groups the spec's `CatchUpItem` union
   (`docs/requirements/slate/specification.md`'s "Data contracts" section)
   into four arrays: `proposals`, `blocked`, `unboundCandidates`, `unknown`.
   Algorithm:
   - **Proposals**: `listVisibleProposedProposals(actor)` (item 2), filtered
     to `input.workspaceId` when given (the `--workspace <id>` flag scopes
     to one workspace, never expands beyond `listVisibleProposedProposals`'s
     own ACL-filtered set — an invisible/invalid `--workspace` id yields an
     EMPTY proposals section, not an error that leaks whether the id
     exists). For each proposal, call `isEvidenceFresh` (item 6) and set
     `fresh: boolean` on the `CatchUpItem` per the spec's shape
     (specification.md line 190) — this is the "re-check before display"
     AC3 requires, not a cached/creation-time value.
   - **Session-derived categories (blocked / unbound-candidate /
     unknown)**: enumerate sessions via `listSessions(cwd)`
     (`src/session/store.ts:368`) — already `cwd`-scoped by construction
     (AC4). **Only consider a session that shows slate engagement** — i.e.
     `slate.json` currently exists in its dir, OR `slate-archive/` has any
     entries, OR the new `terminal-state.json` exists. An ordinary
     interactive session that never opened an action-intent slate at all
     must be silently excluded from every category (never "unknown") —
     dumping every trivial chat session into "unknown" would make the
     unknown section noise, not a real signal, and nothing in the spec asks
     catch-up to enumerate all sessions unconditionally. For each
     slate-engaged session, in this priority order (first match wins —
     these are mutually exclusive per spec, a session cannot BE two
     categories at once):
     1. `terminal-state.json` exists and parses → `"blocked"`, carrying the
        parsed `TerminalState`.
     2. `slate-archive/*-unbound-candidate.json` exists (one or more; the
        newest by filename timestamp if several) → `"unbound-candidate"`,
        carrying `evidencePath`/`summary` per spec's `CatchUpItem` shape.
     3. `isLockHeld(slateLockPath(sessionDir))` (item 1) is `true` → this
        session is still actively running; **exclude it from every
        category entirely** (spec: "still-running and must not appear in
        catch-up at all yet") — this is AC5's actual mechanism, not a
        special-cased "unknown: false" branch.
     4. Otherwise → `"unknown"`, `lastSeenAt: session.updatedAt`.
   - Returns the four arrays as strictly separate fields on `CatchUpReport`
     — never a single merged/interleaved list (AC2's actual data-shape
     guarantee; the CLI formatter in step 8 renders them as four headed
     sections on top of this already-separated shape, so AC2 holds even if
     a future caller consumes the JSON directly without the CLI's text
     rendering).

8. **CLI wiring (`src/commands/workspace.ts`)**: two new subcommands,
   following this file's existing `rejectUnknownOptions`/`optionValue`/
   `service()` conventions exactly (see the `propose`/`review`/`list`
   subcommand bodies as the template):
   - `catch-up [--workspace <id>]`: resolves the actor via
     `localWorkspaceAuthorizationServer().actorContextFor(undefined,
     randomUUID())` (same pattern `propose` already uses at line 110),
     calls `buildCatchUp({ cwd: process.cwd(), workspaceId })`, prints each
     of the four sections under its own heading with a per-item structured
     question + options + recommendation (per agent-protocol.md's "Catch-up
     protocol" — e.g. for a proposal: "Accept, reject, or dismiss
     proposal <id>? Recommendation: <fresh -> review now | stale -> re-run
     wrap-up>"), never a raw JSON/diff dump as the primary human-facing
     output (add `--json` as an escape hatch mirroring other subcommands'
     `JSON.stringify(..., null, 2)` convention, for scripting).
   - `list-proposals [<workspace-id>]`: when `<workspace-id>` given, prints
     `listProposedProposals(workspaceId)` for that one workspace (AC-16:
     "usable standalone, not only as a SLATE-10 internal helper" — reuse
     `listProposedProposals` directly, not the four-category classifier);
     when omitted, prints `listVisibleProposedProposals(actor)` across every
     visible workspace (still `includeArchived: true`, AC1). No staleness
     re-check here (that is catch-up's own AC3 concern per spec's SLATE-13
     row framing it as a plain listing, not a review surface) — keep this
     command simple and fast.
   - Update `printHelp()` with both new usage lines, matching this file's
     existing single-string-concatenation convention.

## Steps

1. tests-creator (Sonnet — the four-category hard-separation invariant and
   the freshness-recheck/isLockHeld-priority-ordering logic both need real
   design judgment to test correctly, not mechanical mirroring): write
   failing tests for AC1-AC5, covering:
   - AC1: a proposal in an ARCHIVED workspace appears in both `catch-up` and
     `list-proposals` output identically to one in an active workspace.
   - AC2: catch-up's returned shape has four always-present, never-merged
     array fields; a structural/negative test that the CLI's rendered text
     output has four distinct headed sections with no cross-section item.
   - AC3: a proposal created fresh, then its pinned evidence file mutated
     on disk afterward (simulating drift), shows `fresh: false`/`stale`
     BEFORE any `review`/accept call is ever made — not only discoverable
     via `targetWriteOrStale`'s existing accept-time path.
   - AC4: `catch-up`/`list-proposals` invoked from cwd A never surface a
     proposal/session that only exists under cwd B (two separate temp
     project roots in the test).
   - AC5: a session with a currently-held (fresh-mtime) lock on its
     `slate.json.lock` — simulate via `withFileLock` still holding when
     catch-up runs concurrently, or a directly-created lock dir with a live
     pid/owner.json and fresh mtime — never appears in ANY of catch-up's
     four categories, specifically never `unknown`. A second test for the
     STALE-lock-with-dead-owner case: it DOES fall through to a real
     category (blocked/unbound-candidate/unknown per whatever else is on
     disk), proving `isLockHeld` distinguishes live-vs-crashed, not just
     "lock dir exists".
   - Plus: `isLockHeld` unit tests (fresh lock / stale+dead-owner / stale+
     alive-owner / no lock dir), `listProposedProposals` unit tests
     (terminal-filtered correctly, sidecar files never misidentified as
     proposals), `listForActor` visibility parity test against `list()`'s
     existing ACL behavior (same members see the same set, `includeArchived`
     toggles identically), and a `writeTerminalState`/`emitTerminalState`
     integration test asserting the file actually lands on disk at the real
     call site (not just the new function in isolation — this is exactly
     the "verify by grep, not assumption" class of check the launch brief
     calls out).
2. task-implementer (Sonnet): Track A — isLockHeld, listProposedProposals/
   listVisibleProposedProposals, listForActor, TerminalState persistence,
   SessionSummary fields.
3. task-implementer (Sonnet — the four-category classification priority
   order and the "only slate-engaged sessions" filter are real design
   judgment, not mechanical wiring): Track B — isEvidenceFresh, the
   catch-up classifier module, and the two new `workspace.ts` subcommands.
4. code-verifier (scoped: touched files + typecheck + `health run --changed`
   during iteration, one full-suite run right before PR per the speed
   instruction) + review-orchestrator internal pass; fix loop.
5. One full-suite `bun test` sanity check immediately before PR.
6. Draft PR against `main`, `/code-review` high effort, fix findings, CI
   green, mark ready, merge (normal merge commit, keep branch), AC confirm,
   flow complete, bookkeeping PR.

## Risks

- **`readdir` over `proposals/` returning sidecar files.** Filenames like
  `<id>.<hash>.decision.json` share the `.json` suffix with real proposal
  files (`<id>.json`) but are NOT proposals. Filtering by parsed
  `recordType === "proposal-created"` (rather than a filename regex) is the
  robust fix — a regex would need to know every current AND future sidecar
  suffix shape, while `recordType` is validated by `validateSacContract`
  already. A malformed/partial JSON file (a crash mid-write, though
  `writeFileAtomic` should prevent this in practice) must be skipped, not
  thrown — this is a listing/discovery path, not a load path, so a lenient
  per-file `try/catch` continue is correct here (contrast with
  `loadProposal`, which legitimately DOES throw on a single known id's bad
  JSON).
- **`listForActor` visibility drift from `list()`.** Since it is a near-copy
  of `list()`'s body, a future edit to `list()`'s filter logic could
  silently NOT propagate to `listForActor` (or vice versa) if the two stay
  fully duplicated. Consider extracting the shared "enumerate storageRoot,
  parse each manifest, filter by role+archived" loop into one private
  helper both `list()` and `listForActor()` call, rather than duplicating
  the loop body — cheaper to keep in sync and the test in step 1
  (visibility-parity) will catch drift either way.
- **`terminal-state.json` collides with nothing today** — confirmed by
  reading `slate.ts`'s `slatePath`/`slateLockPath`/archive-dir naming; no
  existing file in a session dir uses this name. Still worth a
  belt-and-suspenders check in the implementing task: grep for
  `"terminal-state"` before adding the constant, in case a parallel branch
  landed something with the same name.
- **`isLockHeld` reading `owner.json` while `withFileLock` is mid
  acquisition.** `withFileLock`'s own `mkdir(lockPath)` then
  `writeFile(ownerPath, ..., { flag: "wx" })` is not atomic as a pair — a
  narrow window exists where the lock dir exists but `owner.json` does not
  yet. `readLockOwner`'s existing `try/catch -> undefined` already handles
  a missing/unparseable owner file by falling through to "no owner info",
  which `isLockHeld`'s spec (mirroring `removeStaleLock`) then treats as
  "not verifiably alive" — but ONLY once the lock is already past
  `staleMs` age (fresh-age locks return `true`/held unconditionally,
  before ever consulting the owner file at all) — so this narrow window
  cannot produce a false "not held" while a fresh lock is genuinely being
  acquired.
- **Speed tradeoff (explicit, per launch brief):** internal iteration skips
  the full-repo double-suite stash/baseline/restore ceremony; only one full
  `bun test` runs, right before PR. If it surfaces unrelated failures, the
  known pre-existing flaky set (`serve-server.test.ts`,
  `project-registry.test.ts`, `sessions.fork.test.ts`,
  `config-dir.readers.test.ts` — macOS path-symlink and port-binding races)
  is treated as a quick sanity match, not re-investigated from scratch.
- **This is the final phase of the whole slate feature** — per the launch
  brief, a genuinely careful final pass, not a rushed one. The
  TerminalState-persistence gap found during grounding is exactly the kind
  of thing a rushed pass would miss; budget real review time for it
  specifically (does the write actually happen on both the ask_user AND
  budget-exhausted paths, not just one; does a write failure ever throw the
  turn).
