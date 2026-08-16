# Flow Journal

- 2026-08-15T22:34:47.121Z - flow created
- 2026-08-15T22:37:24.299Z - frozen: 5 criteria; checksum recorded
- 2026-08-15T22:37:34.272Z - started
- 2026-08-15T22:37:47.215Z - task-done: T1: Collect remaining context
- 2026-08-15T22:44:46.675Z - task-done: T2: Implement per plan
- T2 worker reported DONE_WITH_CONCERNS. Concern: `scanEvidenceSecurityGate`
  (proposal-lifecycle.ts) treats a read/resolve failure on an individual
  evidence item as "nothing scannable" for that item (continue) rather than
  auto-escalating the whole proposal to `needs-approval`, since escalating
  on every unreadable/binary item would make a missing/binary evidence file
  indistinguishable from a real secret/PII finding, and `validateEvidence()`
  already separately guards containment/existence right after this call.
  Orchestrator review: verified the diff directly (proposal-lifecycle.ts,
  fwk-service.ts, slate.ts) — this interpretation matches AC3's stated scope
  (behavior for readable evidence with/without a match), and the JSDoc on
  `scanEvidenceSecurityGate` documents the choice inline. Accepted as-is;
  flagged to tests-creator/review to confirm no test expects escalate-on-
  read-failure semantics. `bun run typecheck` confirmed clean independently
  by orchestrator (tsc --noEmit, no output).
