# Plan

Status: frozen

## Approach

Four independent, additive changes. No shared risk between them beyond
touching two files (`proposal-lifecycle.ts` gets two of the four changes).

1. **New file `src/session/slate.ts`.**
   - Informal `Slate` type per spec's data contract (all fields present even
     though only storage is exercised this phase):
     `{ workspaceId?, anchors: { root, tree?, runtime?, touched, fence? },
     course: { flowRef? }, seeds: [...], childDispatches?: {...} }`.
   - `slatePath(dir)` → `path.join(dir, "slate.json")`; lock path
     `` `${slatePath(dir)}.lock` `` reusing `withFileLock`
     (`src/lib/fs.ts`), same convention as `proposal-lifecycle.ts`'s
     `${file}.lock`.
   - `readSlate(dir): Promise<Slate | undefined>` — plain read, `undefined`
     on ENOENT (mirrors `proposal-lifecycle.ts`'s `isNotFound` pattern).
   - `writeSlate(dir, update: (prev: Slate | undefined) => Slate):
     Promise<Slate>` — the *entire* read-modify-write happens inside one
     `withFileLock` hold, so a second same-turn writer's `update` always
     runs against the first writer's already-committed value, never a
     stale read from before the lock was acquired. This is what makes the
     "second writer never loses data to a race" AC hold — a naive
     `write(dir, value)` API without an in-lock read cannot satisfy it.
   - Archive-on-close primitive (name it `archiveSlate` or similar):
     under the same lock, if `slate.json` exists, move it to
     `slate-archive/<attemptId>.json` (mkdir the archive dir first) and
     remove the live file — using `writeFileAtomic` from `src/lib/fs.ts`
     for the archive write, plain `rm` for the removal so a mid-crash never
     leaves both files claiming to be current. No-op (not an error) if no
     `slate.json` exists yet.
   - Use `sessionDir()` from `src/session/paths.ts` at call sites/tests only
     — `slate.ts` itself takes a plain `dir: string` (the already-resolved
     session dir), matching how `proposal-lifecycle.ts` takes `cwd`/`root`
     rather than re-deriving paths.

2. **`src/sac/proposal-lifecycle.ts` — SLATE-12 (AC-12).**
   In `ProposalLifecycleService.create()`, before building the persisted
   `Proposal` object (currently line 59's `security: { gate: "pass", ... }`
   literal), scan the evidence: for each `input.wrapUp.evidence` entry,
   resolve its content and run `detectSecrets`/`detectPii`
   (`src/security/detect/secrets.ts`, `.../pii.ts`, both synchronous
   `(content: string) => DetectorMatch[]`). Resolve content the same way
   `validateEvidence`'s non-revision branch already resolves the reference
   (`resolveWorkspaceReference({ workspaceRoot: this.root, kind: "evidence",
   uri })` → absolute path), then read that file as utf8 text and run both
   detectors. `gate: matches found anywhere ? "needs-approval" : "pass"`.
   Do this scan before the object literal is constructed (or thread the
   computed gate value in) so the literal `"pass"` is genuinely computed,
   not merely relabeled. Non-text/unreadable evidence content should not
   crash `create()` — treat a read failure on an individual evidence item
   defensively (documented decision, not a silent swallow of a real
   detector failure) since evidence containment is already validated
   separately by `validateEvidence`.
   Leave the other three `security.gate: "pass"` occurrences
   (`transition()`, `ensureWriteIntent()`, `reviewDecision()`) untouched —
   out of scope per description.md.

3. **`src/sac/proposal-lifecycle.ts` — SLATE-14 (AC-17).**
   Rewrite the comment above `createLocalProposalLifecycleService`
   (currently: "Local CLI/stdin MCP composition has no owning knowledge
   writer, so it can record proposals and non-accepting decisions but can
   never self-accept.") to state accurately that `src/commands/workspace.ts`
   and `src/mcp/tools.ts` never actually construct this composition — both
   exclusively call `createHarnessProposalLifecycleService` — so this
   function is not itself a self-accept protection in the real request
   path; note what it evaluates to today (fail-closed local owner-writer
   adapters) without claiming a guarantee the live code doesn't enforce.

4. **`src/sac/fwk-service.ts` — SLATE-3 bundled fix (AC-2).**
   In `createLocalFwkReadService`'s `source` composition, the `work`
   resolution (`const work = flow ? await (async () => {...})() : undefined`,
   reading the flow resource then `JSON.parse`-ing it) has no try/catch.
   Wrap it so any failure (read error from `readResourceForActor`,
   `JSON.parse` throw on malformed content) yields `work = undefined`
   deterministically — which already flows correctly into
   `FwkReadService.resolve()`'s `work.state === "unbound"` branch (line
   ~500: `source.work?.flowRef ? {state:"bound",...} : {state:"unbound"}`).
   No change needed downstream of `source()` — only the try/catch inside
   the `work` IIFE itself.

## Steps

1. T1 (context): confirm the four exact touch points above still match
   current `main`-derived code (line numbers may drift slightly).
2. T2 (implement): land all four changes.
3. T3 (test): add/adjust tests proving AC-1 (fork not in scope this phase,
   skip), AC-2 (flow-read failure → `unbound`, never throws), AC-12
   (`security.gate` reflects a real scan — both a clean-evidence case
   staying `"pass"` and a secret/PII-bearing evidence case flipping to
   `"needs-approval"`), AC-17 (comment no longer present/asserts the wrong
   thing — can be a lint-style string-absence test or a doc-level review
   note if no existing test file targets comments), plus `slate.ts`'s own
   direct unit coverage: concurrent-writer RMW race (AC scoped to Phase 1's
   own acceptance criteria, not a numbered spec AC) and archive-before-first-write.
4. T4 (review): code-verifier + review-orchestrator; fix findings; report.

## Risks

- `security.gate` scan touches a hot proposal-creation path used by real
  `workspace propose` — must not change the `Proposal`'s schema shape
  (still `"pass" | "needs-approval"`) or break `validateSacContract`
  (`workspace-proposal` schema) validation already run right after
  construction (`this.validateProposal(proposal)`).
- `fwk-service.ts`'s fix must not swallow errors that are not actually
  flow-read failures (e.g. keep `WorkspaceServiceError` `access_denied`
  handling at the outer `resolve()` try/catch untouched — only wrap the
  narrower `work` IIFE).
- Evidence content read for scanning must respect the same containment
  guarantees `resolveWorkspaceReference` already enforces — never read
  outside the resolved path.
