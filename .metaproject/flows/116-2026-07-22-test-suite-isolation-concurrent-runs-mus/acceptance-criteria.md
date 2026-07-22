# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A reproduction harness exists — a script or documented command that runs N full suites concurrently and reports per-run pass/fail plus the failing test names. It reproduces the collisions on the pre-fix code at a stated rate, so the fix has a measured before rather than an assumed one.
- AC2: For every test observed failing under concurrency, the **actual shared resource** is identified in the source — the specific path, id, env var, or process limit it contends on — and named in the flow journal. A test "fixed" without naming what it collided on does not count.
- AC3: Failures caused by a fixed or shared artifact path or id (for example the fixed `runId` at `src/testing/service.test.ts:80`) are fixed by making the resource unique per run, not by serialising the tests and not by retrying.
- AC4: `ENOENT: no such file or directory, posix_spawn 'git'` is diagnosed rather than worked around: state whether it is process/fd exhaustion, a PATH resolution issue under load, or something else, with evidence. If it is an environmental limit rather than a repository defect, say so plainly and do not disguise it as a fix.
- AC5: After the fix, the AC1 harness runs concurrently at the same N and reports **zero** failures across all runs, repeated at least twice. Before and after numbers are both recorded.
- AC6: Sequential runs remain clean and nothing is broken to get there: `bun test` passes at no fewer tests than the 2101-pass / 11-skip / 0-fail baseline on this branch, and `bun run typecheck` is clean.
- AC7: No test's assertions are weakened to achieve isolation. If a test genuinely cannot be isolated without changing what it proves, it is reported as such rather than quietly reduced.
- AC8: `src/tui/tui-shell.test.ts:1272` — the one remaining `if (otui === undefined) return;` early-return, which silently passes instead of skipping when the optional dependency is absent — is converted to the `otuiTest`/`skipIf` shape, closing the hole left open for this test.
- AC9: The finding is recorded where the next person will hit it: the concurrency constraint and its causes go in the flow journal, and if any constraint survives, it is stated in the testing docs rather than left as tribal knowledge.
