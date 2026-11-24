# Round 4 fix, lane A (apps/desktop): mutation checks

Each mutant was applied alone to the working tree at 4cb6c43ef plus the round-4 lane-A edits and the
orchestrator's contract edits. The named test was run from `apps/desktop` with `bun test <file>`. The file was
then restored byte for byte. The runner script and its specs (m1..m7 JSON) are scratch files outside the repo.
A mutant counts as killed when the named test is red.

Result: 32 mutants, 31 red on the first run. A25 (a notice raised 40 ms after the refusal) stayed green against
the first state-based version of the PC-004 check, because the fixture reaches Send about 6 ms after the
refusal. The check was then changed to also wait until the app's short timers have run. After that change
A25, A26, A27 and A31 are red.

| # | Finding | File | Mutation (product line reverted or broken) | Red test |
|---|---|---|---|---|
| A01 | RG-R4-001 | apps/desktop/src/issues/useIssueCollection.ts | The contract re-export replaced by the pre-fix local `repositoryUnavailable` regex (HEAD version, no "Open a Git project" reason) | IssuesBoard.dom: "AC13 a project with no GitHub.com remote, or a repository with Issues turned off, offers Assigned to me instead of Retry" |
| A02 | AR-R4-002 | apps/desktop/src/issues/IssuesBoard.tsx | `displayReason(error)` -> `error` | IssuesBoard.dom: both AC13 fallback tests ("not.toContain configuration:") |
| A03 | TP-R4-003 | apps/desktop/src/issues/IssuesBoard.tsx | `if (!focusSource.current) return;` deleted | IssuesBoard.dom: "TP-R4-003: the board leaves focus where it is on mount and on a source change it did not ask to focus" |
| A04 | AR-R4-002 | apps/desktop/src/review/ReviewBoard.tsx | banner `displayReason(error)` -> `error` | ReviewBoard.dom: "refresh failure preserves last available snapshot, access loss hides its cards and identity" |
| A05 | TP-R4-002 | apps/desktop/src/review/ReviewBoard.tsx | `if (!loading && !stale) settle(` -> `if (!loading) settle(` (stale arm dropped) | PrWorkRow.dom: "TP-R4-002: a focus that arrives while a cached fallback snapshot shows waits for a good load before it decides" |
| A06 | CC4-001 | apps/desktop/src/review/ReviewBoard.tsx | `onFocusHandled?.(focus.nonce)` dropped from the one settle helper | PrWorkRow.dom: 4 focus tests (session header focus, LG-009, FE-R3-001 refused, TP-R4-002) |
| A07 | CC4-001 | apps/desktop/src/review/ReviewBoard.tsx | `focused.current = focus.nonce` dropped from settle | PrWorkRow.dom: "a focus that nobody clears opens the panel once per nonce…", "TP-R3-004: a refused request is marked handled…" |
| A08 | FE-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | `if (offer?.error) refocusFlow.current = false;` deleted | PrWorkRow.dom: "FE-R4-001: a failed Link disarms the refocus, so the offer leaving later by another path moves no focus" |
| A09 | TP-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | `if (offer \|\| !refocusFlow.current)` -> `if (!refocusFlow.current)` | PrWorkRow.dom: "FE-R3-002/TP-R4-001: Link waits through its linking render, then focus moves to the control that replaces the offer" |
| A10 | TP-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | `if (!active \|\| active === document.body)` -> `if (true)` | PrWorkRow.dom: "TP-R4-001: focus moved elsewhere while Link runs stays there when the offer goes" |
| A11 | UX-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | while linking, Link keeps "Link <name>" instead of "Linking…" | PrWorkRow.dom: "FE-R3-002/TP-R4-001 …", "UX-010/UX-R4-001: Link carries the state…" |
| A12 | UX-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | after a failure Link keeps "Link <name>" instead of "Retry link" | PrWorkRow.dom: "UX-010/UX-R4-001: Link carries the state…" |
| A13 | UX-R4-001 | apps/desktop/src/review/PrWorkRow.tsx | warn tone (`is-attention`) dropped from the failed Link | PrWorkRow.dom: "UX-010/UX-R4-001: Link carries the state…" |
| A14 | UX-R4-001 | apps/desktop/src/styles/review.css | `[aria-disabled="true"]` selectors dropped from the disabled rule | PrWorkRow.dom: "review.css declarations for the offer … (geometry is not measured here)" |
| A15 | UX-R4-001 | apps/desktop/src/styles/review.css | hover rule no longer excludes `[aria-disabled="true"]` | PrWorkRow.dom: "review.css declarations for the offer …" |
| A16 | UX-R4-003 | apps/desktop/src/review/PrWorkRow.tsx | `sentence(offer.error)` -> `offer.error` (no period before "Press Retry link…") | PrWorkRow.dom: "UX-010/UX-R4-001: Link carries the state…" |
| A17 | UX-R4-004 | apps/desktop/src/review/PrWorkRow.tsx | live region rendered only with text, keyed by it (inserted on each change) | PrWorkRow.dom: "UX-R4-004: one polite live region, there from the offer's first render…", "a new package offered…" |
| A18 | TP-R4-010 | apps/desktop/src/review/PrWorkRow.tsx | Dismiss icon -> text "Dismiss" | PrWorkRow.dom: "a new package offered for the PR's bound session: Link carries its name, Dismiss is an icon…" |
| A19 | TP-R4-010 | apps/desktop/src/styles/review.css | `.pr-work-link` `flex: 1 1 auto` -> `flex: none`, `text-overflow: ellipsis` dropped | PrWorkRow.dom: "the work row has a fixed height…", "review.css declarations for the offer …" |
| A20 | TP-R4-010 | apps/desktop/src/styles/review.css | Dismiss icon `width: 24px` dropped | PrWorkRow.dom: "review.css declarations for the offer …" |
| A21 | ST-R4-004 | apps/desktop/src/review/usePendingFlowLinks.ts | flattened settle keeps the settled offer (`next ? [next] : [item]`) | usePendingFlowLinks.dom: 4 tests (Link writes once, TP-R3-001, two UX-010) |
| A22 | FE-R4-002 | apps/desktop/src/session/sessionFlagsWrite.ts | `onFlags` only when `live.current.client === client` (pre-fix guard) | sessionFlagsWrite.test: "FE-R4-002: flags stored while the connection was replaced still reach the session list" |
| A23 | TP-R4-008 | apps/desktop/src/session/sessionFlagsWrite.ts | refusal rethrown as is (data.reason ignored) | sessionFlagsWrite.test: "TP-R4-008: keryx's refusal reason, without the method prefix, is the error…" |
| A24 | TP-R4-008 | apps/desktop/src/session/sessionFlagsWrite.ts | method prefix kept in the message | sessionFlagsWrite.test: "TP-R4-008 …" |
| A25 | TP-R4-006 | apps/desktop/src/session/subjectBinding.ts | review mutant A08: `return; // not stored yet` -> `setTimeout(() => onNotice(SUBJECT_NOT_SAVED), 40); return;` | ProjectNavigation.dom (app-navigation fixture): "No notice before keryx has saved the session" (green against the first state-only wait, red after the timer wait was added) |
| A26 | TP-R4-006 | apps/desktop/src/session/subjectBinding.ts | the same notice 1 ms after the refusal | ProjectNavigation.dom (app-navigation fixture), same assertion |
| A27 | TP-R4-006 | apps/desktop/src/session/subjectBinding.ts | review mutant A06: the notice at once on the refusal | ProjectNavigation.dom (app-navigation fixture), same assertion |
| A31 | TP-R4-006 | apps/desktop/src/session/subjectBinding.ts | the same notice 1500 ms after the refusal | ProjectNavigation.dom (app-navigation fixture), same assertion |
| A28 | TP-R4-009 | apps/desktop/src/App.tsx | review mutant A01: `...(offer.linking && { linking: true }), ` removed from the offer mapping | ProjectNavigation.dom (app-work-row fixture): "Timed out waiting for: #12's offer is linking" |
| A29 | TP-R4-007/TP-R4-008 | apps/desktop/src/session/sessionFlagsWrite.ts | refusal rethrown as is, App level | ProjectNavigation.dom (app-work-row fixture): Retry link title assertion (reason text) |
| A30 | TP-R4-008 | apps/desktop/src/session/useAcpSession.ts | linkFlow back to its pre-fix body (request + dispatch, no writeFlags) | ProjectNavigation.dom (app-work-row fixture): Retry link title assertion |
| A32 | AR-R4-003 | apps/desktop/src/session/useAcpSession.ts | applyPendingFlow's `await writeFlags(sessionId, { flow })` deleted | ProjectNavigation.dom (app-work-row fixture): "Timed out waiting for: #12's new session is linked to Flow #506" |

Not mutated: CC4-004 (doc comment in issues/model.ts, no behaviour). The rest of AR-R4-003 (archiveIdle and
setFlags through writeFlags) has no dedicated mutant. Their behaviour is covered by the existing session suites,
which stay green.

The TP-R4-006 check still has a limit. It waits until every timer of 2 s or less that the app started after
"Open in session" has run, and until keryx's refusal has been sent. A notice raised later than 2 s after the
refusal would still escape this check. The MutationObserver assertion (`notices` equals `[1]`) also misses it
when it lands after the observer disconnects or in a transcript that is not mounted.

Stability: the app-navigation fixture passed 5 of 5 consecutive runs of ProjectNavigation.dom.test.tsx.
