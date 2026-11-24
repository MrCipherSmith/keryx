Partial review: pr-files waived by the operator: Rounds 1-4 reviewed only their fix range by design; the dispositions are recorded after the merge
Partial review: quotes-located waived by the operator: Rounds 1-4 reviewed only their fix range by design; the dispositions are recorded after the merge

Reviewed `d7b0f7058e919a5880319588ad95395b7ff66153` against `88e3faba9a1732f45a4ff7200588832e8b83f121` · round 3 (fix range of round 2) · PR #1300. — the PR has since moved to `6449683` and merged as `2f3cd17ee`.

**Changes requested — 0 Blocker, 3 Major, 18 Minor, 12 info.** All three majors confirmed by execution (verifications.json).

Evidence level: ran — round tests (verify-tests-to-run-1: root 2722 pass / 1 unrelated timeout; verify-tests-to-run-2: that test 6/0 alone, Desktop 1051/0), verifier repros for FE-R3-001/FE-R3-002/TP-R3-008, testing-practices mutation passes in scratch worktrees (80 mutants).
Plan estimate vs actual: plan 14-35 min (27 dispatches); actual 22 min from first to last raw reply (30 replies); pauses over 10 min: 0
опциональные роли не запускались: review-clean-code, review-style (включить: --style или --with-role <роль> у `keryx review start|required`, либо reviewRoles в routing.config.json)

Not run: regression and blast radius (the round plan had no tests-to-run/blast radius for the fix range); review-layout measurements in the running app.

Duplicates folded: DG-R3-001 and FE-R3-003 into AR-007; logic F-002 into FE-R3-001; logic F-001 into PC-005; logic F-004 into DG-R3-002; PF-R3-001 into HL3-001; FE-R3-004 into DG3-001; UX-017 into UX-011 (same per-account source key); HL3-002 wave 3 supersedes wave 1.

