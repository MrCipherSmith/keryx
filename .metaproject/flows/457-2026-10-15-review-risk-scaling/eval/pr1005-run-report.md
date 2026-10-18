# PR #1005 round 1 (c75f0091) — live eval of the new review plan

Reviewers ran on **Opus** (`run/raw-opus/`); Sonnet results in `run/raw/` ignored.

## Plan
- Diff `input.round1-c75f0091.diff` (20.5 KB) → 2 slices (max 18000, wave 54000, host claude-code).
  - slice-01 (16.0 KB, 10 files: review/jev commands, git-revision.ts, trust-routine-command.ts): architecture, clean-code, logic, security-code, testing-practices; light, risk 0.3, no why.
  - slice-02 (2.1 KB, trust-routine-command.test.ts): logic, testing-practices; light, risk 0.
- Dispatches: 5 actual vs 8 old plan (-37.5%). Wall ~200 s; ~441k subagent tokens.

## Recall (F-057, F-058, F-061)
| Truth | Result | Matched by |
|---|---|---|
| F-057 major — ref option injection at unguarded git sites (flow-check-ac.ts) | found (major) | SEC-1 (flow-check-ac.ts:170), LOG-1; outside the diff, reached by context reading |
| F-058 major — backslash / brace / `$'..'` spellings of `--output=X` bypass EXEC_FLAGS | missed | — |
| F-061 major — tests leave guarantees unpinned | found as minor | TEST-1/2/3 |

Strict recall 1/3, lenient 2/3. F-058 miss: reviewer miss on a slice planned light although it holds a security gate (trust-routine-command.ts) — no risk class covers command-gate / tokenizer code. Fix candidate: such code → deep.

## Extras
No blocker/major outside truth; minor/info: LOG-2 (`--diff=-` now prompts), TEST-4 (`review create --ref` unchecked → resolveIngestDiff, sibling of F-057), TEST-5 (fixture not isolated from global git config), DRY/doc drift.

## Verdict
Known defects: worse (old: 3/3 major with 8 dispatches; new: 1 major + 1 by mechanism with 5). Confirmed extras: equal (0/0).

## Large-PR planning datapoint (full input.diff, plan only)
| wave | slices | old disp. | new disp. | reduction | deep/light/audit | minutes old → new | serious findings routed |
|---|---|---|---|---|---|---|---|
| 54000 | 32 | 64 | 23 | 64.1% | 4/28/4 | 32–80 → 18–45 | 6/6 (old 6/6) |
| 60000 | 32 | 57 | 19 | 66.7% | 4/28/4 | 30–75 → 16–40 | 6/6 |
