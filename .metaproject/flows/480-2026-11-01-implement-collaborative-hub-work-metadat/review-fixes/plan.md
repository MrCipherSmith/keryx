# PR1113 review correction plan

Reviewed/current starting head `46982e50b`. Original review and evidence under the supplied review worktree are read-only. Working in fresh feat-hub-1113-review-fixes, pushing only HEAD:feat-hub-work-management. Do not merge or publish a release.

1. Fix N first: isolated dependency preparation; run genuine packaged managed-work/MCP smoke without host-cache prerequisites.
2. Fix A: incremental record/event/receipt reads and writes, persisted sequences, bounded retained event windows and explicit stale-cursor recovery. Coordinate native execution transaction reads. Resolve carryover F-002/F-067/F-049 mechanism without losing accepted historical data.
3. Fix D1/D2/M: bounded online backup and stopped-Hub rollback; failure-safe legacy recovery, preserving latest data. Fix related minor/info in touched files.
4. Fix B/C/G/I UI consumers: event-targeted refresh, bounded session-list data, eligible amendment membership, consistent result subject. Tests measure fetches and rendered identity.
5. Fix E/F/H/J/K/L backend behavior with RED→GREEN tests per root cause; exact actor attribution, settled execution/queue reservations, lost terminal state, membership amendments and real remote state unions.
6. Fix carryover F-001/F-006 (external Git delivery outside global queue, bounded admission) and every PR=yes item, or explicitly justify each retained item in PR description. Add positive bare-string audience test for F-071.
7. Finish minor/info in files touched for A–N; ID-list every other follow-up. Keep a disposition ledger mapping findings to commits and meaningful test names.
8. Conventional commit per root cause, no generated/coauthor trailers. Run affected gates and real CI; push only this PR branch using MrCipherSmith GH token. Keep Draft/no merge.

The owner's A decision is upheld: it may not be deferred. Production backups/operator data are not touched by code-fix work. Frozen product acceptance is not self-confirmed.

## Publication checkpoint

All 30 current-round majors are fixed and committed; the owner's A decision is implemented. Additional independent admission, exact-replay and response-budget regressions are fixed. Final local verification passed. The complete493-row disposition ledger explicitly retains the bounded-v1 metadata part of F-002 and other carry-over structural follow-ups.

Draft PR1113 is prepared; Task24 remains in progress at this immutable publication checkpoint until GitHub validates the final head. The final PR checks and review-ready comment are external evidence, not self-acceptance of frozen product criteria. No merge, release or production cutover.
