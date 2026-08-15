# Context

Collected deterministically by `keryx flow init` at 2026-08-15T22:34:47.032Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

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

Required reading (already done by orchestrator, re-read by task-implementer
before touching code): `docs/requirements/slate/specification.md` (whole
file, focus SLATE-1/2/2a/3/3a/4/12/14 sections + AC-1/AC-2/AC-12/AC-17/AC-22),
`docs/requirements/slate/agent-protocol.md` (whole file, short),
`docs/requirements/slate/phase-execution-prompts.md` §1.

Exact current-code touch points confirmed by direct read on this worktree's
`main`-derived checkout:

- `src/lib/fs.ts`: `withFileLock<T>(lockPath, fn, options)` (line 36) —
  mkdir-based lock dir with owner token + heartbeat + stale-lock reclaim;
  `writeFileAtomic(filePath, content)` (line 23) — temp+rename. Both already
  used by `proposal-lifecycle.ts` (`${file}.lock` convention) — `slate.ts`
  should follow the same convention (`${slate.json path}.lock`).
- `src/session/paths.ts`: `sessionDir(projectPath, sessionId, dataDir?):
  string` (line ~97) — the existing per-project session directory
  `slate.ts` writes its sibling `slate.json` into. `slate.ts` itself should
  take an already-resolved `dir: string`, not re-derive it.
- `src/sac/proposal-lifecycle.ts`:
  - Line 17: `Proposal` type — `security: { gate: "pass" | "needs-approval";
    redacted: true; policyRef: string; policyRevision: string }`.
  - Line 59: `ProposalLifecycleService.create()` — the literal
    `security: { gate: "pass", ... }` to replace with a real scan result.
    Evidence available as `input.wrapUp.evidence` (`Evidence[]`, each
    `{kind, uri, revision, observedAt}`).
  - Line 179: `validateEvidence()` — its non-revision branch already shows
    the correct content-resolution pattern:
    `resolveWorkspaceReference({ workspaceRoot: this.root, kind: item.kind
    as "evidence", uri: item.uri })` (from `src/sac/index.ts:534`) returns
    an absolute, containment-checked path — read that path's content for
    the security scan rather than going through
    `workspaces.readEvidenceAtUse` (which requires `action: "review"`
    authorization that `create()`'s actor, authorized for `"write"`, may
    not hold).
  - Lines 205-206: the misleading comment immediately above
    `createLocalProposalLifecycleService` (line 207) — confirmed via
    `grep` that `src/commands/workspace.ts` and `src/mcp/tools.ts` both
    import and call only `createHarnessProposalLifecycleService`, never
    `createLocalProposalLifecycleService`.
  - Other `security.gate: "pass"` literals NOT in scope this phase: line
    140 (`transition()`'s acceptance record), line 170
    (`ensureWriteIntent()`), line 183 (`reviewDecision()`) — all record a
    policy-gate decision at accept-time, not the evidence-content scan
    SLATE-12/AC-12 target (which is specifically the proposal's own
    `security.gate` set at `create()`).
- `src/sac/fwk-service.ts`:
  - Line 571: `createLocalFwkReadService(cwd): FwkReadService`.
  - Lines 596-601: the `work` resolution IIFE inside its `source`
    composition — `flow ? await (async () => { const raw = await
    workspaces.readResourceForActor(...); const snapshot = JSON.parse(raw)
    as {...}; ... })() : undefined` — currently has no try/catch. Both the
    `readResourceForActor` call and the `JSON.parse` can throw
    (deleted/permission-denied file; malformed JSON respectively).
  - Line 500 (`FwkReadService.resolve()`): `const work = source.work?.flowRef
    ? { state: "bound" as const, ...source.work } : { state: "unbound" as
    const };` — already correctly treats `source.work === undefined` as
    `unbound`. No change needed here; only the `work` IIFE inside
    `source()` needs the try/catch, returning `undefined` on any failure.
  - Line 486-495 (`resolve()`'s outer try/catch around `this.options.source(...)`)
    only re-maps `WorkspaceServiceError` with codes `access_denied`/
    `not_found`/`invalid_reference` to a `denied` result — it does NOT
    catch a generic read error or `JSON.parse` throw from inside the `work`
    IIFE, confirming the uncaught-throw defect is real today.
- `src/security/detect/secrets.ts` line 100: `detectSecrets(content:
  string): DetectorMatch[]`. `src/security/detect/pii.ts` line 213:
  `detectPii(content: string): DetectorMatch[]`. Both synchronous, take
  plain text content (not a file path).

Parallel branch note: `feat/sac-workspace-lifecycle-phase1` (PR #296, not
yet merged into `main`) also touches `proposal-lifecycle.ts` (adds
`archive`/`removeResource`/`rename` guards + `guard_denied` on `create()`).
This worktree's branch was created from `main` before that PR, so none of
those changes are present here — expected and not this flow's concern; any
merge conflict is resolved by a human at merge time.
