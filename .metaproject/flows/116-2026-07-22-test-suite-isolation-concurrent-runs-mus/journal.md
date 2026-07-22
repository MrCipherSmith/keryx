# Flow Journal

- 2026-07-22T06:35:14.040Z - flow created
- 2026-07-22T06:36:19.932Z - frozen: 9 criteria; checksum recorded
- 2026-07-22T06:36:20.052Z - started

## Finding: what the suite actually contended on

Measured with `scripts/stress/concurrent-suite-stress.ts` (AC1), N=6 concurrent
full suites in one worktree, on `test/suite-isolation`.

- **Before:** 25 failures across 6 runs (per-run: 6, 7, 7, 0, 5, 0).
- **After:** 8 waves of 6 = 48 concurrent runs, 1 failure total — and that one
  is the unrelated live-TLS flake described below, not a collision. Every
  collision-class failure is gone. The last 6 waves (36 runs) were clean.
- Sequential baseline unchanged throughout: 2101 pass / 11 skip / 0 fail.

### The shared resource (AC2)

Two families, one root cause: **a fixture whose root is a fixed path is not
private to the run that created it.**

1. `path.join(tmpdir(), "keryx-<name>")` — resolves to the *same* directory for
   every checkout on the machine, so it collides **across worktrees**. This is
   why running from separate worktrees did not help. 26 sites.
2. `path.join(import.meta.dir, "..", "..", ".tmp-<name>")` — the repo root, so
   it collides between concurrent processes **in one worktree**. 7 sites.

Every failing test began with `rm -rf <root>` (`reset(root)` or an inline
`rm`). Two runs interleaving that teardown/setup is the whole mechanism: run A
deletes the tree run B is mid-way through reading or writing. The three symptom
shapes all reduce to it:

- `ENOENT … open '<root>/…'` — the file the test just wrote was deleted.
- `immutable testing run already exists: run-testing-provenance` /
  `immutable health run already exists: run-health-provenance` — the fixed
  `runId` was never the defect. The id is namespaced *under* the root, so it is
  only ambiguous because the root was shared: the test read another run's
  leftover artifact. Making the root unique makes the id unique.
- `Expected and actual values must be numbers or bigints` — a metric read back
  as `undefined` from a JSON artifact that had been deleted and half-rewritten.

### `posix_spawn 'git'` ENOENT — diagnosed, not worked around (AC4)

**Verdict: a repository defect, the same one — a vanished cwd. Not fd/process
exhaustion, and not PATH resolution.** Evidence:

- Direct reproduction: `Bun.spawnSync(["git","status"], { cwd: <dir that does
  not exist> })` throws *exactly* the observed string —
  `ENOENT: no such file or directory, posix_spawn 'git'`, with
  `syscall: posix_spawn`, `code: ENOENT`, `path: git`. The error names the
  **binary** but the missing path is the **cwd**, which is what made it look
  like a PATH or environment problem.
- `git` resolves fine throughout: `Bun.which("git")` → `/opt/homebrew/bin/git`,
  and thousands of other spawns in the same runs succeeded.
- Exhaustion is excluded by the errno: an fd/process limit surfaces as `EMFILE`
  / `EAGAIN`, never `ENOENT`.
- It only ever hit tests that spawn `git` with a *fixture* cwd
  (`hotspot.test.ts` seeding a git history, `service.test.ts` `gitInit`) — i.e.
  precisely the shared roots — and it disappeared entirely once the roots
  became unique.

### The fix (AC3)

`src/lib/test-tmp.ts` → `uniqueTestRoot(parent, prefix)`, a `mkdtemp` under the
**same parent directory the fixture already used**, so nothing path-sensitive
about any fixture changes — only its identity becomes private. 33 roots across
15 test files. No test was serialised, no retry was added, and no assertion was
weakened (AC7): the diff changes only how each root is *named*.

### Residual, reported rather than hidden (AC7)

