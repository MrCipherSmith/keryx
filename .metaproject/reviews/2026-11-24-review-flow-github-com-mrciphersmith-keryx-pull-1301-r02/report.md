Reviewed SHA: b2043b98dba98f8b86bbd444e1e2ac99a88a4e1a (head of https://github.com/MrCipherSmith/keryx/pull/1301; delta round over f43a13c3f35e488744bb8906c2c275d433f8d98b..b2043b98dba98f8b86bbd444e1e2ac99a88a4e1a; merge-base a5d1ab236fe85dee62a758a19390049dde4eb7f9)

# Managed Review Report — round 3 (delta, fix round 2)

Evidence level: ran — tests-to-run at the head (core tree/explorer, Desktop tsc and the whole Desktop suite, exit 0: research-evidence/verify-tests-to-run-1.txt); testing reviewers re-ran the Desktop tree/view/platform suites (141 pass); the verifier executed a repro of r3-regression-w1-F-001 in a scratch worktree (research-evidence/verify-regression-w1-F-001.txt). Other reviewer findings are static reads.

round cap: round 3 of 5

## Prior findings — dispositions

9 round-2 findings attached to the FIX slice (slice-01), judged by 11 reviewers against the code at b2043b98d:

- r2-architecture-w1-F-001: closed (permit-refusal retry implemented)
- r2-architecture-w2-F-001: partial (comment still hard-codes 'eight'; no note at MAX_ACTIVE)
- r2-clean-code-w1-F-002: partial (same comment)
- r2-frontend-w2-F-001: regressed (dead Retry gone, the early return introduced r3-regression-w1-F-001)
- r2-ui-ux-w2-UX-001: regressed (same)
- r2-logic-w2-F-001: open (operator-accepted: a retired in-flight read keeps its slot)
- r2-performance-w2-F-001: closed
- r2-style-w2-F-002: closed
- r2-testing-practices-w2-F1: closed

## Regressions the fixes introduced

- [r3-regression-w1-F-001] major, verifier CONFIRMED by execution — answering r2-ui-ux-w2-UX-001 / r2-frontend-w2-F-001: a stale-snapshot tree read now returns after onStale() and leaves the folder (or its Show more page) loading; Refresh catalog that returns the same snapshotId clears the banner but nothing re-reads it, so the row stays 'Loading…' with no recovery until a real snapshot change or a remount. Reported by 11 reviewers (merged_from).
- [r3-architecture-w1-F-001] the permit retry (answering r2-architecture-w1-F-001) recognises the Rust refusal by raw message text in the hook, bypassing the transport's error classification.
- [r3-logic-w5-F-002] the anchored focus hand-off (answering r2-logic-w1-F-001) falls back to the raw index when the anchor row leaves in the same commit.

## Stage counts

- Reviewer dispatches: 30 of 30 returned (11 FIX slice-01, 13 NEW slice-02/03, 6 SECOND-LOOK slice-04/05/06).
- Raw findings: 33; after merging two duplicate clusters: 20 canonical (0 blocker, 1 major, 7 minor, 12 info). Pre-filter dropped: 0.
- Verifier (Wave C): 1 dispatch on the major — confirmed by execution.
- Premise judge (Wave D) over 8: 7 upheld, 1 challenged and held for the operator (r3-style-w1-F-001), 0 downgraded.

## Findings by severity

### Blocker (0)

### Major (1)

- [r3-regression-w1-F-001] (review-regression; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Regression introduced by the fix for r2-ui-ux-w2-UX-001 / r2-frontend-w2-F-001. useMetaprojectTree.read() now returns right after onStale() on a stale-snapshot error. The folder stays {status: 'loading'}, or for a page read keeps more: {sta

### Minor (7)

- [r3-architecture-w1-F-001] (review-architecture; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — This answers r2-architecture-w1-F-001, which suggested treating the transport's 'unavailable' as a retryable back-off. The fix puts that classification in the view-model hook (useMetaprojectTree.ts), which matches the raw Rust error text 'u
- [r3-clean-code-w1-F-001] (review-clean-code; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Documentation drift introduced by the fix for r2-architecture-w1-F-001 and r2-clean-code-w1-F-002. The rewritten MAX_TREE_READS doc (:14-17) now says the permits are shared by every project window, that the cap 'only bounds this tree's shar
- [r3-clean-code-w1-F-002] (review-clean-code; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — SRP, two change drivers in one function. read() was about 40 lines before this delta and is 56 now, past the 40-line threshold. It builds the request, schedules through the limiter, checks the snapshot, merges pages and classifies failures 
- [r3-clean-code-w2-F-001] (review-clean-code; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — Documentation drift in a symbol the delta changed. The new stale-snapshot branch in read() returns after onStale(). Its comment says: 'The row stays loading; a Retry here would only send the retired snapshot again'. So a folder whose first 
- [r3-logic-w5-F-002] (review-logic; premise: upheld) `apps/desktop/src/metaproject/MetaprojectTree.tsx` — The hand-off anchors to the row just before the focused one. For a focused more:P row whose parent's last entry C is an expanded folder still loading, that anchor is status:C. If C's children and P's next page arrive in one commit, both row
- [r3-style-w1-F-001] (review-style; premise: challenged) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — One function has three names in fix round 2's permit-retry code. The module default is `sleep`. The hook's injected option is `wait` (`wait = sleep`). Inside read() it is destructured as `wait: pause` and called as `await pause(...)`. A rea
- [r3-testing-practices-w2-F1] (review-testing-practices; premise: upheld) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — tdd-workflow.mdc Rule 3 (new branch with no test). The permit retry added in this round has two snapshot-generation guards: `|| !current()` before the wait and `if (!current()) throw cause;` after it, so a read whose snapshot was retired du

### Info (12)

- [r3-clean-code-w1-F-003] (review-clean-code) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The retry recognises a permit refusal only by the English text of a Rust error string. Nothing shared ties the two: `unavailable` is not in METAPROJECT_ERROR_CODES, so the transport passes the raw message through. The literal now lives in t
- [r3-clean-code-w2-F-002] (review-clean-code) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The new permit retry recognises a refusal by the human-readable text of a Rust error string. The literal now has three copies: apps/desktop/src-tauri/src/metaproject.rs:199 (`Err("unavailable: Too many Metaproject reads. Retry shortly.".int
- [r3-highload-w1-F-001] (review-highload) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — This answers the round-2 permit concern (r2-architecture-w1-F-001's alternative, a retry on 'unavailable'). The new permit retry stops only when the snapshot generation changes (`current()`). The generation is bumped only by a snapshot chan
- [r3-highload-w2-F-001] (review-highload) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The retry trigger matches a prefix of the error text from metaproject.rs:199 ("unavailable: Too many Metaproject reads. Retry shortly."). The tests build the refusal from their own copy of the literal (PERMIT_REFUSAL in MetaprojectTree.dom.
- [r3-logic-w4-F-001] (review-logic) `src/integrations/metaproject-explorer-v2.ts` — MetaprojectTreeV2.partial is documented as 'The source behind the scope is missing or incomplete', but the wiki scope always answers partial: false, including when the wiki layer is absent (model.hasWikiLayer === false).
- [r3-performance-w1-F-001] (review-performance) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The permit retry added in fix round 2 (answering r2-architecture-w1-F-001's back-off suggestion) runs inside the limit() task, so its backoff wait holds one of the MAX_TREE_READS = 3 slots. The waits are 150 ms + U(0,150) and then 300 ms + 
- [r3-performance-w2-F-001] (review-performance) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The permit-retry wait re-checks only the snapshot generation, which changes on a snapshot change and not on unmount, and the hook has no unmount cleanup. A retry whose wait ends after the explorer unmounts still sends the read.
- [r3-style-w1-F-002] (review-style) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — `PERMIT_RETRIES` is exported, but nothing outside useMetaprojectTree.ts imports it. The only references are its declaration (:21) and two uses inside the module (:165, :171). Its sibling `PERMIT_WAIT_MS` is module-private. Fix round 2 added
- [r3-style-w2-F-001] (review-style) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — `PERMIT_RETRIES` is newly exported, but nothing imports it: its only uses are inside useMetaprojectTree.ts, and the new tests assert the count with literals (`toHaveLength(3)`, `waits` length 2) rather than importing it, unlike `MAX_TREE_RE
- [r3-style-w2-F-002] (review-style) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — The style checklist rates `console.error` in production code as minor and suggests the project logger. Here it is the fix that r2-clean-code-w1-F-001 asked for, Desktop has no logger (no logger module under apps/desktop/src/lib), and two ot
- [r3-style-w2-F-003] (review-style) `apps/desktop/src/metaproject/useMetaprojectTree.ts` — In `attempt(retries)`, `retries` is the number of retries still left, and the wait derives the retry ordinal back from it (`PERMIT_RETRIES - retries + 1`). The name reads as a total or a count done, so the backoff line takes a second look.
- [r3-testing-practices-w2-F2] (review-testing-practices) `apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx` — In the new `refusing` helper, the following `if (answer instanceof Error) return Promise.reject(answer);` can never run: `answer` is always SRC_PAGE or ROOT_PAGE, neither an Error. Refusals are produced by the line above it.

## Not run

- Mutation pass: not run (testing reviewers proposed 12 and 14 candidates; keryx review mutate outside reviewer permissions).
- Native walkthrough, live render, screen reader, WKWebView focus: not run.
- Slicer note: slice-03 showed round-1 hunks of apps/desktop/src/platform/metaproject.ts that are not in this range (file unchanged in f43a13c3f..b2043b98d); reviewers read the head file instead.

```json keryx:findings
[
 {
  "id": "r3-architecture-w1-F-001",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "This answers r2-architecture-w1-F-001, which suggested treating the transport's 'unavailable' as a retryable back-off. The fix puts that classification in the view-model hook (useMetaprojectTree.ts), which matches the raw Rust error text 'unavailable: Too many Metaproject reads'. The transport layer is the one that maps Rust error strings to typed errors: requestMetaprojectV2 matches METAPROJECT_ERROR_CODES prefixes and throws MetaprojectRequestError. Here the hook reaches past that boundary to a string owned by apps/desktop/src-tauri/src/metaproject.rs:199. Nothing ties the two: the Rust side has no reference to the TS consumer, and the DOM test defines its own copy of the literal (MetaprojectTree.dom.test.tsx:503 PERMIT_REFUSAL).",
  "impact": "No defect today: the strings match. If the Rust message is reworded, isPermitRefusal stops matching and retries silently stop. Folders then fail on the first busy permit, the behaviour this fix round removed. The test suite stays green because it injects its own copy of the string. Any other caller that wants the same back-off, such as the explorer's own reads, would have to copy the literal a third time.",
  "suggested_fix": "Classify the refusal once, in the transport. For example, in platform/metaproject.ts, export an isMetaprojectPermitRefusal(error) helper (or a typed 'busy' error) next to the existing code mapping in requestMetaprojectV2. Have the hook and the test import it. Add a comment at metaproject.rs:199 naming the Desktop consumer so the Rust side sees the contract.",
  "evidence": "useMetaprojectTree.ts:24 `const isPermitRefusal = (cause: unknown) => errMessage(cause).startsWith(\"unavailable: Too many Metaproject reads\");`. platform/metaproject.ts:293-296 maps `<code>: ` prefixes to MetaprojectRequestError. 'unavailable' is not in METAPROJECT_ERROR_CODES (metaproject-explorer-contract.ts:329-331), so the raw Error passes through and the hook re-parses it. `keryx ctx rg --all \"Too many Metaproject\" apps/desktop` finds 3 sites: metaproject.rs:199 (producer), useMetaprojectTree.ts:24 (consumer), MetaprojectTree.dom.test.tsx:503 (test's own copy).",
  "confidence": "high",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "const isPermitRefusal = (cause: unknown) => errMessage(cause).startsWith(\"unavailable: Too many Metaproject reads\");",
  "dedupe_key": "metaproject-permit-refusal-string-coupled-in-hook",
  "blocking_merge": false,
  "source": "internal",
  "merged_from": [
   "r3-architecture-w2-F-001",
   "r3-testing-practices-w1-F-001"
  ],
  "reported_by": [
   "review-architecture",
   "review-testing-practices"
  ]
 },
 {
  "id": "r3-clean-code-w1-F-001",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": 131,
  "quote": "// Reads wait in order for a free slot, so re-reading many expanded folders never exhausts the\n  // read permits Desktop shares with the explorer's own reads.",
  "problem": "Documentation drift introduced by the fix for r2-architecture-w1-F-001 and r2-clean-code-w1-F-002. The rewritten MAX_TREE_READS doc (:14-17) now says the permits are shared by every project window, that the cap 'only bounds this tree's share', and that a read refused a permit is retried. The new attempt() retry (:159-169) exists because exhaustion can still happen. The comment above limit() (:131-132), whose body this delta edited, still promises the opposite: the limiter 'never exhausts the read permits'. Two comments describe one behaviour in opposite ways.",
  "impact": "A reader trusting :131 will treat the permit-refusal retry as dead code, or will remove it. The next person sizing MAX_TREE_READS gets two contradictory statements of what it guarantees.",
  "suggested_fix": "Reword :131-132 to match :14-17, for example: '// Reads wait in order for a free slot, so this tree holds at most MAX_TREE_READS of the read permits; a refusal while other windows hold the rest is retried in read().'",
  "evidence": "useMetaprojectTree.ts:14-17 (new doc: 'this only bounds this tree's share; a read refused a permit is retried'), :131-132 (unchanged comment: 'never exhausts the read permits'), :138-141 (limit body edited in this delta), :159-169 (new retry on isPermitRefusal). apps/desktop/src-tauri/src/metaproject.rs:186 `const MAX_ACTIVE: usize = 8;` on a process-wide static.",
  "confidence": "high",
  "location_class": "in-diff",
  "dedupe_key": "metaproject-tree-limiter-comment-contradicts-permit-retry",
  "source": "internal"
 },
 {
  "id": "r3-clean-code-w1-F-002",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": 160,
  "quote": "const attempt = async (retries: number): Promise<MetaprojectTreeV2> => {",
  "problem": "SRP, two change drivers in one function. read() was about 40 lines before this delta and is 56 now, past the 40-line threshold. It builds the request, schedules through the limiter, checks the snapshot, merges pages and classifies failures into tree state. The delta adds a third concern inside it: the transport's permit-contention back-off. That covers recognising the refusal, a linear-plus-jitter delay formula, a retry count and the generation check between attempts. The two concerns change for different reasons: Rust permit semantics on one side, and the tree's folder model on the other. The back-off captures only `send`, `root`, `input`, `pause` and `current` from read(), so it does not belong there.",
  "impact": "Tuning the retry policy (count, delay, which errors qualify) means editing the tree's state-update function. The policy can be tested only through the DOM tree tests (MetaprojectTree.dom.test.tsx:518-544), not on its own.",
  "suggested_fix": "Lift it to module scope next to isPermitRefusal, for example `async function withPermitRetry<T>(run: () => Promise<T>, { wait, live }: { wait: (ms: number) => Promise<void>; live: () => boolean }, retries = PERMIT_RETRIES): Promise<T>`. read() then calls `withPermitRetry(() => send(root, input), { wait: pause, live: current })`.",
  "evidence": "useMetaprojectTree.ts:151-206 (read, 56 lines at head; about 40 of them before this delta's 16 added lines, per the hunk offsets -137/+152 and -156/+182), :159-169 (attempt closure), :21-25 (the retry constants and predicate are already module-scope).",
  "confidence": "medium",
  "location_class": "in-diff",
  "dedupe_key": "metaproject-tree-read-embeds-permit-retry-policy",
  "source": "internal"
 },
 {
  "id": "r3-clean-code-w1-F-003",
  "reviewer": "review-clean-code",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": 24,
  "quote": "const isPermitRefusal = (cause: unknown) => errMessage(cause).startsWith(\"unavailable: Too many Metaproject reads\");",
  "problem": "The retry recognises a permit refusal only by the English text of a Rust error string. Nothing shared ties the two: `unavailable` is not in METAPROJECT_ERROR_CODES, so the transport passes the raw message through. The literal now lives in three places: metaproject.rs:199, useMetaprojectTree.ts:24 and the test fixture MetaprojectTree.dom.test.tsx:503.",
  "impact": "If the Rust message is reworded, the retry silently stops and the folders show the error right away. The test keeps passing, because the fixture holds its own copy of the string. No defect today: the strings match.",
  "suggested_fix": "Optional. At metaproject.rs:199, add a comment saying that Desktop's tree matches this prefix (useMetaprojectTree.ts isPermitRefusal), or add a Rust test that asserts the exact refusal text. Longer term, a typed code for permit refusal would replace the string match.",
  "evidence": "keryx ctx rg 'Too many Metaproject' apps/desktop/src-tauri/src finds only metaproject.rs:199 `Err(\"unavailable: Too many Metaproject reads. Retry shortly.\".into())`. platform/metaproject.ts:294-296 maps only METAPROJECT_ERROR_CODES prefixes and rethrows the rest unchanged. metaproject-explorer-contract.ts:329-331 has no 'unavailable'. Test fixture: MetaprojectTree.dom.test.tsx:503.",
  "confidence": "high",
  "location_class": "in-diff",
  "dedupe_key": "metaproject-tree-permit-refusal-string-coupling",
  "source": "internal"
 },
 {
  "id": "r3-clean-code-w2-F-001",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "  /** The next page: being read, or its read failed. */",
  "problem": "Documentation drift in a symbol the delta changed. The new stale-snapshot branch in read() returns after onStale(). Its comment says: 'The row stays loading; a Retry here would only send the retired snapshot again'. So a folder whose first read answers stale-snapshot keeps `status: \"loading\"`, and a stale next page keeps `more: { status: \"loading\" }`, with no request in flight. The field docs that define those states still describe the old rule. TreeFolder.more reads 'The next page: being read, or its read failed.' MetaprojectTreeModel.ensure reads 'Reads `parent`'s first page unless it is loaded, being read, or failed.' MetaprojectTreeModel.more reads 'a page already being read is not asked for again'. The same state is now documented two ways: the catch comment says the row waits for Refresh catalog, and the type docs say a read is in progress.",
  "impact": "A maintainer who reads the type docs will take a 'loading' folder or page to mean a request is pending. They may then add a timeout or a dedupe, or debug a 'stuck' Loading row, without knowing that the state also means 'waiting for Refresh catalog after a stale answer'. ensure() and more() deliberately do not re-read in that state, so that state is how a stale row is kept from being re-sent.",
  "suggested_fix": "Extend the three docs with the stale case. For example, TreeFolder.more: '/** The next page: being read, waiting for Refresh catalog after a stale-snapshot answer, or its read failed. */'. On ensure and more, add: 'loading also covers a read answered stale-snapshot; Refresh catalog (a new snapshot) re-reads it'. Alternatively, give the state its own name (for example `status: \"stale\"`) and render it as a loading row, so the type says what the comment says.",
  "evidence": "useMetaprojectTree.ts at b2043b98d, read() catch: `if (cause instanceof MetaprojectRequestError && cause.code === \"stale-snapshot\") { latest.current.onStale(); return; }`. It is preceded by the comment 'The row stays loading; a Retry here would only send the retired snapshot again.' The same file holds TreeFolder.more ('being read, or its read failed') and the MetaprojectTreeModel.ensure and more docs ('being read'). The tests added in this round assert the new behaviour: MetaprojectTree.dom.test.tsx 'a next page refused as stale-snapshot tells the explorer and leaves no dead Retry row', and the MetaprojectView test's deadRetry() check.",
  "confidence": "high",
  "reviewer": "review-clean-code",
  "location_class": "in-diff",
  "source": "internal"
 },
 {
  "id": "r3-clean-code-w2-F-002",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "const isPermitRefusal = (cause: unknown) => errMessage(cause).startsWith(\"unavailable: Too many Metaproject reads\");",
  "problem": "The new permit retry recognises a refusal by the human-readable text of a Rust error string. The literal now has three copies: apps/desktop/src-tauri/src/metaproject.rs:199 (`Err(\"unavailable: Too many Metaproject reads. Retry shortly.\".into())`), useMetaprojectTree.ts:24, and MetaprojectTree.dom.test.tsx:503 (`PERMIT_REFUSAL`). Rewording the Rust message would turn the retry off without any test failing: the test feeds its own copy of the string.",
  "impact": "A wording change in metaproject.rs silently drops the retry, and a permit refusal goes back to being a terminal folder error. Rated info, not minor: matching the `unavailable:` message prefix is this codebase's established idiom for Tauri string errors (githubAccounts.ts:28 and review.ts:35 do the same), so by Clean Code law 5 it is not a violation.",
  "suggested_fix": "Optional: export the prefix as a named constant from useMetaprojectTree.ts and import it in the test, so the TS side has one copy. Add a comment at metaproject.rs:199 noting that Desktop matches this text. Or have the Rust side return a stable token, for example a 'permits-busy' marker, if the error shape ever moves off plain strings.",
  "evidence": "Found with `keryx ctx rg -n \"Too many Metaproject reads\" apps/desktop/src apps/desktop/src-tauri/src/metaproject.rs`: 3 sites. Prefix matching elsewhere, from `keryx ctx rg \"startsWith\\(\\\"unavailable|unavailable:\"`: githubAccounts.ts:28 and review.ts:35.",
  "confidence": "medium",
  "reviewer": "review-clean-code",
  "location_class": "in-diff",
  "publication": "finding",
  "source": "internal"
 },
 {
  "id": "r3-highload-w1-F-001",
  "reviewer": "review-highload",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "if (retries <= 0 || !isPermitRefusal(cause) || !current()) throw cause;",
  "problem": "This answers the round-2 permit concern (r2-architecture-w1-F-001's alternative, a retry on 'unavailable'). The new permit retry stops only when the snapshot generation changes (`current()`). The generation is bumped only by a snapshot change, never on unmount. A read refused a permit while its MetaprojectView is closing (the project window closes, or the user leaves the explorer) therefore still waits and re-sends up to PERMIT_RETRIES times after the hook is gone. Each re-send that gets a permit spawns a CLI child under the 150 s Rust bound, and its answer goes to an unmounted component.",
  "impact": "The work is bounded: at most MAX_TREE_READS (3) reads x 2 retries per unmounted tree, with waits of about 750 ms at most. The trigger is the case the retry exists for: every permit taken, e.g. several project windows re-reading at once, while one of them closes. It then competes for the same shared permits with the windows still open. No data is harmed, and before this round the first attempt already outlived unmount, so this is a small extension of existing behaviour, not a new class.",
  "suggested_fix": "Optional: bump `generation.current` in an unmount cleanup (useEffect(() => () => { generation.current++; }, [])). The existing `current()` checks then stop queued reads, pending retries and late answers alike.",
  "evidence": "useMetaprojectTree.ts: `generation.current++` appears only inside `if (state.current.graph.snapshot !== snapshot)`. attempt() re-checks `current()` before and after `pause(...)`. No effect cleanup exists in the hook (it imports only useCallback, useMemo, useReducer, useRef). Refusal text: apps/desktop/src-tauri/src/metaproject.rs:199 `Err(\"unavailable: Too many Metaproject reads. Retry shortly.\".into())`, returned by ReadPermit::acquire before the child is run.",
  "confidence": "high",
  "dedupe_key": "metaproject-tree-permit-retry-outlives-unmount",
  "blocking_merge": false,
  "source": "internal"
 },
 {
  "id": "r3-highload-w2-F-001",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "const isPermitRefusal = (cause: unknown) => errMessage(cause).startsWith(\"unavailable: Too many Metaproject reads\");",
  "problem": "The retry trigger matches a prefix of the error text from metaproject.rs:199 (\"unavailable: Too many Metaproject reads. Retry shortly.\"). The tests build the refusal from their own copy of the literal (PERMIT_REFUSAL in MetaprojectTree.dom.test.tsx), so nothing ties the TypeScript match to the Rust message.",
  "impact": "If the Rust message is reworded, permit refusals under multi-window pressure (8 process-wide permits) become terminal folder errors again, the round-2 highload defect, and the tests still pass. Nothing fails today: this is a drift risk.",
  "suggested_fix": "Share one constant for the prefix, or have the Rust side return a stable code (e.g. `unavailable:busy`), and assert in metaproject.rs's tests that the refusal text starts with it.",
  "evidence": "useMetaprojectTree.ts:24 isPermitRefusal; metaproject.rs:199 Err(\"unavailable: Too many Metaproject reads. Retry shortly.\"); MetaprojectTree.dom.test.tsx PERMIT_REFUSAL literal.",
  "confidence": "medium",
  "reviewer": "review-highload",
  "location_class": "in-diff",
  "publication": "finding",
  "source": "internal"
 },
 {
  "id": "r3-logic-w4-F-001",
  "severity": "info",
  "file": "src/integrations/metaproject-explorer-v2.ts",
  "line": null,
  "quote": "const { entries, partial } = scope === \"graph\" ? graphTree(this.model, parent) : { entries: wikiTree(this.model.nodes, parent), partial: false };",
  "problem": "MetaprojectTreeV2.partial is documented as 'The source behind the scope is missing or incomplete', but the wiki scope always answers partial: false, including when the wiki layer is absent (model.hasWikiLayer === false).",
  "impact": "No observable defect today: Desktop reads `partial` only for the graph empty-state (MetaprojectTree.tsx: 'The graph is not built yet' vs 'No indexed files') and shows 'No Wiki pages.' for an empty wiki root either way. The doc comment overstates what the field means for wiki, which a later client could rely on.",
  "suggested_fix": "Either answer `partial: !this.model.hasWikiLayer` for scope wiki, or narrow the doc comment to say `partial` reports a graph that is not built.",
  "evidence": "metaproject-explorer-contract.ts MetaprojectTreeV2 doc comment on `partial`; metaproject-explorer-v2.ts V2Read.tree hard-codes partial: false for wiki; apps/desktop/src/metaproject/MetaprojectTree.tsx empty-state branch uses root.partial only when scope === graph.",
  "confidence": "high",
  "reviewer": "review-logic",
  "location_class": "in-diff",
  "publication": "finding",
  "source": "internal"
 },
 {
  "id": "r3-logic-w5-F-002",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/MetaprojectTree.tsx",
  "line": null,
  "quote": "const next = anchor < 0 ? elements[Math.min(lost.index, elements.length - 1)] : elements[anchor + 1] ?? elements[anchor];",
  "problem": "The hand-off anchors to the row just before the focused one. For a focused more:P row whose parent's last entry C is an expanded folder still loading, that anchor is status:C. If C's children and P's next page arrive in one commit, both rows leave, anchor < 0, and focus goes to the old index, now one of C's new children, instead of P's first appended entry.",
  "impact": "In this rare concurrent case, keyboard focus lands on an unrelated, deeper row. It is the r2-logic-w1-F-001 class narrowed to an anchor that itself leaves.",
  "suggested_fix": "Anchor status rows to an entry of their own parent: for more:P record P's last entry row id and focus the next entry row with parent === P after it; for status:P use d:P. Fall back to the index only when that entry is gone.",
  "evidence": "MetaprojectTree.tsx layout effect; `before` recorded as rows[index - 1]?.id in onFocus and elements[index - 1]?.dataset.row in remember().",
  "confidence": "medium",
  "reviewer": "review-logic",
  "location_class": "in-diff",
  "source": "internal"
 },
 {
  "id": "r3-performance-w1-F-001",
  "reviewer": "review-performance",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "await pause(PERMIT_WAIT_MS * (PERMIT_RETRIES - retries + 1) + Math.random() * PERMIT_WAIT_MS);",
  "problem": "The permit retry added in fix round 2 (answering r2-architecture-w1-F-001's back-off suggestion) runs inside the limit() task, so its backoff wait holds one of the MAX_TREE_READS = 3 slots. The waits are 150 ms + U(0,150) and then 300 ms + U(0,150), up to about 750 ms per read on top of the refused calls.",
  "impact": "This costs latency only, and only while all 8 shared read permits are taken (several windows, or a re-read of many expanded folders after a snapshot change). Queued tree reads wait behind the backoff. They would mostly hit the same refusal if the slot were freed, so holding it is reasonable back-pressure. The retries are bounded, jittered and stop for a retired generation.",
  "suggested_fix": "None required. Optionally add a comment saying the backoff keeps its slot on purpose.",
  "evidence": "useMetaprojectTree.ts read(): `limit(() => current() && attempt(PERMIT_RETRIES).then(...))`. attempt() catches isPermitRefusal, awaits pause(...), re-checks current(), then recurses with retries - 1. limit() frees a slot only in `.finally` of the task promise. PERMIT_RETRIES = 2 and PERMIT_WAIT_MS = 150. Read from code; not measured.",
  "confidence": "high",
  "dedupe_key": "metaproject-tree-permit-retry-holds-slot",
  "blocking_merge": false,
  "source": "internal"
 },
 {
  "id": "r3-performance-w2-F-001",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "await pause(PERMIT_WAIT_MS * (PERMIT_RETRIES - retries + 1) + Math.random() * PERMIT_WAIT_MS);\n        if (!current()) throw cause;\n        return attempt(retries - 1);",
  "problem": "The permit-retry wait re-checks only the snapshot generation, which changes on a snapshot change and not on unmount, and the hook has no unmount cleanup. A retry whose wait ends after the explorer unmounts still sends the read.",
  "impact": "At most MAX_TREE_READS (3) extra CLI reads, within about 750 ms of unmount, and only while every read permit is taken. Negligible; no hot path.",
  "suggested_fix": "Optional: add useEffect(() => () => { generation.current++; }, []) so that current() is false after unmount and the retry throws instead of sending.",
  "evidence": "useMetaprojectTree.ts:160-168 (attempt/pause/current), :96 (the only generation bump, on a snapshot change); keryx ctx rg found no unmount effect in useMetaprojectTree.ts.",
  "confidence": "medium",
  "reviewer": "review-performance",
  "location_class": "in-diff",
  "publication": "finding",
  "source": "internal"
 },
 {
  "id": "r3-regression-w1-F-001",
  "reviewer": "review-regression",
  "severity": "major",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "      if (cause instanceof MetaprojectRequestError && cause.code === \"stale-snapshot\") {\n        latest.current.onStale();\n        return;\n      }",
  "problem": "Regression introduced by the fix for r2-ui-ux-w2-UX-001 / r2-frontend-w2-F-001. useMetaprojectTree.read() now returns right after onStale() on a stale-snapshot error. The folder stays {status: 'loading'}, or for a page read keeps more: {status: 'loading'}. Nothing in the hook moves a folder out of that state except a change of the `snapshot` prop, which bumps the generation and clears folders. ensure() skips any parent already in `folders`, so collapsing and re-expanding does not re-read it. more() refuses while more.status is 'loading'. retry() acts only on 'failed'. The comment says Refresh catalog 're-reads the tree', but that holds only when the refreshed catalog has a different snapshotId. MetaprojectView's catalog effect (non-quiet read) calls setCatalog(result) and setSnapshotMismatch(false) whatever the snapshotId is. When the refreshed catalog has the pinned snapshotId, the stale banner disappears, useMetaprojectTree receives the same `snapshot`, and the row stays 'Loading…' with no banner, no Retry and no way out until a later snapshot change or a remount. Before this fix the same path ended in 'failed' with a Retry, which in that case would have succeeded.",
  "impact": "The trigger is a stale-snapshot answer followed by a Refresh catalog that returns the pinned snapshotId. In practice the project knowledge changes and changes back (for example a wiki edit that is reverted) before the user selects Refresh. The quiet freshness re-read does not help, because with an equal snapshotId it only sets freshness (MetaprojectView.tsx, `if (quiet && result.snapshotId === loadedSnapshot.current)`). The affected folder or Show more row then shows a permanent spinner with no recovery control, and its subtree cannot be browsed for the rest of the session. The existing view test 'a tree answer for another snapshot, or a stale-snapshot refusal, shows the stale banner and none of its rows' walks exactly this path: treeExplorer's catalog always returns 's1'. After Refresh catalog the test asserts only that the banner has gone, never what the 'src' folder shows. Rare, but it never resolves on its own. It replaces a recoverable failure with a stuck state.",
  "suggested_fix": "Keep the banner-only behaviour, but do not leave a dead state. Choose one. (a) On stale-snapshot, delete the folder's entry, or for a page read clear `more`, so the parent counts as unread or Show more again. Then the next render or expand re-reads it under whatever snapshot is current. (b) Have the hook drop every non-ready folder when onStale's banner is cleared, for example by exposing a reset() that MetaprojectView calls in the Refresh-catalog path when the snapshotId is unchanged. (c) Make Refresh catalog always bump the tree's generation. Extend the view test: after Refresh catalog with an unchanged snapshot, assert that 'src' re-reads and shows its children, or at least is not 'Loading…'.",
  "evidence": "Read at head b2043b98d. useMetaprojectTree.ts read() catch: the stale-snapshot branch returns after onStale(). ensure(): `if (state.current[scope].folders.has(parent)) return;`. more(): returns when `folder.status !== \"ready\"` or `folder.more?.status === \"loading\"`. retry(): acts only on `status === \"failed\"` or `more.status === \"failed\"`. The generation reset happens only on `state.current.graph.snapshot !== snapshot`. MetaprojectView.tsx catalog effect (about lines 403-421): non-quiet path, setCatalog(result) and setSnapshotMismatch(false), with no comparison to the previous snapshot. The tree is mounted with `snapshot: catalog?.snapshotId ?? \"\"` (line 758). The Refresh catalog button is `setRevision(value => value + 1)` (line 881). MetaprojectView.dom.test.tsx:1942-1949: treeExplorer state.snapshot is 's1' and the catalog returns it. Lines 2139-2162: the stale test clicks Refresh catalog, checks only staleBanner() === false, then switches to Wiki. The base f43a13c3f set the folder to failed in this path (git diff f43a13c3f b2043b98d). Not executed (exec budget 0).",
  "confidence": "medium",
  "dedupe_key": "metaproject-tree-stale-snapshot-row-stuck-loading",
  "blocking_merge": false,
  "class_scope": {
   "sites": [
    "apps/desktop/src/metaproject/useMetaprojectTree.ts read() catch, stale-snapshot branch: a folder read (status stays loading)",
    "apps/desktop/src/metaproject/useMetaprojectTree.ts read() catch, stale-snapshot branch: a Show more page read (more.status stays loading)",
    "apps/desktop/src/metaproject/MetaprojectView.tsx catalog effect: Refresh catalog with an unchanged snapshotId clears the banner without resetting the tree"
   ],
   "enumeration_method": "Every path that writes or leaves a TreeFolder 'loading' in useMetaprojectTree.ts (ensure, more, retry and read's catch branches), crossed with every path that leaves it (the snapshot-prop generation reset, read success, the not-found and failed branches). I read all of them in the head file. The consumer side: `keryx ctx rg -n \"useMetaprojectTree|onStale|setSnapshotMismatch|Refresh catalog\" apps/desktop/src --all` gives 67 matches in 23 files. The only consumer of useMetaprojectTree is MetaprojectView.tsx:758, and the only place the banner is cleared is MetaprojectView.tsx:416."
  },
  "source": "internal",
  "merged_from": [
   "r3-degradation-w1-F-001",
   "r3-logic-w3-F-001",
   "r3-regression-w2-R-001",
   "r3-degradation-w2-F-001",
   "r3-frontend-w1-F-001",
   "r3-frontend-w2-F-001",
   "r3-logic-w1-F-001",
   "r3-logic-w5-F-001",
   "r3-ui-ux-w1-UX-001",
   "r3-ui-ux-w2-UX-001"
  ],
  "reported_by": [
   "review-degradation",
   "review-frontend",
   "review-logic",
   "review-regression",
   "review-ui-ux"
  ]
 },
 {
  "id": "r3-style-w1-F-001",
  "reviewer": "review-style",
  "severity": "minor",
  "problem": "One function has three names in fix round 2's permit-retry code. The module default is `sleep`. The hook's injected option is `wait` (`wait = sleep`). Inside read() it is destructured as `wait: pause` and called as `await pause(...)`. A reader at the call site must follow pause -> wait -> sleep to learn that this is the injectable test seam. The fix hunk added this code to answer prior finding r2-architecture-w1-F-001, which suggested retrying 'unavailable'.",
  "impact": "Readability only. The call site does not say it is the injected `wait`, and grepping for `wait(` or `pause` finds only half of the path. No behavioural effect.",
  "suggested_fix": "Keep one name. Destructure `wait` without renaming it (`const { cwd: root, request: send, wait } = latest.current;` then `await wait(...)`). Optionally name the default `defaultWait`, or keep `sleep`.",
  "evidence": "Slice-01 hunk @@ 158,170 `await pause(PERMIT_WAIT_MS * ...)`; head useMetaprojectTree.ts:155 `const { cwd: root, request: send, wait: pause } = latest.current;`; the hook signature `wait = sleep` with the doc comment 'Waits before a permit retry'. The existing `cwd: root` / `request: send` aliases are older and are not flagged.",
  "confidence": "medium",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": 155,
  "quote": "const { cwd: root, request: send, wait: pause } = latest.current;",
  "blocking_merge": false,
  "source": "internal"
 },
 {
  "id": "r3-style-w1-F-002",
  "reviewer": "review-style",
  "severity": "info",
  "problem": "`PERMIT_RETRIES` is exported, but nothing outside useMetaprojectTree.ts imports it. The only references are its declaration (:21) and two uses inside the module (:165, :171). Its sibling `PERMIT_WAIT_MS` is module-private. Fix round 2 added this export while answering prior finding r2-architecture-w1-F-001.",
  "impact": "A small widening of the module's public surface, with no consumer. It may be meant for tests, but none uses it.",
  "suggested_fix": "Optional. Drop `export`, or have the new permit-retry tests in MetaprojectTree.dom.test.tsx import it to state how many retries they expect.",
  "evidence": "keryx ctx rg 'PERMIT_RETRIES' apps/desktop/src/metaproject: 3 matches, all in useMetaprojectTree.ts (21, 165, 171). The rest of apps/desktop/src was not searched, but the hook is only consumed from apps/desktop/src/metaproject.",
  "confidence": "medium",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": 21,
  "quote": "export const PERMIT_RETRIES = 2;",
  "blocking_merge": false,
  "source": "internal"
 },
 {
  "id": "r3-style-w2-F-001",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "export const PERMIT_RETRIES = 2;",
  "problem": "`PERMIT_RETRIES` is newly exported, but nothing imports it: its only uses are inside useMetaprojectTree.ts, and the new tests assert the count with literals (`toHaveLength(3)`, `waits` length 2) rather than importing it, unlike `MAX_TREE_READS`, which the test file does import.",
  "impact": "An export with no importer widens the module surface and suggests a contract that nothing relies on.",
  "suggested_fix": "Drop `export`, or import it in MetaprojectTree.dom.test.tsx and assert `PERMIT_RETRIES + 1` calls and `PERMIT_RETRIES` waits, as the limiter test does with `MAX_TREE_READS`.",
  "evidence": "keryx ctx rg -n 'PERMIT_RETRIES' apps/desktop/src: 3 matches, all in useMetaprojectTree.ts (lines 21, 165, 171).",
  "confidence": "high",
  "reviewer": "review-style",
  "location_class": "in-diff",
  "source": "internal"
 },
 {
  "id": "r3-style-w2-F-002",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "console.error(\"Metaproject tree read failed unexpectedly\", error);",
  "problem": "The style checklist rates `console.error` in production code as minor and suggests the project logger. Here it is the fix that r2-clean-code-w1-F-001 asked for, Desktop has no logger (no logger module under apps/desktop/src/lib), and two other production files in Desktop already report this way (acp/client.ts, platform/panels.ts). Recorded as info, not minor, for that reason.",
  "impact": "None today; if Desktop gains a logger this call is one of three to move.",
  "suggested_fix": "No change now. If a Desktop logger is introduced, route this and the two other console.error/warn calls through it.",
  "evidence": "keryx ctx rg -c 'console\\.(error|warn)\\(' apps/desktop/src --glob '!*.test.*': acp/client.ts 1, platform/panels.ts 1, metaproject/useMetaprojectTree.ts 1.",
  "confidence": "high",
  "reviewer": "review-style",
  "location_class": "in-diff",
  "source": "internal"
 },
 {
  "id": "r3-style-w2-F-003",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "await pause(PERMIT_WAIT_MS * (PERMIT_RETRIES - retries + 1) + Math.random() * PERMIT_WAIT_MS);",
  "problem": "In `attempt(retries)`, `retries` is the number of retries still left, and the wait derives the retry ordinal back from it (`PERMIT_RETRIES - retries + 1`). The name reads as a total or a count done, so the backoff line takes a second look.",
  "impact": "Readability only; behaviour is correct (the tests assert 3 calls and 2 positive waits).",
  "suggested_fix": "Rename the parameter to `retriesLeft` (or pass the ordinal `retry` counting up and compare with `PERMIT_RETRIES`).",
  "evidence": "useMetaprojectTree.ts `const attempt = async (retries: number)` with `retries <= 0` guard and `attempt(retries - 1)` recursion; initial call `attempt(PERMIT_RETRIES)`.",
  "confidence": "medium",
  "reviewer": "review-style",
  "location_class": "in-diff",
  "source": "internal"
 },
 {
  "id": "r3-testing-practices-w2-F1",
  "severity": "minor",
  "file": "apps/desktop/src/metaproject/useMetaprojectTree.ts",
  "line": null,
  "quote": "if (retries <= 0 || !isPermitRefusal(cause) || !current()) throw cause;",
  "problem": "tdd-workflow.mdc Rule 3 (new branch with no test). The permit retry added in this round has two snapshot-generation guards: `|| !current()` before the wait and `if (!current()) throw cause;` after it, so a read whose snapshot was retired during the jittered wait is not re-sent with the retired expectedSnapshotId. Neither retry test changes the snapshot: 'a read refused for want of a read permit is retried after a short wait' and 'a permit refusal that outlasts the retries, or another unavailable answer, marks the folder failed' both render one Harness with the default SNAPSHOT and a `wait` that resolves at once.",
  "impact": "Deleting either guard leaves nothing in the diff's tests to notice; the next edit to the retry loop can re-send a retired snapshot (an extra stale-snapshot round trip and permit use per refused read) unprotected. No user-visible defect is claimed: the generation check after `attempt` still drops the answer.",
  "suggested_fix": "In MetaprojectTree.dom.test.tsx add one test with `refusing(1)` and a `wait` that returns a held promise: expand src, re-render the Harness with `snapshot: \"s2\"` while the wait is pending, then resolve the wait; assert the src calls made with expectedSnapshotId SNAPSHOT number exactly 1 (no retry under the retired snapshot) and that the s2 re-read of src lands (client.ts present) as the positive artifact.",
  "evidence": "Read the two retry tests in slice-02 (MetaprojectTree.dom.test.tsx, `refusing` helper and the two tests after it): neither passes `snapshot` to Harness nor re-renders mid-wait. The guards are at useMetaprojectTree.ts inside `attempt` (head lines ~159-166). Mutants M1 and M2 below would settle it; not run.",
  "confidence": "medium",
  "reviewer": "review-testing-practices",
  "source": "internal"
 },
 {
  "id": "r3-testing-practices-w2-F2",
  "severity": "info",
  "file": "apps/desktop/src/metaproject/MetaprojectTree.dom.test.tsx",
  "line": null,
  "quote": "const answer = input.parent === \"src\" ? SRC_PAGE : ROOT_PAGE;",
  "problem": "In the new `refusing` helper, the following `if (answer instanceof Error) return Promise.reject(answer);` can never run: `answer` is always SRC_PAGE or ROOT_PAGE, neither an Error. Refusals are produced by the line above it.",
  "impact": "Dead branch in a fixture; a reader may think the helper can serve an error page. No effect on what the tests pin.",
  "suggested_fix": "Drop the `instanceof Error` line (and widen nothing else).",
  "evidence": "slice-02, `refusing()` body.",
  "confidence": "high",
  "reviewer": "review-testing-practices",
  "publication": "finding",
  "source": "internal"
 }
]
```
