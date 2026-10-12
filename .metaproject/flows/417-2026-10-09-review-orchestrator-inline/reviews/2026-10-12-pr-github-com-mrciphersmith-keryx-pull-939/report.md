# Review of PR 939 (flow 417, review-orchestrator inline)

Target: https://github.com/MrCipherSmith/keryx/pull/939, head ede409d5a9d9a5403f51b3f12edc6ac4704d805c, base 79a18ba00a185a0a16b306ff948e9e16550a86a6.
PR 939 was already merged when this round ran, so the confirmed defects are fixed in the follow-up PR 988 (https://github.com/MrCipherSmith/keryx/pull/988, branch `fix/pr939-review-findings`), not in this round.

## Scope

Scope A is the full PR diff, cut into 9 slices (206552 bytes, wave budget 90000). Eleven reviewers ran as subagents, each over every slice its path gate requires: review-logic, review-security-code, review-architecture, review-clean-code, review-highload, review-performance, review-style, review-testing-practices, and, because the completion gate requires them for a flow-attached package, review-backend, review-frontend and review-frontend-conventions (the last two found no file in their path gate). 27 reviewer replies were saved under `raw/`; the research ledger reconciles each of them.

## Result

99 raw findings: 12 major, 65 minor, 22 info, no blocker. After reading the replies against the code they reduce to six distinct defects (review-backend added two reports of the path-mode listing defect and one of the classifier gap, all in the same six):

1. `classifyRoundNeed` and the Preflight 2 prose let agent prompts, steering files, lockfile-only and `dist/`-only diffs skip the round (logic, security-code x4, architecture). Fixed in PR 988.
2. `orchestratorToolProblems` could not be satisfied on any host except keryx-shell, and the four orchestrator skills named different spawn tools. Fixed in PR 988.
3. `STATUS: RATE_LIMITED` was both a non-schema status and a BLOCKED reply (clean-code, highload, logic, style). Fixed in PR 988.
4. `retry-after` was unbounded. Fixed in PR 988 (clamped to 300 seconds).
5. Path mode listed files through the summarized `keryx ctx rg --files`, which prints header lines and cuts the list at 120 entries. Fixed in PR 988 (`keryx ctx run --raw -- rg --files`).
6. The completion rule demanded ingest and complete for a lightweight, report-only round. Fixed in PR 988 ("Done when" scoped to managed rounds).

The rest are closed in the research ledger with a stated reason: helpers with no production caller (accepted, parity test added in PR 988), the 10-per-wave ceiling binding only a full review (AC6, documented in PR 988), domain waves and hard-coded domain sets (AC6 design), spend and round counters (pre-existing mechanism), and cosmetic points (wont-fix).

Every confirmed defect is closed by a disposition that cites PR 988; none is recorded as a canonical finding of this round, because the round targets a merged head and the remediation is a separate change. The canonical findings block is therefore empty.

## Not run

review-regression (no blast radius computed), the project-convention reviewers other than testing-practices (no files in their path gates), and the verifier (no canonical finding to verify).

```keryx:findings
[]
```