`src/harness/process/sandbox/proxy-tls.test.ts` —
`no HTTPS substitution for a host outside injectHosts` failed once in 48
post-fix concurrent runs. It is **not** a shared-resource collision: the proxy
and upstream both bind ephemeral ports (`listen(0)`) and the run CA uses
`mkdtemp`. It does real TLS handshakes and shells out to `openssl`, so it is
load-sensitive on a saturated machine. 10 targeted concurrent runs of that file
alone did not reproduce it. Left as-is rather than given a timeout bump or a
retry, and recorded in `docs/docs/onboarding.md`.
- 2026-07-22T07:03:47.616Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/196 (warning: PR is not a draft)
- 2026-07-22T07:04:10.922Z - ac-confirmed: AC1: scripts/stress/concurrent-suite-stress.ts runs N suites concurrently and reports per-run tallies, failing names, aggregated errors and retained transcripts, exiting non-zero on any failure. Pre-fix at N=6: 25 failures (6,7,7,0,5,0).
- 2026-07-22T07:04:11.203Z - ac-confirmed: AC2: Every failing family traced to one named resource and recorded in the journal: fixed fixture roots under tmpdir() (keryx-testing-*, keryx-health-*, keryx-tia-*, keryx-gdgraph-*, keryx-smoke-*, keryx-hotspot-churn, keryx-hook-*, xdg-keryx-test) and fixed roots inside the repo (.tmp-cx-findings, .tmp-ingest-test, .tmp-reflect-test, .tmp-relevant-test, .tmp-skill-loop-test, .tmp-flow-security-test). Each test begins with rm -rf on that root, so one run's teardown deletes another's tree.
- 2026-07-22T07:04:11.377Z - ac-confirmed: AC3: Fixed by uniqueTestRoot(parent, prefix) - an mkdtemp under the SAME parent the fixture already used, so nothing path-sensitive changes and only the identity becomes private. 33 roots across 15 files. No serialisation, no --concurrency 1, no retry. The suspected fixed runId was checked and found NOT to be the defect: it is namespaced under the root and was only ambiguous because the root was shared.
- 2026-07-22T07:04:11.530Z - ac-confirmed: AC4: Diagnosed, not worked around: spawning git with a non-existent cwd reproduces the exact string ENOENT ... posix_spawn 'git' - the error names the binary while the missing path is the cwd, which is why it read as environmental. Bun.which resolves git and thousands of sibling spawns succeeded (PATH excluded); fd/process exhaustion surfaces as EMFILE/EAGAIN not ENOENT (excluded). It only hit tests spawning git inside a fixture cwd and vanished when roots became unique - the same root cause, not a separate one.
- 2026-07-22T07:04:11.746Z - ac-confirmed: AC5: Post-fix 48 runs across 8 waves of 6: 1 failure total, and the last 36 runs were 0. Zero-failure waves repeated well past twice. Independently re-run by the orchestrator at N=6: 0 failures, every run 2101 pass / 0 fail / 11 skip.
- 2026-07-22T07:04:11.932Z - ac-confirmed: AC6: bun test 2101 pass / 11 skip / 0 fail - identical to the branch baseline; bun run typecheck clean. Sequential behaviour unchanged.
- 2026-07-22T07:04:12.222Z - ac-confirmed: AC7: No assertion weakened: git diff origin/main..HEAD over src/**/*.test.ts touching expect returns 0 lines. The only non-declaration change in the test diff is an XDG_DATA_HOME assignment, itself a root declaration. One residual was REPORTED rather than silenced: proxy-tls.test.ts failed once in 48 post-fix runs - not a collision (ephemeral ports, mkdtemp CA) but load-sensitive because it does real TLS handshakes and shells out to openssl. Left with no timeout bump and no retry.
- 2026-07-22T07:04:12.365Z - ac-confirmed: AC8: The last if (otui === undefined) return; (the flow-115 streamed-fence test) converted to otuiTest + requireOtui. All 30 renderer tests in tui-shell.test.ts now skip rather than silently pass when the optional dependency is absent; scripts/opentui-tests-no-skips.ts reports 103 tests, 0 skipped.
- 2026-07-22T07:04:12.513Z - ac-confirmed: AC9: Recorded in the flow journal (full causal analysis, both families, the ENOENT diagnosis, the residual) and in docs/docs/onboarding.md under a new 'Running the suite concurrently' section: the rule (uniqueTestRoot, never a fixed tmpdir path), the three symptom shapes, the harness command, and the known TLS residual.
- 2026-07-22T07:04:12.682Z - completing
- 2026-07-22T07:04:15.027Z - completion-failed: health: no report; run `keryx health run` first
- 2026-07-22T07:04:41.581Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/196 (warning: PR is not a draft)
- 2026-07-22T07:04:41.735Z - completing
- 2026-07-22T07:04:43.806Z - done: all gates passed