- 2026-08-15T22:51:51.014Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-15T23:18:58.213Z - task-done: T4: Self-review and prepare draft PR
- review-orchestrator round 1: REQUEST_CHANGES. 1 blocker (F-001:
  `scanEvidenceSecurityGate` scanned unpinned/unverified evidence content —
  a swap-clean-then-restore-secret race around `create()` could get
  `security.gate: "pass"` recorded for evidence that, read via its pinned
  `revision`, actually contains a secret), 2 majors (F-002: `isNotFound`
  triplicated across `workspace-service.ts`/`proposal-lifecycle.ts`/
  `slate.ts` instead of shared; F-003: AC3 test coverage never exercised
  the `detectPii` half of the gate's `||` condition, only `detectSecrets`),
  7 minor/5 info findings (see review agent a8c9a73cc695b5bae's full report
  for F-004..F-015 — accepted as documented follow-ups, out of Phase 1's
  frozen AC scope: SlateSeedKind type duplication (F-006), slate.json
  JSON.parse-corruption not handled the same way fwk-service's was (F-004),
  etc.).
- Remediation dispatched (task-implementer): fixed F-001 (revision-pinning
  hash check before trusting a scan result — mismatch escalates to
  "needs-approval" without consulting detectors; also switched the evidence
  read from plain `readFile` to the codebase's existing safe
  `readWorkspaceFileNoFollow`, closing a secondary TOCTOU/symlink note),
  F-002 (hoisted `isNotFound` to `src/lib/fs.ts`, all three call sites now
  import it), plus two cheap opportunistic fixes: F-005 (`archiveSlate`'s
  `attemptId` now validated against a safe-token pattern, throws on an
  invalid caller-supplied value) and F-008 (inline comment at the per-item
  catch site). Orchestrator independently verified every diff by direct
  read (not just trusting the worker's report) — confirmed correct and
  minimally scoped. `bun run typecheck` clean; 47/47 targeted tests green.
- Remediation dispatched (tests-creator): closed F-003 — added a test
  isolating the `detectPii` branch (email-shaped PII content, no secret
  pattern, revision correctly pinned) — and a regression test for the F-001
  fix proving the exact swap-back exploit scenario now resolves to
  "needs-approval" instead of "pass". Orchestrator independently verified
  the diff and re-ran the full targeted suite: 49/49 tests green, typecheck
  clean.
- `keryx health run`: PASS, project score 93 (stable), 0 gate conditions
  triggered.
- Orchestrator decision: F-004/F-006/F-007/F-009/F-010/F-014/F-015 (minor/
  info, not named by this flow's frozen ACs) left as documented follow-ups
  for Phase 2+ rather than expanding this flow's scope further — see final
  completion report to the calling agent for the full list.
- Stopped after Phase 3 (verification + review + remediation) per explicit
  instruction from the calling agent: no PR created, `keryx flow
  implemented`/`flow complete` not run, AC confirmation not run (Phase 5 is
  downstream of the stop point). Flow left `in-progress`.
- 2026-08-15T23:51:12.467Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/297
- 2026-08-16T10:33:13.768Z - task-added: T5: Fix finding 1+4: scanEvidenceSecurityGate fail-open on platform-unavailable read; replace detectSecrets/detectPii with guardOutput()
- 2026-08-16T10:33:21.418Z - task-added: T6: Fix finding 3: close TOCTOU window between security gate scan and writeFileAtomic in proposal-lifecycle create()
- 2026-08-16T10:33:32.394Z - task-added: T7: Fix finding 2: narrow fwk-service.ts local flow-read catch so access_denied propagates as full denial, not partial unbound disclosure
- 2026-08-16T10:33:39.551Z - task-added: T8: Add regression tests for all 4 findings and verify typecheck/tests/health
- 2026-08-16T10:33:47.527Z - task-done: T5: Fix finding 1+4: scanEvidenceSecurityGate fail-open on platform-unavailable read; replace detectSecrets/detectPii with guardOutput()
- 2026-08-16T10:33:47.610Z - task-done: T6: Fix finding 3: close TOCTOU window between security gate scan and writeFileAtomic in proposal-lifecycle create()
- 2026-08-16T10:33:47.698Z - task-done: T7: Fix finding 2: narrow fwk-service.ts local flow-read catch so access_denied propagates as full denial, not partial unbound disclosure
- 2026-08-16T10:37:41.859Z - task-done: T8: Add regression tests for all 4 findings and verify typecheck/tests/health
- Independent code-review round 2 on PR #297 raised 4 new findings, fixed in
  this pass:
  - F1 (critical, src/sac/proposal-lifecycle.ts `scanEvidenceSecurityGate`):
    a blanket `catch { continue }` around the evidence read also swallowed
    `readWorkspaceFileNoFollow`'s "safe descriptor source reads are
    unavailable on this platform" error (secure-resource-read.ts's
    documented fail-closed contract), silently degrading to `"pass"` on
    hosts without the Bun/POSIX FFI bridge (Windows, musl/Alpine). Fixed:
    that one error message is now distinguished (`isPlatformUnavailableSecureReadError`)
    and escalates straight to `"needs-approval"`; every other per-item
    read/resolve failure still falls through to "nothing scannable", as
    before.
  - F4 (src/sac/proposal-lifecycle.ts, tied to F1): `scanEvidenceSecurityGate`
    called `detectSecrets`/`detectPii` directly instead of the shared
    `guardOutput()` write seam (src/security/guard.ts) every other guarded
    owner-writer (wiki/memory/skill) already runs. Fixed: evidence content is
    now scanned through `guardOutput()` (full `runDetectors`/`runDetectorsAsync`
    pipeline — secrets/entropy/PII/prompt-injection/egress — and respects
    `config.policies.*.enabled`), escalating on `guard.decision.findings.length
    > 0` (not `.gate`/`.allowed`, which are weighted by each policy's
    configured `action` and would let the default "redact" PII policy pass
    through undetected) — preserving the exact "any detector match escalates"
    contract this method has always had, now over a strict superset of
    categories. `target: "unknown"` used (documented inline) since evidence
    isn't bound for any of SecurityTarget's real destinations.
  - F3 (src/sac/proposal-lifecycle.ts `create()`): `security.gate` used to be
    computed at the top of `create()`, long before authorization, workspace
    lock acquisition, wrap-up consumption, and the proposal-already-exists
    check — a TOCTOU window an evidence swap could sail through unscanned.
    Fixed: the scan now runs immediately before `writeFileAtomic`, inside the
    already-acquired file lock.
  - F2 (src/sac/fwk-service.ts, local flow-read IIFE inside
    `createLocalFwkReadService`): its local `catch` swallowed ANY error from
    `workspaces.readResourceForActor`, including `WorkspaceServiceError`
    `access_denied` thrown by a role revoked between manifest read and
    resource re-authorization-at-use — silently downgrading a full
    authorization denial into a partial disclosure (facts/knowHow still
    returned, only `work` hidden as "unbound"). Fixed: the local catch now
    only swallows content-class failures (not_found/invalid_reference/
    malformed JSON); `access_denied` re-throws and propagates to
    `FwkReadService.resolve()`'s existing catch, which already maps it to a
    full `denied()` receipt.
  - Test seams added to support regression coverage without needing a real
    non-POSIX host or a second process: `ProposalLifecycleService`'s
    `readEvidenceFile`/`beforeCreateWrite` (constructor options), and
    `createLocalFwkReadService(cwd, opts?)`'s `beforeResourceOpen` passthrough
    to its internal `WorkspaceService`.
  - New regression tests (6 total): platform-unavailable → needs-approval;
    ordinary read failure → still "nothing scannable"; guardOutput genuinely
    wired (disabling `modules.security` makes secret-shaped evidence resolve
    to "pass", which a private detector call could not produce); TOCTOU
    window closed (evidence swapped via `beforeCreateWrite` is scanned
    fresh, not using a stale pre-lock result); and access_denied propagates
    as a full `denied()` receipt (not partial "work: unbound") when an
    actor's role is revoked strictly between a resource's two
    re-authorization checks.
  - `proposal-lifecycle.test.ts`'s `setup()` now writes a `.metaproject/
    metaproject.json` enabling the security module — required for
    `guardOutput()` to actually run detectors instead of no-op'ing; without
    it the existing PII-detection test would silently test nothing.
  - Side fix: `keryx flow task add 157 --kind fix` (as instructed) was
    accepted uncritically by the CLI (`--kind` is cast, not validated) but
    "fix" is not in `TaskKind`'s schema enum (context/implement/test/verify/
    review/docs), which broke `flowStateSchema validates EVERY on-disk
    flow.json`. Corrected T5-T8's `kind` to `"implement"` directly in
    flow.json/tasks.md (no CLI command exists to edit a task's kind after
    add) — this only touches non-frozen task metadata, not `acChecksum`/
    `acConfirmed`.
  - Verification: `bun run typecheck` clean; targeted suite
    (`proposal-lifecycle.test.ts` + `fwk-service.test.ts` +
    `proposal-lifecycle-parity.test.ts`) 44/44 green; `src/sac` + `src/security`
    247/247 green; `keryx health run` PASS (score 93, 0 gate conditions). A
    full repo-wide `bun test` run also surfaced pre-existing, unrelated
    failures in `src/commands/sessions.fork.test.ts` and
    `src/commands/serve.process.test.ts` (session-fork store/process-port-
    binding flakes) — confirmed unrelated: neither file is touched by this
    change (`git status` scope: proposal-lifecycle.ts/.test.ts,
    fwk-service.ts/.test.ts, and this flow's own bookkeeping only).
  - Left uncommitted per instruction: calling agent reviews and commits.
