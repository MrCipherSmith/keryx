# Flow Journal

- 2026-08-15T21:42:48.961Z - flow created
- 2026-08-15T21:44:10.643Z - task-done: T1: Collect remaining context
- 2026-08-15T21:44:12.958Z - frozen: 10 criteria; checksum recorded
- 2026-08-15T21:44:17.737Z - started
- 2026-08-15T21:49:04.309Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-15T21:57:21.147Z - task-done: T2: Implement per plan
- 2026-08-15T22:07:17.902Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-15T22:15:32.472Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/296
- 2026-08-16T10:13:32.700Z - task-added: T5: Fix1: --include-archived=value silently ignored in keryx workspace list
- 2026-08-16T10:13:32.783Z - task-added: T6: Fix2: decide/document archive() re-archive idempotency
- 2026-08-16T10:13:32.908Z - task-added: T7: Fix3: refactor removeResource to use withAuthorizedActor
- 2026-08-16T10:13:33.056Z - task-added: T8: Fix4: extract shared owner-role gate (workspace-service + collaboration-service)
- 2026-08-16T10:13:33.158Z - task-added: T9: Fix5: evaluate centralizing archived-write guard; document decision
- 2026-08-16T10:13:33.302Z - task-added: T10: Fix6: evaluate archive/rename dedup into shared helper; document decision
- 2026-08-16T10:13:33.409Z - task-added: T11: Fix7: reduce redundant manifest reads in withAuthorizedActor

## Independent code-review fixes (PR #296)

Fixes for 7 findings from an independent review of the already-implemented
WSL-1..4 work. Details per finding:

**Fix1 (T5, real bug).** `src/commands/workspace.ts` `list` read
`args.includes("--include-archived")`, matching only the bare spelling.
`--include-archived=true` (the natural spelling given every other option in
this file goes through `optionValue`'s `=` form) silently behaved as "flag
absent" — archived workspaces stayed hidden, no error. Same bug class as the
`--runtime=cursor` incident documented in `optionValue`'s doc comment
(`src/lib/args.ts`). Fixed with a new `booleanFlag()` helper in workspace.ts:
accepts bare `--include-archived`, `--include-archived=true`,
`--include-archived=false`; any other value (`=maybe`, or both bare+`=` given
together) is an explicit thrown error, not a silent fallback — chosen because
there was no existing boolean-flag precedent in this file to match, and the
instruction was "explicit error on unrecognized, not silent default" absent a
precedent. New CLI test in `src/commands/workspace.test.ts` covers bare,
`=true`, `=false`, absent, and the `=maybe` rejection.

**Fix2 (T6, decision: intentional, not a bug).** `WorkspaceService.archive()`
re-archiving an already-archived workspace was flagged as possibly needing an
`addResource`-style `conflict` guard. Decision: **leave as idempotent,
no guard added.** `docs/requirements/sac-workspace-lifecycle/
specification.md` WSL-1 prescribes archive's literal implementation as
`{...manifest, status: "archived", updatedAt: ...}` with no precondition on
prior status. Archive's lifecycle is one-way (`active -> archived`, no
delete, no un-archive per the spec's "Delete is explicitly out of scope"
section) — re-issuing the same terminal state is a no-op in effect, unlike
`addResource`'s duplicate-URI conflict, where a second call would silently
discard the caller's `revision` field (a real data-loss risk that duplicate
archive calls don't share). Documented this reasoning as a doc comment on
`archive()` in workspace-service.ts, and added a test
("archive is intentionally idempotent...") asserting: second call succeeds,
status/id/title/resources/members unchanged, only `updatedAt` moves.

**Fix3 (T7).** `removeResource` manually duplicated `withAuthorizedActor`'s
readManifest/requireAuthorization/lock/re-authorize sequence instead of
calling the helper, unlike `archive`/`rename` in this same PR. Refactored to
call `withAuthorizedActor({ action: "write", execute: ... })`, matching
`archive`/`rename`'s shape exactly. No behavior change — the manual sequence
was already structurally identical to what the helper does.

**Fix4 (T8).** `requireOwner`'s inline role check
(`workspace-service.ts`) and the identical inline check in
`collaboration-service.ts`'s `record()` both did
`members.find(m => m.subject === subject)?.role !== "owner"`. Extracted to
`isWorkspaceOwner(members, subject)` in `src/sac/index.ts` (next to the other
shared SAC primitives — `authorizeSacUse`, `evaluateStrictSacGuard`, etc.),
typed against a minimal structural `SacMemberRole` so it doesn't need to
import `WorkspaceManifest`. Both call sites now delegate to it.