```json keryx:findings
[
 {
  "id": "FE-R3-001",
  "severity": "major",
  "reviewer": "review-frontend",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": null,
  "quote": "    if (!snapshot.cards.some(c => c.number === focus.number)) return;",
  "problem": "The round-2 fix refuses a focus for a repository the board cannot show, but the sibling early return for a card absent from the loaded snapshot of the right repository still leaves the request armed with no notice. The header PR link (App setReviewFocus from SessionSubjectLinks) fires for any PR-bound session, including merged or closed PRs, and the board's default state filter is [\"open\", \"draft\"], so the card is absent.",
  "impact": "Clicking the header link of a session bound to a merged PR switches to Pull requests and opens nothing, with no message. When the user later changes the state filter to include Merged, or the card appears in a later snapshot, the PR panel opens without being asked. This is the outcome LG-009 reported, through the other early return.",
  "suggested_fix": "When a fresh (not stale, not loading) snapshot of the focused repository lacks the PR, set focused.current, show a notice (e.g. '#N is not in the current filters' with a 'Show all states' action) and call onFocusHandled(nonce). Keep waiting only on a stale cached snapshot.",
  "evidence": "ReviewBoard.tsx:490-511 at head (the comment states the intent of not leaving a request armed); App.tsx:648-656 (header link sets focus for any PR subject); model.ts:28 EMPTY_FILTERS state [\"open\",\"draft\"].",
  "confidence": "medium",
  "blocking_merge": false,
  "class_scope": {
   "sites": [
    "apps/desktop/src/review/ReviewBoard.tsx:508"
   ],
   "enumeration_method": "Every return in the single useEffect that consumes `focus` (ReviewBoard.tsx:496, 497-506, 508): :496 is a legitimate wait for the load, :497-506 was fixed in this range, :508 is still armed. `focus` has no other consumer."
  },
  "dedupe_key": "review-focus-armed-card-absent"
 },
 {
  "id": "FE-R3-002",
  "severity": "major",
  "reviewer": "review-frontend",
  "file": "apps/desktop/src/review/PrWorkRow.tsx",
  "line": null,
  "quote": "    <button type=\"button\" className=\"pr-work-more\" aria-label={`Link ${name}${of}`} disabled={!work.onLinkFlowOffer}\n      onClick={() => work.onLinkFlowOffer?.(offer)}>Link</button>",
  "problem": "Controls added in this range unmount themselves when activated and set no focus target: FlowOffer Link/Dismiss (the offer is dropped and the slot re-renders as a different button), the focus-notice 'Dismiss notice' button in ReviewBoard.tsx (the banner is removed), and 'Show issues assigned to me' in IssuesBoard.tsx (the source change remounts Collection by key). The sibling partial-sync dismiss in ReviewBoard.tsx already returns focus (warningToggle.current?.focus()).",
  "impact": "A keyboard user who presses Enter on Link, Dismiss or Dismiss notice ends with focus on <body>. The next Tab restarts from the top of the window instead of at the PR card they just acted on.",
  "suggested_fix": "After the action, focus the element that replaces the control: the Flow slot's button for the offer (keep a slot ref and focus its first button when the offer disappears), the board heading or search field for the notice, and the source select or Issues heading for the fallback.",
  "evidence": "slice-01: FlowOffer component in PrWorkRow.tsx; focusNotice banner in ReviewBoard.tsx; unavailable panel in IssuesBoard.tsx; usePendingFlowLinks accept/dismiss remove the offer synchronously.",
  "confidence": "medium",
  "blocking_merge": false,
  "class_scope": {
   "sites": [
    "apps/desktop/src/review/PrWorkRow.tsx (FlowOffer Link and Dismiss buttons)",
    "apps/desktop/src/review/ReviewBoard.tsx (focus-notice 'Dismiss notice' button)",
    "apps/desktop/src/issues/IssuesBoard.tsx ('Show issues assigned to me' button)"
   ],
   "enumeration_method": "Every `<button` on a `+` line of slice-01 (four in all), each checked for whether its own element survives its action. These four do not; nothing else interactive was added in the range."
  },
  "dedupe_key": "focus-lost-self-removing-controls"
 },
 {
  "id": "TP-R3-008",
  "severity": "major",
  "reviewer": "review-testing-practices",
  "file": "src/session/organize.test.ts",
  "quote": "    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);",
  "problem": "tdd-workflow.mdc Rule 5: the flags-lock tests depend on wall-clock time. The lock-wait test proves the wait only through elapsed-time assertions (>= 1500 ms and < 1500 ms) and spends the real 2 s stale window. The two-process test starts its writers on a busy-wait against Date.now() and relies on OS interleaving. Against the parent's unlocked writer, the two-process test is red in only 3 of 7 runs, so the regression test named for HW2-001 does not reliably fail before the fix. The lock is pinned deterministically only by the time-based assertion. Sibling precedent (config-update.test.ts:62, stale-snapshot-writers.test.ts:160) exists, but withFileLock already takes timeoutMs and staleMs, which organize.ts hard-codes.",
  "impact": "A probabilistic detector: in about half of runs, a regression that drops the lock from updateSessionFlagsAt passes the test that names lost updates. The lock-wait test adds about 2 s of real time per run and is the reason the timeout path (M39) is untestable.",
  "suggested_fix": "Let a test pass withFlagsLock's options. Replace the elapsed-time assertions with an ordering check: a child holds the lock, writes its flag after a go-file, and the parent's change lands after it with neither lost. Assert the abandoned-lock and timeout ('retry') paths with tiny injected staleMs and timeoutMs values. In the two-process test, replace the Date.now() barrier with a file barrier, or drive a deterministic interleaving in which writer A pauses between read and write until B has tried.",
  "evidence": "Parent organize.ts and issue-session.ts restored in scratch, two-process test: red, red, red, green, green, green, green (7 runs). M38 at head with -t 'two processes': 7 of 8 red (wave 1: 2 of 3). Lock-wait test red for M38, N07 and N08. Commit 80ef58bd5 gives no reason for the timing design.",
  "evidence_kind": "red-test",
  "confidence": "medium",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-flags-lock-wallclock",
  "class_scope": {
   "sites": [
    "src/session/organize.test.ts: lock-wait test, expect(Date.now() - started).toBeGreaterThanOrEqual(1500) and expect(Date.now() - again).toBeLessThan(1500)",
    "src/session/organize.test.ts: two-process test, while (Date.now() < ${startAt}) {}"
   ],
   "enumeration_method": "keryx ctx rg -n --all 'Date\\.now\\(\\)|setTimeout\\(|sleepSync|performance\\.now' over the 11 test files from git diff --name-only 88e3faba9..d7b0f7058: 11 hits; 7 in organize.test.ts (these sites, their start reads, and a utimes setup that is not an assertion); 4 in ReviewBoard.dom.test.tsx, none added in the range (checked with git diff -U0)"
  }
 },
 {
  "id": "AR-007",
  "severity": "minor",
  "reviewer": "review-architecture",
  "file": "apps/desktop/src/issues/IssuesBoard.tsx",
  "line": null,
  "quote": "  const unavailable = fallback && /(?:^|\\b)configuration:/i.test(error) ? fallback : undefined;",
  "problem": "The RG-001/UX-008 fallback decodes the CLI error contract in the view. It decides 'This project's repository issues are not available here' from any `configuration:` reason, and 'this keryx is older than Desktop' from the literal text of `invalidInput` (`/Invalid Issues request/i`). The backend uses the `configuration:` category, and `invalidInput` itself, for unrelated reasons: a stale cursor (issues-github.ts:120), a malformed cursor (:122), a missing cwd or a '.'/'..' repository part (issues-board.ts:115, :118), and a pagination link that fails validation (issues-board.ts:154, :168). The classifier sits inline in Collection, while its sibling `isAccessError` lives in useIssueCollection.ts. The contract already has typed problem codes (issues-contract.ts:115).",
  "impact": "Trigger: default (unchosen) repository source, more pages loaded, the project's resolved repository changes (origin re-pointed or remotes reordered), then 'Load more'. The cursor scope includes the repository (issues-board.ts:203), so the CLI answers 'configuration: Refresh before loading the next page.' Outcome: Desktop drops Retry, says the repository's issues are not available, and offers only 'Show issues assigned to me'. Pressing it calls change('assigned'), which stores 'assigned' as the person's chosen source, so a transient error becomes a persisted preference. Second path: a remote whose name parses as '.'/'..' gets invalidInput, and Desktop advises updating keryx, which is wrong advice.",
  "suggested_fix": "Give the repository-source failures (no GitHub.com remote for the issues source, Issues turned off at issues-board.ts:184, the dot-name refusal) a reason of their own on the CLI side, for example a `repository_unavailable:` prefix or a code like IssueWorkspace.problem.code. Classify it beside isAccessError in useIssueCollection.ts so one module maps CLI reasons to UI categories. Keep the old-keryx text match only for a first-page request (no cursor), the one case an old keryx produces.",
  "evidence": "slice-01 IssuesBoard.tsx hunk @@ 42,167 @@ (unavailable/fallback) and @@ 216,292 @@ (notice). src/integrations/issues-github.ts:8 invalidInput, :120 readCursor, :122; src/integrations/issues-board.ts:110-118, :154, :168, :184, :203 cursorScope includes repository.toLowerCase(); apps/desktop/src/issues/useIssueCollection.ts:16-18 isAccessError; src/integrations/issues-contract.ts:115 problem codes. Enumerated with `keryx ctx rg -n 'invalidInput|issuesDisabled|source_unavailable|Refresh before' src/integrations src/commands` and `keryx ctx rg -n 'configuration:' src/integrations/issues-board.ts src/integrations/issues-github.ts src/commands/issues.ts`.",
  "confidence": "medium",
  "dedupe_key": "desktop-issues-fallback-decodes-configuration-category",
  "class_scope": {
   "sites": [
    "apps/desktop/src/issues/IssuesBoard.tsx:147 (configuration: -> source unavailable)",
    "apps/desktop/src/issues/IssuesBoard.tsx (notice: /Invalid Issues request/ -> old keryx hint)"
   ],
   "enumeration_method": "keryx ctx rg for 'configuration:|Invalid Issues request|isAccessError' over apps/desktop/src: the only Desktop sites that read a configuration: reason or the invalidInput text are these two in IssuesBoard.tsx; ReviewBoard.tsx strips the prefix for display only."
  }
 },
 {
  "id": "DG-R3-002",
  "severity": "minor",
  "reviewer": "review-degradation",
  "file": "apps/desktop/src/issues/model.ts",
  "quote": "export function issueSessions(sessions: readonly SessionInfo[], issue: IssueSummary): SessionInfo[] {",
  "degradation_class": "debt",
  "evidence_kind": "consumer-trace",
  "problem": "The PF-003 fix moved IssueWorkRow from issueSessions(sessions, issue) to a count from boundSessionIndex built once in IssuesBoard. issueSessions now has no production caller. Its only users are issues/model.test.ts:4,64,65, which keep pinning a helper the board no longer uses, beside the index path that is not pinned at that level.",
  "impact": "A leftover of the old surface: a second entry point for 'sessions bound to an issue', tested while the one the UI uses goes through IssuesBoard. A later change to the board path would leave this green test and dead export misleading.",
  "suggested_fix": "Delete issueSessions and repoint the model test at boundSessionIndex(sessions)(issueSubject(issue)). Alternatively make IssuesBoard call a model-level index helper that the test pins.",
  "evidence": "consumer-trace: `keryx ctx rg \"issueSessions|boundSessions\\(\" src apps/desktop/src` finds issueSessions only in model.ts:68 (definition) and model.test.ts:4/64/65. The diff removes the IssueWorkRow import (`-import { issueName, issueSessions, STAGES } from \"./model\";`). Refute: checked root src/ for shared-model users; there are none.",
  "confidence": "high",
  "blocking_merge": false
 },
 {
  "id": "HL3-001",
  "severity": "minor",
  "reviewer": "review-highload",
  "file": "src/session/organize.ts",
  "line": null,
  "quote": "    timeoutMs: FLAGS_LOCK_TIMEOUT_MS,\n    staleMs: FLAGS_LOCK_STALE_MS,",
  "problem": "withFlagsLock waits through lib/file-lock withFileLock, which spins in Bun.sleepSync(15) until it gets the lock. The caller is the long-lived ACP server's `_keryx/session_flags` handler (server.ts handleSessionFlags \u2192 setSessionFlags \u2192 updateSessionFlagsAt). A lock left by a writer killed mid-section therefore blocks the server's event loop for up to about 2 s (staleMs). An unremovable lock blocks it for the full 3 s timeout on every write.",
  "impact": "While the server waits, the running turn's session/update stream, cancel and permission answers stall. Desktop writes flags without any user action (PendingSubjects.apply at turn end, Link on a Flow offer). The PR body accepts that a 'flags write may wait up to 3 s'; it does not say the whole server freezes.",
  "suggested_fix": "On the ACP server path, wait asynchronously. Either make setSessionFlags/updateSessionFlagsAt async on top of lib/fs withFileLock, or try the O_EXCL create once synchronously and fall back to an async retry loop (await sleep(15)) until the deadline. Keep the synchronous form for the short-lived issue-workspace child only.",
  "evidence": "src/session/organize.ts withFlagsLock (FLAGS_LOCK_TIMEOUT_MS 3_000, FLAGS_LOCK_STALE_MS 2_000); src/lib/file-lock.ts sleepSync uses Bun.sleepSync and the wait loop runs until the deadline; src/acp/server.ts calls setSessionFlags synchronously in the session_flags handler. Journal: 'flags write may wait up to 3 s for the lock'. Code comment reason: 'Synchronous: callers are synchronous, and the section is one read and one atomic write'. That reason bounds the holder's time, not a waiter's wait on an abandoned lock.",
  "confidence": "high",
  "dedupe_key": "flags-lock-sync-wait-blocks-acp-server"
 },
 {
  "id": "HL3-002",
  "severity": "minor",
  "reviewer": "review-highload",
  "file": "src/session/organize.ts",
  "line": null,
  "quote": "  const held = withFileLock(path.join(dir, `${FLAGS_FILE}.lock`), () => ({ value: apply() }), {",
  "problem": "Correction to the wave-1 filing, which only adds a site. withFileLock starts with mkdirSync(path.dirname(lockPath), { recursive: true }), and that dirname is the session directory. trashSession (organize.ts:252) takes no flags lock. Two callers check that the directory exists and only then lock: setSessionFlags (locate(), then updateSessionFlagsAt) and withIssueBinding (`if (!existsSync(dir)) throw`, then bindIssueSubject \u2192 backfillSessionSubject). A trash in another keryx process in either window has the lock recreate <sessions>/<id>/, and flags.json is written into it.",
  "impact": "An orphan session directory with no summary.json, so listSessions skips it and nothing removes it. The flags change is reported as stored for a trashed session, and a later 'Put Back' collides with the orphan. Since this range the backfill runs on every issue-session open, so the second window opens on every open.",
  "suggested_fix": "Inside withFlagsLock's critical section, refuse when the session directory (or its summary.json) no longer exists, before readStoredFlags. Or add a createDir:false option to withFileLock for this caller, so that a missing directory is a refusal ('session not found').",
  "evidence": "src/lib/file-lock.ts: `mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })` runs before the O_EXCL open. organize.ts setSessionFlags: `const { dir } = locate(cwd, sessionId, dataDir); return updateSessionFlagsAt(dir, change, now);`. issue-session.ts: `if (!existsSync(dir)) throw ...; bindIssueSubject(dir, issue.ref);`. trashSession: renameSync(dir, target), or cpSync then rmSync on EXDEV, with no flags lock. Not executed; the interleaving is read from the code.",
  "confidence": "medium",
  "dedupe_key": "flags-lock-mkdir-recreates-trashed-session",
  "class_scope": {
   "sites": [
    "src/session/organize.ts setSessionFlags \u2192 updateSessionFlagsAt",
    "src/session/issues/issue-session.ts withIssueBinding \u2192 bindIssueSubject \u2192 backfillSessionSubject"
   ],
   "enumeration_method": "keryx ctx rg 'setSessionFlags\\(|updateSessionFlagsAt\\(|backfillSessionSubject\\(|withIssueBinding\\(' src --glob '!*.test.ts' (8 matches). Every flags-lock entry is reached through one of these two."
  }
 },
 {
  "id": "PC-005",
  "severity": "minor",
  "reviewer": "review-pr-contract",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "      const listed = snapshot.repositories.find(name => name.toLowerCase() === focus.repo.toLowerCase());\n      if (listed) {\n        selectRepo(listed);\n        return;\n      }\n      focused.current = focus.nonce;\n      setFocusNotice(",
  "problem": "PR body, Choices for the owner: 'A header link to a PR of another repository shows a banner and stays armed until that repository is shown.' That describes the round-1 behaviour (journal T17: 'a header focus for another repo stays armed until that repo is shown'). The round-2 LG-009 fix replaced it. A repository among the board's repositories is now selected automatically, with no banner. A repository the board cannot show gets the banner, and the request is cleared through onFocusHandled. The code comment says 'so the request is not left armed for a later, unrelated switch'. Neither branch both shows a banner and stays armed.",
  "impact": "The owner is asked to accept or revert a behaviour from this list, and this line describes one that no longer exists. They cannot see that the board now switches repository on its own, which is a new choice not listed, or that an unshowable repository drops the request.",
  "suggested_fix": "Replace the line with: 'A header link to a PR of another repository switches the board to that repository when the board lists it; otherwise it shows a notice and drops the request.' Keep journal.md line 79 ('foreign-repo header link shows a banner') consistent.",
  "evidence": "slice-01 diff ReviewBoard.tsx @@471 focus effect and its comment 'one it cannot show is refused with a notice, so the request is not left armed'; App.tsx reviewFocusHandled clears reviewFocus on the nonce; PR body from payload review_context.pr.body.",
  "confidence": "high"
 },
 {
  "id": "PC-006",
  "severity": "minor",
  "reviewer": "review-pr-contract",
  "file": ".metaproject/flows/517-2026-11-23-desktop-review-v2-stage-1-github-slice-a/journal.md",
  "quote": "+Deferred info: PF-006/HW2-002 (one nodes hydration per request), AR-002, AR-004..006, PF-002, LG-004, LY-002/LY-004 (need real-engine measurement), UX-003..006.",
  "problem": "PR body Known gaps: 'Deferred info findings: PF-006/HW2-002, AR-002, AR-004..006, PF-002, LG-004, LY-002/LY-004, UX-003..006 (round 2 package).' The journal entry in this range says the same. In the round-2 package (\u2026-pull-1300-r02/findings.json), the info findings left deferred also include HL-003 (prWork.ts: a press after the open settles but before the pendingSubjects commit can start a second bound session), LG-014 and LG-016. The fix-round claims mark all three 'deferred', yet neither list names them. AR-002, PF-002, LG-004, LY-002, LY-004 and UX-003..005 exist only in the round-1 package (\u2026-pull-1300/findings.json), so '(round 2 package)' mislabels them.",
  "impact": "A reader who takes Known gaps as the full set of accepted leftovers does not see HL-003, a residual second-session race on 'Open in session'. Looking up the listed ids in the named package does not find most of them.",
  "suggested_fix": "List HL-003, LG-014 and LG-016 among the deferred info findings, and split the list by package: round 1 for AR-002, PF-002, LG-004, LY-002/LY-004 and UX-003..005; round 2 for the rest. Do the same in journal.md.",
  "evidence": "jq over both packages' findings.json: round 1 holds AR-002, LG-004, LY-002, LY-004, PF-002 and UX-003..005 (info); r02 holds HL-003, LG-014, LG-016, PF-004 and UX-006 (info). The payload prior_findings claimed_disposition is 'deferred' for HL-003, LG-014 and LG-016. PF-004 is effectively fixed by the AR-003 change, so its omission is correct.",
  "confidence": "high"
 },
 {
  "id": "PC-008",
  "severity": "minor",
  "reviewer": "review-pr-contract",
  "file": "docs/docs/cli-reference.md",
  "quote": "The request `_keryx/session_flags {sessionId, cwd?, archived?,\n  pinned?, flow?}` archives/unarchives, pins/unpins or links to a flow package\n  (`flow: null` unlinks) a stored session (kept in its `flags.json`) and\n  answers `{archivedAt?, pinnedAt?, flow?}`;",
  "problem": "PR body: 'subject ... written through `_keryx/session_flags` under a per-session `flags.json.lock`'. The handler (src/acp/server.ts handleSessionFlags: 'link it to a flow and a GitHub subject') accepts `subject` (an object, or null to unlink) and answers the stored flags including `subject`. Since 80ef58bd5 it also refuses with '... are locked by another keryx process; retry' after 3 s. The ACP reference was last edited at base b147408a8 and was not touched by this PR. It still lists only archived/pinned/flow, and the answer only archivedAt/pinnedAt/flow. The body's 'User docs' line names cli-reference.md for `issues` only. Sibling site: src/commands/acp.ts:616 help text ('_keryx/session_flags archives or pins a stored session').",
  "impact": "A client author who reads the ACP reference (the same document the PR updated for `issues`) does not learn that a session can be bound to a PR or issue through this request, what a valid subject is, or that a write can be refused with a retryable lock error. The code is correct. The cost is a reader who trusts the reference.",
  "suggested_fix": "Extend the cli-reference line to `{sessionId, cwd?, archived?, pinned?, flow?, subject?}`. Describe the subject shape ({kind, repo, number, url, repositoryId?}, github.com only, `subject: null` unlinks), state the answer as the stored flags including `hasIssue` and `subject`, and add the lock refusal ('retry' after 3 s). Optionally update the acp.ts help line. Or name the omission in the PR body.",
  "evidence": "git diff b147408a8..d7b0f7058 -- docs/docs/cli-reference.md touches only the `issues` section (lines 5175-5181). git show b147408a8:docs/docs/cli-reference.md has the identical `_keryx/session_flags {sessionId, cwd?, archived?, pinned?, flow?}` text. `subject` entered the handler in 5b7b8be56 (this PR). A keryx ctx rg over both earlier review packages for this doc line finds no prior finding.",
  "confidence": "high",
  "class_scope": {
   "sites": [
    "docs/docs/cli-reference.md:476",
    "src/commands/acp.ts:616"
   ],
   "enumeration_method": "keryx ctx rg \"session_flags\" src docs (non-test): server.ts and profile.ts are code, desktop-app.md:369 only names the method, implementation-plan.md:35 already describes subject and the lock; the two listed sites describe the request's parameters or effect and omit subject"
  }
 },
 {
  "id": "TP-R3-001",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "apps/desktop/src/review/usePendingFlowLinks.ts",
  "quote": "    offersRef.current = offersRef.current.filter(item => item !== offer);",
  "problem": "Three gates added in the fix round survive deletion with all 6 Desktop suites green: accept's synchronous offersRef clear (M01, the double-press guard its comment names), dismiss's synchronous offersRef clear (M05), and the replacement of a session's older offer by its new one (M08, mutated to [...old, ...pass.links]). The test presses accept twice only across separate act() calls. No test dismisses then accepts before a render, and none gives one session two offers.",
  "impact": "Undoing any of these is invisible to the suite: a double Link writing the flow flag twice, a Dismiss+Link in one frame linking a dismissed package, or a stale first offer shown after a second Create Flow.",
  "suggested_fix": "In usePendingFlowLinks.dom.test.tsx: call accept('s1') twice inside one act and assert links has length 1. Call dismiss('s1'); accept('s1') inside one act and assert no link. Expect s1, offer 101, expect s1 again, package 102 appears, and assert offers() equals ['s1 102-...'].",
  "evidence": "Mutants M01, M05, M08: GREEN on prWork, usePendingFlowLinks, PrWorkRow, ReviewBoard, IssuesBoard and ProjectNavigation (App fixtures) suites; M02/M03/M04/M06/M07 red.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-flowlink-hook-guards"
 },
 {
  "id": "TP-R3-002",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "apps/desktop/src/review/PrWorkRow.tsx",
  "quote": "  const offer = flow ? undefined : work.flowOffer?.(sessions);",
  "problem": "Deleting the `flow ?` guard (M20) leaves all 6 Desktop suites green: the offer test renders no Flow, so no fixture separates showing an offer from showing the PR's Flow link.",
  "impact": "If an offered package (or any Flow) carries the PR's prUrl, a regression would show 'Link Flow #N?' in place of the PR's Flow, and nothing would catch it.",
  "suggested_fix": "In PrWorkRow.dom.test.tsx, render the same offer with flows: [flow('531', { prUrl: pr.url })]. Assert the Flow slot reads 'Flow #531 \u00b7 In progress' and that there is no 'Link Flow' button.",
  "evidence": "Mutant M20 GREEN on all 6 Desktop suites.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-offer-vs-flow"
 },
 {
  "id": "TP-R3-003",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "apps/desktop/src/issues/IssuesBoard.tsx",
  "quote": "  const unavailable = fallback && /(?:^|\\b)configuration:/i.test(error) ? fallback : undefined;",
  "problem": "Replacing the configuration: filter with 'any error' (M34) is green. Every default-source fixture fails with a configuration error, and Retry is kept only through a chosen source, never through a non-configuration error.",
  "impact": "A regression would hide Retry on the default source for rate-limit, offline or unavailable errors and offer a source switch instead. The suite would not notice.",
  "suggested_fix": "Add an IssuesBoard test with no stored source whose list rejects 'rate-limit: GitHub request limit reached.'. Assert Retry is present and 'Show issues assigned to me' is absent.",
  "evidence": "Mutant M34 GREEN on all 6 Desktop suites; M32/M35/M36 red; M33 equivalent.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-issues-fallback-filter"
 },
 {
  "id": "TP-R3-004",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "quote": "      focused.current = focus.nonce;\n      setFocusNotice(`${focus.repo}#${focus.number} is not in a repository this board shows",
  "problem": "Two focus-refusal steps survive deletion: marking the refused nonce handled (M24; the LG-009 test's onFocusHandled clears focus, so the effect never re-runs with that nonce) and clearing the notice on a later successful focus (M26, presentation). No test refuses one focus and then opens another.",
  "impact": "Undoing either is invisible: a board whose owner does not clear focus would re-raise a dismissed notice on each refresh, or a stale notice would sit above the panel that did open.",
  "suggested_fix": "With focusHost(load, [], false): refuse elsewhere/project, Dismiss the notice, Refresh, and assert no .review-focus-notice. In the LG-009 test, after the refusal, set a new nonce for org/repo#101 and assert the panel opens and the notice is gone.",
  "evidence": "Mutants M24 and M26 GREEN on all 6 Desktop suites; M22/M23/M25 red.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-focus-refusal"
 },
 {
  "id": "TP-R3-005",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "apps/desktop/src/review/ReviewProgress.tsx",
  "quote": "    state: showState && ![\"running\", \"queued\", \"completed\"].includes(state) ? RUN_STATE_LABEL[state] : \"\",",
  "problem": "The refactor into progressParts made one rule for ReviewProgress and reviewProgressText. Dropping `showState &&` (M29) is green: no test renders ReviewProgress without showState in a state that has a label.",
  "impact": "A regression would add the run-state label ('Partial \u00b7 ', 'Failed \u00b7 ') to every ReviewProgress rendered without showState. Nothing would catch it.",
  "suggested_fix": "Render <ReviewProgress state=\"partial\" /> and assert the caption has no 'Partial'; render it with showState and assert it does.",
  "evidence": "Mutant M29 GREEN on all 6 Desktop suites; M30/M31 red.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-progress-showstate"
 },
 {
  "id": "TP-R3-006",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "src/integrations/issues-board.ts",
  "quote": "  for (let fetched = 1; repository && !issues.length && fetched < REPOSITORY_PAGES; fetched++) {",
  "problem": "The gates that keep the new extra-page loop and the 410 rename to the repository source survive deletion: M54 (drop `repository &&` in the loop) and M51 (drop `repository &&` in issuePage's 410 branch). No viewer-source fixture returns an empty page with a next link, or a 410. M55 (turnPage not clearing earlier page keys) also survives; it is likely near-equivalent.",
  "impact": "A regression could make viewer queues read up to 3 pages per request, or report 'Issues turned off for null'. The suite would not notice.",
  "suggested_fix": "issues-board.test.ts: an 'assigned' page answering [] with a next link makes exactly one request. An 'assigned' 410 does not mention 'turned off for'.",
  "evidence": "Mutants M54, M51, M55 GREEN on organize, issue-session, issues-board, commands/issues and shell-session-organize suites; M50/M52/M53/M56-M60 red.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-repository-only-gates"
 },
 {
  "id": "TP-R3-007",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "src/session/organize.ts",
  "quote": "  if (held === null) throw new Error(`the flags of session ${path.basename(dir)} are locked by another keryx process; retry`);",
  "problem": "Outside slice-02, run because the dispatch asked to mutate the flags lock. The lock-timeout error survives deletion (M39): no test holds the lock past the 3 s timeout, because the wait test lets it go stale at 2 s. backfillSessionSubject without withFlagsLock (M47) also survives: the two-process test drives only updateSessionFlagsAt. That test caught the unlocked updateSessionFlagsAt (M38) in only 2 of 3 runs; M38 is pinned deterministically only by the wall-clock lock-wait test.",
  "impact": "The 'retry' error ACP clients show, and the backfill's protection against lost updates (issue-workspace child against a Desktop flag write), could regress with the suite green.",
  "suggested_fix": "Inject lock timing (or a clock) so a test can hold the lock past the timeout and assert the retry message. Add a two-writer case where one process backfills the subject while the other pins.",
  "evidence": "Mutants M39 and M47 GREEN on the 5 root suites; M38 with -t 'two processes': red, green, red over 3 runs; M38/M40/M41/M44/M46/M48/M49 red on the nearest suites.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-flags-lock-coverage"
 },
 {
  "id": "TP-R3-009",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "src/session/organize.ts",
  "quote": "  if (parsed === undefined) throw new Error(`not a GitHub subject: ${JSON.stringify(subject).slice(0, 300)}`);",
  "problem": "backfillSessionSubject's own validation survives deletion (N04) with all 21 nearest tests green. Every test passes it a valid subject, and its one caller parses the subject first.",
  "impact": "The function is exported. Without the guard, a future caller's unparsed subject would be written to flags.json without validation, and no test would notice. The code is correct today.",
  "suggested_fix": "In organize.test.ts, assert that backfillSessionSubject(dir, {...issue, url: 'https://github.com/org/other/issues/7'} as never) throws /not a GitHub subject/ and leaves flags.json unchanged.",
  "evidence": "Mutant N04 GREEN on organize, issue-session and shell-session-organize suites (21/21); N03 and N07\u2013N14 red.",
  "evidence_kind": "red-test",
  "confidence": "high",
  "degradation_class": "blind-test",
  "dedupe_key": "tp-r3-backfill-validation"
 },
 {
  "id": "UX-009",
  "severity": "minor",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/review/PrWorkRow.tsx",
  "line": null,
  "quote": "<span className=\"pr-work-link pr-work-offer\"",
  "problem": "Criterion: Nielsen #6 and #1. The 'Link Flow #N?' offer names the package only by number. The flow's title is only in the title attribute of a non-focusable span, which a keyboard user cannot reach and a touch user cannot hover. The Link button's aria-label ('Link Flow #N for #PR') omits it. The owner chose the confirm (HL-001) because arrival time cannot tell who made the package, so identifying it is the user's whole decision.",
  "impact": "Trigger: every offer. Outcome: the user links or dismisses by number only, or leaves for the Flows board to check. A wrong Link writes the session's flow flag to an unrelated package.",
  "suggested_fix": "Put the flow title in the Link button's accessible name or an aria-describedby target. Or make 'Flow #N' in the offer a button that opens the Flow, as the filled slot does, so it can be inspected before linking.",
  "evidence": "FlowOffer in the diff: visible text `Link {name}?`; `title={`${name} (${offer.flow.title}) appeared after Create Flow. ...`}` on a <span>; Link aria-label `Link ${name}${of}`. Not observed on a render.",
  "confidence": "high",
  "dedupe_key": "pr-flow-offer-title-hover-only"
 },
 {
  "id": "UX-010",
  "severity": "minor",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/review/usePendingFlowLinks.ts",
  "line": null,
  "quote": "offersRef.current = offersRef.current.filter(item => item !== offer);",
  "problem": "Criterion: Nielsen #1 and #9; State: loading and error. accept() removes the offer before calling link. App wires link to linkFlow, which calls applyPendingFlow; that catches every error silently ('retried after its turn') and shows no banner. Until the flags dispatch arrives, the Flow slot falls back to 'Create Flow'. The package is claimed, so it is never offered again. The new flags lock can fail after 3 s with '...locked by another keryx process; retry', and the board no longer has a control to retry with.",
  "impact": "Trigger: every Link press shows 'Create Flow' for the length of the RPC. A failed write (lock timeout, a keryx disconnect) leaves 'Create Flow' with no message until the session's next turn. Pressing it starts a second Flow.",
  "suggested_fix": "Keep the offer in a 'Linking\u2026' state with its buttons disabled until linkFlow resolves. On failure, restore the offer and show an inline error or banner; linkFlow must report its result to this caller.",
  "evidence": "usePendingFlowLinks.ts accept: offersRef filtered and setOffered before linkRef.current(...). App.tsx: `usePendingFlowLinks(..., (id, dir) => void acp.current.linkFlow(id, dir))`. useAcpSession.ts applyPendingFlow: `catch { /* not stored yet: retried after its turn */ }`. src/session/organize.ts withFlagsLock throws after FLAGS_LOCK_TIMEOUT_MS = 3_000. Not observed on a render.",
  "confidence": "medium",
  "dedupe_key": "pr-flow-offer-link-no-pending-or-error-state"
 },
 {
  "id": "UX-011",
  "severity": "minor",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/issues/IssuesBoard.tsx",
  "line": null,
  "quote": "const fallback = source === \"repository\" && !choice.chosen ? () => change(\"assigned\") : undefined;",
  "problem": "Criterion: Nielsen #3 and #4. The fallback calls change('assigned'), which saves account + '.source'. The account key is 'keryx.issues.' + issueViewerKey(viewer) = [host, nodeId], with no project in it. A button labelled 'Show issues assigned to me', offered for a project-specific failure (no GitHub.com remote here, Issues off on this repo, older keryx), therefore stores an account-wide source preference.",
  "impact": "Trigger: a user with several projects presses the button once in a project without a GitHub.com remote or with Issues off. Outcome: every other project, including those with a GitHub remote, opens Issues on 'Assigned to me' instead of the D5 default 'Project repository', with no indication why. The select recovers it.",
  "suggested_fix": "Switch the source for this board only (setChoice without save, with a status line 'Showing issues assigned to you'). Or key the stored source by project and account. If it keeps persisting, label it 'Use Assigned to me'.",
  "evidence": "IssuesBoard.tsx: `const change = (next: Source) => { ...; save(account + \".source\", next); }`; `const account = \"keryx.issues.\" + issueViewerKey(viewer);`. src/integrations/issues-contract.ts: `issueViewerKey` returns `JSON.stringify([viewer.host.toLowerCase(), viewer.nodeId])`. The owner choice in the PR body covers only where the button appears.",
  "confidence": "medium",
  "dedupe_key": "issues-fallback-persists-account-wide-source"
 },
 {
  "id": "DG3-001",
  "severity": "info",
  "reviewer": "review-degradation",
  "degradation_class": "behaviour-delta",
  "evidence_kind": "base-diff",
  "file": "src/session/issues/issue-session.ts",
  "quote": "    // On first bind, and for a session an older keryx bound without a subject. The flags lock is\n    // taken inside the binding lock, never the reverse, so the two cannot deadlock.\n    bindIssueSubject(dir, issue.ref);",
  "problem": "On base, reopening an already bound issue session (stage session_bound or later, action open-session) did no flags.json I/O: bindIssueSubject ran only in the registered branch. On head it runs on every open-session and prepare-flow. backfillSessionSubject takes the flags lock and throws when it cannot: 'the flags of session X are locked by another keryx process; retry' after 3 s, or a write error. Nothing in withIssueBinding catches it, so the whole open fails before saveBinding and apply. The subject is a public decoration; the private binding record stays the authority (bindIssueSubject's own doc). An open that worked on base without touching flags can now be refused because of them. If true: major. The person cannot open the issue's bound session from the Issues board while the flags lock cannot be taken or flags.json cannot be written, for example an unremovable leftover flags.json.lock, a read-only session dir or no free inodes. The same open succeeds on base.",
  "impact": "It applies only when the flags lock or file is unusable for more than 3 s. The trigger is environmental, which is why this is a question and not a finding. prepare-flow already wrote flags on base (issues-launch.ts:116), so its failure condition is unchanged. Only open-session on a reused binding changed.",
  "suggested_fix": "Check: on head and on base, bind an issue session, then `chmod 0500` its session dir (or create a flags.json.lock the process cannot remove), then run `keryx issue-workspace open-session` for that issue. Base opens. If head refuses, make the backfill best-effort outside the registered branch: catch and ignore the error, or skip it when the session already has a subject, and keep it fatal only on first bind as on base.",
  "evidence": "base-diff. Base 88e3faba9 issue-session.ts called bindIssueSubject(dir, issue.ref) inside `if (launch.stage === \"registered\") { ... }`. Head calls it after `if (!existsSync(dir)) throw ...`, unconditionally. organize.ts withFlagsLock: `if (held === null) throw new Error(...)`. backfillSessionSubject calls withFlagsLock before it reads current, so the lock is taken even when a subject already exists. Refute attempt: read issues-launch.ts:91-122. The workspace action returns before withIssueBinding, so read-only loads are unaffected. prepare-flow already called setSessionFlags on base (line 116), so it has no delta. withIssueBinding has no try/catch around bindIssueSubject. The commit 80ef58bd5 text and the PR body record the backfill but give no reason it must be fatal. Not run (read-only, exec_budget 0).",
  "confidence": "medium",
  "dedupe_key": "issue-reopen-fails-on-flags-backfill"
 },
 {
  "id": "HL3-003",
  "severity": "info",
  "reviewer": "review-highload",
  "file": "apps/desktop/src/review/prWork.ts",
  "line": null,
  "quote": "  if (!deps.isShown(id)) return false;\n  deps.fill(prompt);",
  "problem": "fillShown checks isShown(id) and then calls fill, but App's fillComposer applies setText inside requestAnimationFrame. A session switch dispatched in that frame would put the prompt in the newly shown session while filled:true registers the Create Flow request on the opened one. This is the residual of LG-011.",
  "impact": "At most, a wrong draft plus a pending request that can only become a user-confirmed 'Link Flow #N?' offer; nothing is written without Link.",
  "suggested_fix": "Optional: re-check isShown(id) inside the rAF callback and report the result back (fill returns Promise<boolean>), so that filled reflects what happened.",
  "evidence": "apps/desktop/src/App.tsx fillComposer: `requestAnimationFrame(() => composer.current?.setText(text));`. apps/desktop/src/session/useAcpSession.ts isShown reads live.current.reg.shown.",
  "confidence": "medium",
  "dedupe_key": "subject-open-fill-raf-gap"
 },
 {
  "id": "HL3-004",
  "severity": "info",
  "reviewer": "review-highload",
  "file": "src/session/organize.ts",
  "line": null,
  "quote": "const FLAGS_LOCK_STALE_MS = 2_000;",
  "problem": "Stale recovery is by lock-file age only, with a 2 s threshold (the shared default is 10 s). A holder whose read plus atomic write stalls for more than 2 s has its lock broken while it still runs. The nonce stops it from deleting the new holder's lock, but both read-modify-writes proceed, and one update can be lost.",
  "impact": "The HW2-001 lost update returns whenever a holder stalls for more than 2 s. No concrete trigger is shown in this repository, so this is info.",
  "suggested_fix": "Record the holder PID in the lock file and break it only when that PID is gone, or use the shared LOCK_STALE_MS (10 s). Either still fits the 3 s timeout if the PID check runs first.",
  "evidence": "src/lib/file-lock.ts stale branch: `if (age !== undefined && Date.now() - age > staleMs) rmSync(lockPath)`. There is no PID check.",
  "confidence": "low",
  "dedupe_key": "flags-lock-age-only-stale-2s"
 },
 {
  "id": "LY-005",
  "severity": "info",
  "reviewer": "review-layout",
  "file": "apps/desktop/src/review/PrWorkRow.tsx",
  "quote": "<button type=\"button\" className=\"pr-work-more\" aria-label={`Dismiss ${name}${of}`} disabled={!work.onDismissFlowOffer}",
  "problem": "In offer state the Flow slot (display:flex, no overflow clip, a minmax(0,1fr) grid track) holds the question span (flex 1 1 auto, min-width 0) and two flex:none .pr-work-more buttons, 'Link' and 'Dismiss'. The buttons need about 80px with their margins, and the span keeps 14px of padding and border, so about 94px in all. The slot is 60px in a 230px board lane and about 74.7px in the 16rem list column. The question text shrinks to 0px, and the buttons overflow by about 30px (lane) or 16px (list) into the session slot. That slot paints later and holds an opaque 'Session' button, which covers most of Dismiss and receives clicks in the overlap.",
  "impact": "After Create Flow, at supported widths (the Tauri minWidth is 720; 230px lanes hold up to about a 1000px board), the confirmation the owner chose for HL-001 shows as two bare buttons, 'Link' and a mostly hidden 'Dismiss', with no question and no Flow number; the text is only in a title tooltip. A click on the visible part of 'Dismiss' can land on the Session button.",
  "suggested_fix": "Make the offer fit the slot instead of overflowing it. Either let the offer buttons shrink (`.pr-work-offer ~ .pr-work-more { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis }`), or render the offer as one truncating 'Link #N?' button plus a 'Dismiss' text button without the static span. Add `overflow: hidden` to `.pr-work-slot`. Then measure in a real engine at a 230px lane and at the 16rem list column.",
  "evidence": "Static cascade arithmetic, no engine. Tokens: fs-xs 11px, sp-1 4px, sp-2 8px, sp-3 12px. Lane: .review-lanes .lane flex 1 0 230px; minus .lane-body padding 8px x2 and .flow-card padding 12px x2 and border 1px x2 leaves 188px; 3 tracks with 2 gaps of 4px give 60px per slot. List: th:nth-child(6) 16rem (256px) minus td padding 12px x2 leaves 232px, about 74.7px per slot. Button width estimates for SF Pro 11px: Link about 29px, Dismiss about 47px, each with a 2px margin-inline-start. Tauri minWidth 720 (apps/desktop/src-tauri/tauri.conf.json). Settle it with getBoundingClientRect on [data-slot=flow], .pr-work-offer and the two buttons, plus elementFromPoint at the Dismiss centre, at a 720px and a 1180px window, in board and list view.",
  "confidence": "medium",
  "dedupe_key": "layout:pr-work-row:flow-offer-overflow",
  "class_scope": {
   "sites": [
    "apps/desktop/src/review/PrWorkRow.tsx:FlowOffer (board tile via ReviewResults.tsx ReviewTile)",
    "apps/desktop/src/review/PrWorkRow.tsx:FlowOffer (list <td> via ReviewResults.tsx)"
   ],
   "enumeration_method": "keryx ctx rg \"pr-work\" over apps/desktop/src: .pr-work-offer occurs only in PrWorkRow.tsx and styles/review.css, and PrWorkRow is rendered only from ReviewResults.tsx (board tile and list row). IssueWorkRow renders no offer."
  }
 },
 {
  "id": "LG-R3-003",
  "severity": "info",
  "reviewer": "review-logic",
  "file": "apps/desktop/src/review/prWork.ts",
  "line": null,
  "quote": "  return { pending: [], links: only && fresh.length === 1 && fresh[0] ? [{ sessionId: only.sessionId, dir: fresh[0] }] : [] };",
  "problem": "Making an offer ends the pending request. When a foreign package arrives first and the person dismisses it, the package their own prompt creates later in the window is not offered.",
  "impact": "AC9 as re-frozen allows this. The body says Dismiss stops offering that package, but not that it ends the wait for the real one. Recorded for the owner; no change required.",
  "suggested_fix": "Optional: on Dismiss, re-arm the request with the dismissed dir added to knownDirs until its original expiresAt, or list the limit under Known gaps.",
  "evidence": "resolveFlowLinks and usePendingFlowLinks.dismiss at d7b0f7058.",
  "confidence": "high"
 },
 {
  "id": "PC-007",
  "severity": "info",
  "reviewer": "review-pr-contract",
  "file": ".metaproject/flows/517-2026-11-23-desktop-review-v2-stage-1-github-slice-a/journal.md",
  "quote": "All named mutants red. Desktop tsc 0, `bun test src` 1051/0; root tsc 0; root focused 44/0.",
  "problem": "PR body Verification: 'Root focused suites: 44 pass, 0 fail.' and 'named mutants from both review rounds are red'. This journal line is their only source. The package names no root suite command, no mutant list (for example R2-17, R2-22, R2-23, R2-25, R2-26, S02/S03/S09/S17/S21/S42/S44/S46/S47/S60) and no red result for round 2. The 1051/0 Desktop count is backed by research-evidence/verify-tests-to-run-2.txt; these two claims are not. Unverified, not contradicted.",
  "impact": "The closure of TP-R2-002..009 rests on mutants being red. A reader cannot tell which mutants were run or against which suites. The cost is limited to trust in the Verification section.",
  "suggested_fix": "Record the round-2 mutant list with one result each, and the root suite command that gave 44/0, in journal.md (or the review package). Or narrow the body to the runs the package records.",
  "evidence": "keryx ctx rg 'mutant|R2-17|S02|S09' over journal.md and resolved/T18,T19.implement.json: only journal.md:110 matches. verify-tests-to-run-1.txt ran a wider root set (2722 pass, 1 fail, a searchable-sources timeout that passes alone in -2.txt). Settled by: a mutation log for round 2 or a re-run by the testing lane.",
  "confidence": "medium"
 },
 {
  "id": "SC3-001",
  "severity": "info",
  "reviewer": "review-security-code",
  "file": "src/lib/file-lock.ts",
  "quote": "      const age = statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs;\n      if (age !== undefined && Date.now() - age > staleMs) {\n        try {\n          rmSync(lockPath, { force: true });",
  "problem": "Stale takeover can admit two holders. (a) Two waiters stat the same stale lock; one removes it and takes a fresh lock; the other then removes that fresh lock on the strength of its earlier stat and takes its own. (b) A holder whose section outlives staleMs (2 s for flags.json: a paused process or a stalled disk) is broken and still completes its write; the nonce only stops it deleting the new lock. The helper is unchanged in this range; this PR makes flags.json writers depend on it with a 2 s stale window.",
  "impact": "No attacker vector: every lock party is a same-user keryx process. Outcome under the trigger (a crashed holder plus two concurrent waiters interleaving within microseconds, or a holder paused past 2 s): one flag change (pin, archive, flow, subject) is silently lost, the residual of HW2-001. Rare and narrow.",
  "suggested_fix": "Optional, track separately (the helper is shared with the project registry and the serve credential store): break a stale lock by renaming it to a unique name and re-checking its mtime/nonce before deleting, or acquire through link(2), so a waiter never removes a lock it did not stat.",
  "evidence": "src/lib/file-lock.ts withFileLock: acquire `openSync(lockPath, \"wx\", 0o600)`; on failure `statSync(...)?.mtimeMs` then `rmSync(lockPath)` with no re-check between them; the finally removes only when `readFileSync(lockPath) === nonce`. organize.ts withFlagsLock passes `staleMs: FLAGS_LOCK_STALE_MS` (2_000). git log -- src/lib/file-lock.ts: 18f169be5, 05a9a8e36 (both before base).",
  "confidence": "medium",
  "blocking_merge": false,
  "dedupe_key": "file-lock-stale-takeover-two-holders"
 },
 {
  "id": "UX-012",
  "severity": "info",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/styles/review.css",
  "line": null,
  "quote": ".pr-work-link.pr-work-offer { display: block; box-sizing: border-box; line-height: 22px; cursor: default; color: var(--fg); border-style: dashed; }",
  "problem": "Criterion: Nielsen #4; Slop T3 (hover only where clickable). The offer span carries pr-work-link, so it gets the bordered and dashed box of the slot's actions. The existing `.pr-work-link:hover:not(:disabled)` also matches a span, because a span is never :disabled, so hovering changes its background. Clicking it does nothing.",
  "impact": "The question reads as a third button next to Link and Dismiss. Users may click it expecting to open the Flow.",
  "suggested_fix": "Give the offer its own class without the button box, or exclude it from the hover rule (`.pr-work-link:not(.pr-work-offer):hover`).",
  "evidence": "review.css: `.pr-work-link:hover:not(:disabled), .pr-work-more:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }`; FlowOffer uses `<span className=\"pr-work-link pr-work-offer\">`. Not observed on a render.",
  "confidence": "medium",
  "dedupe_key": "pr-flow-offer-false-affordance"
 },
 {
  "id": "UX-013",
  "severity": "info",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/issues/IssuesBoard.tsx",
  "line": null,
  "quote": "<p>{error}</p>",
  "problem": "Criterion: Nielsen #2, consistency. The new unavailable branch renders the error unchanged, so 'configuration: This project has no GitHub.com fetch remote.', 'configuration: GitHub has Issues turned off for owner/repo. ...' and 'configuration: Invalid Issues request.' all show the machine prefix. ReviewBoard strips the same prefixes.",
  "impact": "The first thing a user sees on first visiting the Issues tab, in such a project, is an internal error kind.",
  "suggested_fix": "Strip /^(access|configuration|unavailable):\\s*/i as ReviewBoard does, or share one display helper.",
  "evidence": "ReviewBoard.tsx: `error.replace(/^(access|configuration|unavailable):\\s*/i, \"\")`. IssuesBoard.dom.test.tsx feeds 'configuration: This project has no GitHub.com fetch remote.' into this branch. Round-2 UX-008 noted the prefix as pre-existing elsewhere; this block is new.",
  "confidence": "high",
  "dedupe_key": "issues-fallback-error-prefix-verbatim"
 },
 {
  "id": "UX-014",
  "severity": "info",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/review/ReviewBoard.tsx",
  "line": null,
  "quote": "is not in a repository this board shows",
  "problem": "Criterion: Nielsen #9. The other-repository focus banner states the cause and offers only Dismiss. The user came from the PR link in the session header, intending to see that PR. The focus request carries {repo, number, nonce} but not the url that App holds in subject.url.",
  "impact": "The user's intent ends in a dead end in the app. They must open the PR on GitHub themselves.",
  "suggested_fix": "Pass url with the focus request and add an 'Open on GitHub' action to the banner.",
  "evidence": "App.tsx onOpenSubject: `setReviewFocus({ repo: subject.repo, number: subject.number, nonce: ++focusNonce.current })`. ReviewBoard focusNotice banner has only the Dismiss icon button. An improvement on base, where the request stayed armed silently. I did not check whether the session header also has a direct GitHub link.",
  "confidence": "medium",
  "dedupe_key": "review-focus-notice-no-remedy"
 },
 {
  "id": "UX-015",
  "severity": "info",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/issues/IssuesBoard.tsx",
  "line": null,
  "quote": "\" If this keryx is older than Desktop, update keryx or choose the bundled CLI in Desktop Settings.\"",
  "problem": "Criterion: Nielsen #4 and #6. The hint says 'the bundled CLI', but Settings labels the option 'Bundled keryx'.",
  "impact": "The user has to map two names while searching Settings. Minor friction.",
  "suggested_fix": "Use the Settings label ('choose Bundled keryx in Settings'), ideally as a button that opens that Settings tab.",
  "evidence": "apps/desktop/src/shell/SettingsView.tsx: `{ id: \"bundled\", label: \"Bundled keryx\", ... }`.",
  "confidence": "high",
  "dedupe_key": "issues-older-keryx-hint-setting-name"
 },
 {
  "id": "UX-016",
  "severity": "info",
  "reviewer": "review-ui-ux",
  "file": "apps/desktop/src/review/PrWorkRow.tsx",
  "line": null,
  "quote": "const offer = flow ? undefined : work.flowOffer?.(sessions);",
  "problem": "Criterion: Nielsen #1. Create Flow switches to the session view (openPrSession calls setView('session')), and the package is made during that session's turn. The offer is rendered only in the PR work row. Nothing in the session, the tab indicator or a live region mentions it. The owner chose the work row as its place (AC9 re-frozen), so this is info.",
  "impact": "A user who stays in the session never sees the question, and the Flow stays unlinked: safe, but easy to miss.",
  "suggested_fix": "Also show the question in the bound session (a notice with Link and Dismiss), or mark the Pull requests tab while an offer is pending.",
  "evidence": "App.tsx openPrSession: `setView(\"session\")`. flowOffers reach only ReviewBoard to PrWork.flowOffer. Not observed in the app.",
  "confidence": "medium",
  "dedupe_key": "pr-flow-offer-not-visible-from-session"
 }
]
```

## Token spend

token spend: unknown (30 dispatch(es), none reported usage)