**Fix5 (T9, decision: leave as-is, documented risk).** The archived-status
write guard (`if (manifest.status === "archived") throw ...`) is duplicated
inline in `addResource` (workspace-service.ts) and
`ProposalLifecycleService.create()` (proposal-lifecycle.ts). Evaluated
centralizing it into `withAuthorizedActor`/`requireAuthorization`. **Decision:
do not centralize** — `withAuthorizedActor` is also the plumbing for
`ProposalLifecycleService.review()` (action: "review"), which the spec
(WSL-1: "`review()` of already-existing proposals is untouched — not gated
on archived status") and existing tests require to stay ungated on archived
status. It's also now the plumbing for `rename`/`removeResource`
(post-Fix3), which today are *not* archived-gated either, and centralizing
without an explicit opt-in flag would silently start gating them too. Adding
an opt-in flag was considered but rejected as more machinery than the
duplication it removes, for two call sites. Instead: added an explicit
"KNOWN RISK" comment at both inline checks, cross-referencing each other and
warning that a new write operation must add this guard itself since it is
not automatic — same content requested for the PR description.

**Fix6 (T10, decision: leave as two explicit methods).** `archive`/`rename`
were flagged as near-identical copy-paste, candidate for a parameterized
`updateOwnedField` helper. Decision: **do not merge.** The two methods differ
in exactly which field they touch (`status: "archived"` — a fixed constant —
vs `title: input.title` — user input, which also needs its own validation
surface if e.g. length/emptiness rules are added later). A generic mutator
parameter (`(manifest) => Partial<WorkspaceManifest>` or similar) would save
~4 lines total across two ~13-line methods while making it one level harder
to see, at a glance, exactly what each operation writes — worse for a
security-sensitive owner-only mutation path where "what does this actually
change" should be obvious from the method body alone. `addResource`/
`removeResource` in the same file already favor this explicit-per-operation
style over a generic mutator, so keeping `archive`/`rename` explicit is also
the locally consistent choice.

**Fix7 (T11).** `withAuthorizedActor` read the manifest from disk up to 4
times per call (pre-lock: once directly, once inside
`requireAuthorization`'s `resolveCurrentRole`; inside the lock: once
directly as `manifest`, once again inside `authorizeAtUse`'s `resolve`
callback). Fixed only the redundant *in-lock* read: `authorizeAtUse`'s
resolve callback now reuses the `manifest` already read at the top of the
locked section instead of re-reading. This is safe with no TOCTOU change:
`withFileLock` (`src/lib/fs.ts`) is a cross-process `mkdir`-based exclusive
lock held for the full duration of the callback, so no writer can race
between the two reads inside it — a second read there is guaranteed
byte-identical, not fresher. Left the **pre-lock** double-read
(`initial` + `requireAuthorization`'s internal read) untouched: combining
those would mean changing `requireAuthorization`'s shared signature, which is
also called from `showForActor`, `resolveResourceForActor`, and
`reauthorizeAtUse` with different manifest-flow shapes — not a "simple,
safe" change for an efficiency-only finding. Also deliberately left
`reauthorizeAtUse`/`resolveResourceForActor`'s own re-reads untouched: those
run with **no lock held** (they're read paths), so their re-read genuinely
protects against a real TOCTOU window and removing it would be a regression,
not a cleanup — documented this distinction in a comment at the fixed site.

**Verification:** `bun run typecheck` clean. `bun test src/sac
src/commands/workspace.test.ts --timeout 30000`: 134+35 pass (workspace-service.test.ts,
workspace.test.ts, collaboration-service.test.ts, proposal-lifecycle*.test.ts
all green, including 2 new tests). `keryx health run`: PASS, score 93.
- 2026-08-16T10:17:25.621Z - task-done: T5: Fix1: --include-archived=value silently ignored in keryx workspace list
- 2026-08-16T10:17:25.709Z - task-done: T6: Fix2: decide/document archive() re-archive idempotency
- 2026-08-16T10:17:25.783Z - task-done: T7: Fix3: refactor removeResource to use withAuthorizedActor
- 2026-08-16T10:17:25.864Z - task-done: T8: Fix4: extract shared owner-role gate (workspace-service + collaboration-service)
- 2026-08-16T10:17:25.945Z - task-done: T9: Fix5: evaluate centralizing archived-write guard; document decision
- 2026-08-16T10:17:26.023Z - task-done: T10: Fix6: evaluate archive/rename dedup into shared helper; document decision
- 2026-08-16T10:17:26.111Z - task-done: T11: Fix7: reduce redundant manifest reads in withAuthorizedActor
- 2026-08-16T11:05:34.414Z - completing
- 2026-08-16T11:05:37.360Z - completion-failed: acceptance-criteria: unconfirmed: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10
- 2026-08-16T11:06:17.357Z - ac-confirmed: AC1: workspace-service.test.ts: archive() denies editor/viewer with access_denied, allows owner (33/33 pass)
- 2026-08-16T11:06:17.459Z - ac-confirmed: AC2: workspace.test.ts + workspace-service.test.ts: list() excludes archived unless --include-archived; show() still succeeds for archived id
- 2026-08-16T11:06:17.543Z - ac-confirmed: AC3: proposal-lifecycle.test.ts: addResource/create() against archived workspace rejected with guard_denied, never silently accepted
- 2026-08-16T11:06:17.620Z - ac-confirmed: AC4: proposal-lifecycle.test.ts: review() of a pre-archival proposal completes; archive never blocks in-flight review
- 2026-08-16T11:06:24.671Z - ac-confirmed: AC5: workspace-service.test.ts: list({includeArchived:true}) surfaces archived workspaces identically to active ones for a role-visible actor
- 2026-08-16T11:06:24.747Z - ac-confirmed: AC6: proposal-lifecycle.test.ts: removeResource never breaks resolveWorkspaceReference/targetWriteOrStale for pending or accepted proposals
- 2026-08-16T11:06:24.825Z - ac-confirmed: AC7: src/commands/workspace.ts + workspace-service.ts: no addMember/removeMember/updateRole method or CLI subcommand exists in this package
- 2026-08-16T11:06:24.915Z - ac-confirmed: AC8: workspace-service.ts: only archive() mutates status; no code path deletes workspace.json or its directory
- 2026-08-16T11:06:30.520Z - ac-confirmed: AC9: workspace-service.test.ts: removeResource/rename both requireOwner via withAuthorizedActor, denied for editor/viewer identically to archive; addResource unchanged (editor+)
- 2026-08-16T11:06:30.621Z - ac-confirmed: AC10: workspace-service.test.ts: rename() updates title+updatedAt only; id/resources/members unaffected; subsequent show/list reflects new title
- 2026-08-16T11:06:44.126Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/296 (warning: PR is not a draft)
- 2026-08-16T11:06:48.420Z - completing
- 2026-08-16T11:06:50.676Z - done: all gates passed
