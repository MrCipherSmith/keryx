# Review report: PR 1000 (flow 441 T2, trust table), round 2

Orchestrator: vantage-review. Generic engine: review-orchestrator. Round 2. Head b2120e39, base 01e0dbfe. Mode all.

Verdict: changes requested. 0 blocker, 3 major, 15 minor, 3 info (21 findings, F-024 to F-044). All six round-1 majors are fixed in code and every escape probe from the brief is refused at head. The three majors are one residual of the round-1 F-001 class (a symlinked directory after `cd`), one new hang (bunfig.toml read with no regular-file check) and an agent wiring that is still unpinned by tests.

Verification mode: annotate. Wave C review-verifier checked 2 claims; 2 confirmed, 0 refuted.

Dispatch: review-logic, review-security-code, review-highload, review-testing-practices, review-regression, review-architecture, review-clean-code, review-style, review-performance, all dispatched as real agents in one parallel wave. No Vantage overlay applies and no project-local reviewer packages are registered. review-regression found nothing affected in scope B.

## Findings

### Major
- **F-024** (major, review-highload) `src/lib/trust-routine-command.ts`
  - Problem: movedTo follows `cd` lexically (path.resolve(cwd, target)) while the shell follows symlinks physically. After `cd link`, where `link` is an in-project symlink to a directory elsewhere, every later relative path such as `..` resolves from the physical directory, but the table still judges it from the lexical one. This is the round-1 F-001 class (table cwd disagrees with the shell cwd) left open for symlinked directories: the fix closed options, expansion and CDPATH but not a plain `cd <symlink>`.
  - Impact: Trigger: trust or review-auto mode, a project that contains a symlink (git stores symlinks) into a directory inside another repository or marker-bearing tree, and the command `cd link && keryx review slice --diff - --out ../x`. Outcome: isTrustRoutineCommand returns true (also with untrustedContent: true), so the command is not prompted, and under /bin/sh slice-01.diff and manifest.json are written into the other tree (<other-repo>/x). The same holds for `cd link && keryx review retry-plan --manifest ../m.json --state ../s.json ...`. Narrower than first reported: when the target tree has no .git or .metaproject marker at or above it, the command's own placement check refuses (exit 1, nothing written); the write needs a marker-bearing target. review-security-code and review-logic did not find it because their cd probes judged bun test and nested-repo cases, not `cd <symlink>` followed by a relative path flag.
  - Fix: In movedTo, compare the realpath of the target with the lexical result and return undefined (fail closed, every cwd-dependent check then refuses) when they differ, or track walk.cwd by realpath at each cd. Add a regression test with an in-project symlink to an outside marker-bearing directory asserting `cd link && keryx review slice --diff - --out ../x` is not routine.
- **F-025** (major, review-highload) `src/lib/trust-routine-command.ts`
  - Problem: bunfigState reads bunfig.toml with readFileSync and no check that the target is a regular file and no size cap. recordBunfigBaseline runs at the start of every runAgentTurn (agent.ts 2248-2253), in every permission mode, before any prompt. The read is new in this PR: at base 01e0dbfe nothing read bunfig.toml at agent session start.
  - Impact: Trigger: open a project whose bunfig.toml is a git-stored symlink to /dev/stdin (git stores symlinks, so a cloned repository can carry it), or any local FIFO. Outcome: readFileSync blocks forever and the agent process hangs at the first turn of the session, before any confirmation. A symlink to /dev/zero is NOT a hang: Bun's string cap makes the read fail in about 0.7 to 0.9 s and the result fails closed (preload true), so the memory-exhaustion part of the report is not reproduced.
  - Fix: lstat/stat first; if the path is not a regular file return { fingerprint: "unreadable", preload: true } without opening it. Cap the size (for example 1 MiB) with the same fail-closed result. Keep ENOENT as "absent".
- **F-026** (major, review-testing-practices) `src/commands/agent.ts`
  - Problem: Residual of round-1 F-006. The agent-level wiring added for AC6/AC7 is not pinned. The AC7 test passes with the tool cwd dropped from routineContext (ag-latch-cwd), with the context dropped at the latch lift (ag-gate-ctx), with the process-cwd recordBunfigBaseline() call removed (ag-baseline-process) and with shell-exec-tool no longer exposing workingDirectory (sh-workdir). AC7 runs with the process cwd in the keryx repo, whose bunfig has a preload, so `bun test` is never routine there: the test cannot fail for the reason it states and has no positive control. The fixer did not add the review-auto call-site test.
  - Impact: Trigger: a regression in any of those four wirings. Outcome: the suite stays green; in a clean-project process cwd a lost untrusted flag at the lift site auto-runs `bun test` after untrusted content, and review commands are judged against the wrong directory.
  - Fix: In agent-trust-orchestration.test.ts: run AC7 with process.chdir into a clean temp project and assert one approval and nothing run; add a positive control; judge a review command against the tool directory; cover a turn with no shell workingDirectory; assert shellExecTool('/x').workingDirectory === '/x'. Drafts that pass at HEAD and kill the mutants: scratchpad/t2r2/review-testing-practices/proposed-agent.test.ts (4 tests).

### Minor
- **F-027** (minor, review-testing-practices) `src/lib/trust-routine-command.ts`
  - Problem: No test asserts that non-test bun subcommands are refused: removing `words[1] === "test"` passes the suite (seg-bun-test). Rated major by the reviewer; the code is correct at HEAD, no present wrong outcome exists, and the comparable round-1 gap F-012 was minor, so it is minor here.
  - Impact: Trigger: a future edit drops the subcommand check. Outcome: bun install, run, upgrade, update and bare bun become routine.
  - Fix: Add a negative test for `bun`, `bun install`, `bun run`, `bun upgrade`, `bun update`, `bun x` next to the positive `bun test` (proposed-lib.test.ts test 1).
- **F-028** (minor, review-performance) `src/lib/trust-routine-command.ts`
  - Problem: bunfigState always runs Bun.TOML.parse (quadratic in file size) on the whole bunfig.toml, and isRoutineBunTest calls it before comparing the fingerprint with the baseline; recordBunfigBaseline calls it although it needs only the fingerprint. Also reported by review-highload (F-003).
  - Impact: A large bunfig.toml (grown in the turn, from a checked-out branch, or hostile) blocks the event loop on every `bun test` classification, up to twice per shell call: 970 KB 1.1 s, a changed 1.22 MB file 3.97 s through isTrustRoutineCommand, result false, parse discarded. Realistic bunfigs cost under 1 ms.
  - Fix: Hash first and compare to the baseline before parsing; parse only on a match and cache the verdict per fingerprint; treat a file above a small cap as preload true; have recordBunfigBaseline compute only the fingerprint. Shares the stat and cap fix with F-025.
- **F-029** (minor, review-architecture) `src/lib/contained-path.ts`
  - Problem: After the F-002 fix the extraRoots parameter of placePathWithinSync cannot change a result: an extra root is kept only when it is inside the project root, so anything inside it is already inside the root. review-path-flags.ts still passes [".metaproject"], and the review-path-flags header, docs/docs/guides/permission-modes.md (about line 256) and the test 'an extra root is allowed' (contained-path-place.test.ts:59) still describe .metaproject as a second allowed root. Reported by review-architecture, review-style and review-testing-practices.
  - Impact: Misleading API and docs; a later edit to the filter could widen confinement while the test still passes. No wrong runtime outcome today.
  - Fix: Drop extraRoots and the argument, and reword header, guide and test titles to 'inside the project root (a .metaproject link out of the project is refused)'; or keep it and make it meaningful with a test that fails without it.
- **F-030** (minor, review-style) `docs/docs/guides/permission-modes.md`
  - Problem: The guide says a `cd` elsewhere 'is not followed'. The code follows plain cd targets (`cd sub && cd .. && bun test` is routine) and fails closed only for unknowable ones (options, `-`, expandable targets, a relative target with CDPATH set). The guide also lists an unreadable bunfig as asking but omits one that does not parse.
  - Impact: The doc misstates what the code enforces.
  - Fix: Reword to: the command runs in the project root, judged after following the chain's cds; a cd whose target cannot be known makes it ask. Extend the bunfig sentence to 'appears, changes, cannot be read or does not parse'. If F-024 is fixed, add symlinked directories to the unknowable list.
- **F-031** (minor, review-style) `docs/docs/cli-reference.md`
  - Problem: Round-1 F-019 asked for the cli-reference rows of review slice, retry-plan and dispatch-check to state the confinement. Only the permission-modes guide changed; cli-reference.md says nothing about the refusal.
  - Impact: `--out`, `--diff`, `--manifest`, `--state`, `--result` and `--payload` now refuse paths outside the project root for every caller, and stdin `-` stays exempt for three flags; the command reference does not say so.
  - Fix: One sentence under the three command intros and in the `--out` row: path flags must resolve (symlinks followed) inside the project root; `-` is standard input where a flag accepts it.
- **F-032** (minor, review-style) `src/lib/trust-routine-command.ts`
  - Problem: The file header no longer describes the module: it promises the table runs 'even after untrusted content' although bun test is routine only while no untrusted content entered the turn, names only trust mode although review-auto shares the table, and says 'two reads of the file system' while the module also walks up with existsSync and takes realpath of cwd and root.
  - Impact: A maintainer could treat bun test like the other rows and drop the latch, or miss that classification does file-system I/O.
  - Fix: Say: runs without a prompt in trust and review-auto, even after untrusted content, except bun test; and list the file-system reads (project root walk, real path of cwd and root, bunfig.toml, a review command's path flags).
- **F-033** (minor, vantage-review) `src/commands/review-slice.ts`
  - Problem: Behaviour change not asked for by any AC: `--manifest` is placed as a path, and `-` is exempt only for --diff, --payload and --result. At c8262aa8 dispatch-check passed `--manifest -` unplaced to readJsonSource, which reads stdin for `-`; at HEAD it becomes the absolute path of a file named `-`. retry-plan already resolved it as a file at the base, so only dispatch-check changed. Raised by review-clean-code and review-architecture; review-highload stated the opposite direction, which the orchestrator checked against both versions of the source. --manifest - is not in the help text.
  - Impact: `keryx review dispatch-check --payload p.json --manifest -` with the manifest on stdin now fails with 'manifest is unreadable: .../-' instead of reading it. Undocumented use, low reach.
  - Fix: Add `--manifest` to the stdin exemption for dispatch-check only, or state in the help and docs that it takes a file.
- **F-034** (minor, review-clean-code) `src/commands/review-slice.ts`
  - Problem: guardPaths both refuses and builds the placer, and its name says only the first; the returned closure is bound to `placed` while a PlacedPathResult inside is also `placed`. The closure returns string | undefined even with a fallback, so two callers need `as string` (lines 155 and 277); `args` lost its `readonly`. runRetryPlan keeps `const manifestPath = manifestSource;`, a pure alias left from removing path.resolve (line 273).
  - Impact: Readability and type honesty only.
  - Fix: Name it for the closure, give it two overloads or two functions (place(flag) and placeOr(flag, fallback)) so the casts go, restore `readonly string[]`, drop the alias.
- **F-035** (minor, review-clean-code) `src/lib/contained-path.ts`
  - Problem: placePathWithinSync is about 42 lines mixing allowed-root computation, an ancestor walk with lstat and a verdict, and takes four positional parameters of which three adjacent strings (projectRoot, candidate, cwd) are easy to swap, while its caller passes the same pair as a `where` object.
  - Impact: The ancestor walk and the allowed-root rule cannot be tested on their own, and a swapped argument compiles.
  - Fix: Extract nearestExistingAncestor() and allowedRoots(); take { projectRoot, cwd } as one object.
- **F-036** (minor, review-testing-practices) `src/lib/trust-routine-command.ts`
  - Problem: Unpinned cd edge cases: the arity guard (bare `cd` throws a TypeError, `cd a b` is treated as routine without it, seg-cd-arity), CDPATH exemptions for absolute, ./ and ../ targets and an empty CDPATH, `cd ""`, a path flag repeated as `--out=ok --out $X`, and no path-flag value after `cd $X`.
  - Impact: A regression would silently widen or narrow the routine set; several survive the four PR test files.
  - Fix: Add the cases from proposed-lib.test.ts tests 2, 5 and 7.
- **F-037** (minor, review-testing-practices) `src/lib/review-path-flags.ts`
  - Problem: Only the --diff use of stdin `-` is pinned. Removing --payload or --result from STDIN_FLAGS, or exempting `-` for every flag (so a symlink named `-` lets `--out -` or `--manifest -` escape), passes all tests. The flag-inventory guard (review-slice-paths.test.ts:245-260) is sound for the two flag lists but does not assert STDIN_FLAGS is a subset of the confined flags, and its command-to-flag map is hand-listed (review-logic, info).
  - Impact: The stdin exemption can regress unseen in either direction.
  - Fix: Unit-test placeReviewPath: `-` is stdin for the three flags and placed for --out and --manifest; assert no file `-` is created; derive the guard's map from the exported *_FLAGS arrays (proposed-lib.test.ts test 10, proposed-slice.test.ts test 2).
- **F-038** (minor, review-testing-practices) `src/commands/review-slice.ts`
  - Problem: The use-time re-placement (round-1 F-003 and F-011) is pinned for `--out` only. Skipping the late placement of retry-plan --state, --manifest and --result, or dispatch-check --payload, and the early refusal of a duplicate occurrence (`--out ok --out=<outside>`), passes the suite.
  - Impact: A regression reopens the check-versus-use window on a write path (--state).
  - Fix: A --state swap test (replace a directory by a symlink to outside during the stdin --result - read, expect 'outside the project root'), a duplicate-occurrence test, and a `link/../x.json` read test per read flag (proposed-slice.test.ts tests 1, 3, 4).
- **F-039** (minor, review-testing-practices) `src/lib/trust-routine-command.ts`
  - Problem: Baseline keying is unpinned: recording from a subdirectory, through a symlinked path, with the default process cwd; a symlinked project root for bun test and for placePathWithinSync; and a clean bunfig with string values (the object guard in carriesPreload: dropping it recurses on strings and wrongly refuses bun test).
  - Impact: A symlinked project could be keyed under two roots; the regression is invisible to the suite.
  - Fix: proposed-lib.test.ts tests 3, 4, 6 and 8.
- **F-040** (minor, review-testing-practices) `src/lib/trust-routine-command.test.ts`
  - Problem: Round-1 F-014 is half fixed: this file (the module-level dir, `outside`, every projectDir() result) and bareProject() in agent-trust-orchestration.test.ts create tmp directories and never remove them; the module-global bunfigBaselines Map is shared across tests.
  - Impact: Directories accumulate in the OS temp dir on every run.
  - Fix: Track created dirs and rmSync them in afterEach/afterAll, as review-slice-paths.test.ts does.

### Info
- **F-041** (info, vantage-review) `src/commands/agent.ts`
  - Problem: Round-1 leftovers not done: F-023 (resolveProjectRoot still eager; isTrustRoutineCommand is evaluated twice per shell call at lines 5650 and 5682, +2 to 8 us each), F-022 (test header cites only Flow 426 AC1/AC2; finding ids cited in interactive-tools.ts:72 and in test titles; placePathWithinSync sits between resolveContainedPath and its documented sync twin), F-016 (the nullable realpath is still written twice: realOf in placePathWithinSync and the try/catch in resolveContainedPathSync), and a JSDoc that says recordBunfigBaseline is called 'when a session starts' while it runs every turn.
  - Impact: Readability and a few microseconds.
  - Fix: Evaluate the verdict once; hoist one realOrNull helper; cite Flow 441 AC6 instead of finding ids; move placePathWithinSync below resolveContainedPathSync.
- **F-042** (info, review-logic) `src/lib/contained-path.ts`
  - Problem: placePathWithinSync accepts a candidate containing a NUL byte (ok = true). Not a bypass: the later fs call throws and argv cannot carry NUL.
  - Impact: The refusal comes from an fs exception instead of the guard.
  - Fix: Refuse \u0000 in placePathWithinSync.
- **F-043** (info, review-performance) `src/lib/trust-routine-command.ts`
  - Problem: areReviewPathFlagsInside places every value of every confined flag with no cap (about 63 us per value, three times: gate and command twice). 12,500 repeated values (100 KB) cost 864 ms against 122 ms before.
  - Impact: Degenerate input only; no legitimate command repeats a path flag more than once.
  - Fix: Treat a confined flag given more than a few times as not routine and refuse it.
- **F-044** (info, review-testing-practices) `src/lib/contained-path.ts`
  - Problem: The segment-wise check in isInside (a name starting with two dots such as `..data/x` is inside) has no test (mutant cp-isinside-dotdot). isInside is pre-existing and correct at HEAD; the reviewer's wording that it uses a prefix test is wrong.
  - Impact: Pre-existing function; a test gap only.
  - Fix: Assert placePathWithinSync(root, '..data/x', root).ok is true and '../x' false (proposed-lib.test.ts test 9).

## Questions

1. Is `keryx review dispatch-check --manifest -` (manifest on stdin) a supported form? It is not in the help text. This decides how F-033 is fixed.
2. Is F-024 in scope for T2? It is the F-001 class on the same commands, so it is treated as in scope.

## Pre-existing (not blocking)

- F-044 (`isInside` is already segment-wise; only its test is missing).
- The unconfined writers outside the three commands: review scope --append, blast-radius --out, comments --out, ledger --out, ingest --append, complete --report.

## Verified clean

- Every listed shell probe is refused at head: `cd -P`, `-L`, `--`, `\.\.`, `.?`, `l*`.
- A symlinked `.metaproject` is refused. dispatch-check `link/../m.json` is refused.
- `--diff`, `--result`, `--slices`, `--payload`, `--out`, `--manifest` and `--state` are confined; stdin `-` is exempt only for `--diff`, `--payload` and `--result`.
- The `--out` check-then-use window is closed. The `bun test` untrusted latch holds when the flag is passed. A parse failure fails closed.

## Round-1 dispositions

| Round-1 | At b2120e39 |
|---|---|
| F-001 | Fixed for -P, -L, --, `\.\.`, `.?`, glob, CDPATH. Residual symlink-cd is F-024. |
| F-002 | Fixed. The extraRoots side effect is F-029. |
| F-003 | Fixed: the placed path is the one opened. |
| F-004 | Fixed: exit code restored to 0. |
| F-005 | Fixed: the vacuous positive control is gone. |
| F-006 | NOT fixed: F-026. |
| F-007 | Fixed with tool.workingDirectory plumbed to both call sites. The tool-cwd half is unpinned (F-026). |
| F-008 | Fixed with Bun.TOML parse, fail closed. New problems F-025 and F-028. |
| F-009 | Fixed. |
| F-010 | Fixed with all seven flags confined and a guard test. Gaps F-033 and F-037. |
| F-011 | Fixed for --out; the other flags are unpinned (F-038). |
| F-012, F-013 | Partly fixed (F-036, F-039, F-029). |
| F-014 | Half fixed (F-040). |
| F-016, F-022, F-023 | Not done (F-041). |
| F-015, F-017, F-018, F-020, F-021 | Not individually re-opened; no reviewer reported a regression. |
| F-019 | Guide only; cli-reference.md not done (F-031). |

## Mutation pass

Run 1 used the four PR test files: 149 mutants, 96 killed, 53 survived, 0 invalid, 0 timeout. Run 2 used the wider agent tests on 12 mutants: 4 killed, 8 survived. Full tables are in research-evidence/mutation-1.md and mutation-2.md.

| Class | Count | Mutants |
|---|---|---|
| Equivalent | 14 | exp-backtick, preload-null-guard, state-unreadable-fp, args-eq-gt0, args-int-undef, rpf-extra-root, cp-extra-roots, cp-extra-resolve, cp-parent-root, ag-baseline-tool-guard, rk-review-only (latent), rk-ctxrun-dashes, rk-ctxrun-dashes-b, seg-assign |
| Equivalent for safety (over-refusal only) | 7 | preload-key-case-insens, preload-text-scan-added, movedTo-cdpath-empty, movedTo-abs-exempt, movedTo-dotdotslash-exempt, rf-empty, movedTo-empty |
| Real gaps | 32 | F-026: ag-baseline-process, ag-latch-cwd, ag-refusal-ctx, ag-refusal-off, ag-gate-ctx, ag-gate-mode, ag-gate-reviewauto, ag-gate-hook, sh-workdir. F-038: rs-guard-throw, rs-guard-refusal, rs-dc-payload, rs-rp-manifest, rs-rp-result, rs-rp-state. F-037: rpf-stdin-any-flag, rpf-stdin-set-payload, rpf-stdin-set-result. F-039: preload-object-guard, baseline-root-cwd, baseline-no-real, baseline-default-cwd, bun-root-real, bun-cwd-real, bun-baseline-undefined, top-walk-root, top-cwd-default, cp-root-real. F-036: rf-flags, seg-cd-arity. F-027: seg-bun-test. F-044: cp-isinside-dotdot |

## Not run

- ingest and severity-audit were not run by the reviewer (the report could not be written by a subagent); they are run by the fixer from this report.
- `review complete` was not run.

## Machine-readable findings

```json keryx:findings
[
 {
  "id": "F-024",
  "reviewer": "review-highload",
  "severity": "major",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "movedTo follows `cd` lexically (path.resolve(cwd, target)) while the shell follows symlinks physically. After `cd link`, where `link` is an in-project symlink to a directory elsewhere, every later relative path such as `..` resolves from the physical directory, but the table still judges it from the lexical one. This is the round-1 F-001 class (table cwd disagrees with the shell cwd) left open for symlinked directories: the fix closed options, expansion and CDPATH but not a plain `cd <symlink>`.",
  "impact": "Trigger: trust or review-auto mode, a project that contains a symlink (git stores symlinks) into a directory inside another repository or marker-bearing tree, and the command `cd link && keryx review slice --diff - --out ../x`. Outcome: isTrustRoutineCommand returns true (also with untrustedContent: true), so the command is not prompted, and under /bin/sh slice-01.diff and manifest.json are written into the other tree (<other-repo>/x). The same holds for `cd link && keryx review retry-plan --manifest ../m.json --state ../s.json ...`. Narrower than first reported: when the target tree has no .git or .metaproject marker at or above it, the command's own placement check refuses (exit 1, nothing written); the write needs a marker-bearing target. review-security-code and review-logic did not find it because their cd probes judged bun test and nested-repo cases, not `cd <symlink>` followed by a relative path flag.",
  "suggested_fix": "In movedTo, compare the realpath of the target with the lexical result and return undefined (fail closed, every cwd-dependent check then refuses) when they differ, or track walk.cwd by realpath at each cd. Add a regression test with an in-project symlink to an outside marker-bearing directory asserting `cd link && keryx review slice --diff - --out ../x` is not routine.",
  "evidence": "scratchpad/t2r2/review-highload/cd-symlink.ts re-run by the orchestrator at HEAD: `table routine: true | cd link && keryx review slice --diff - --out ../x`; `table routine: false` for `--out x`; `table routine: true` for the retry-plan form; sh exit 0; `written under other-repo: [ manifest.json, slice-01.diff ]`. Wave C review-verifier (scratchpad/t2r2/verifier/cdvar.ts): confirmed with .git in the target and with an ancestor marker; target with no marker above: routine=true but sh exit 1 `refused: ../x resolves outside the project root`.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-024",
  "quote": "walk.cwd = movedTo(walk.cwd, words[1] as string);",
  "class_scope": {
   "sites": [
    "src/lib/trust-routine-command.ts: movedTo (lexical path.resolve of a cd target)",
    "src/lib/trust-routine-command.ts: isRoutineSegment case \"cd\"",
    "src/lib/trust-routine-command.ts: areReviewPathFlagsInside (reads walk.cwd)",
    "src/lib/trust-routine-command.ts: isRoutineBunTest (walk.cwd versus project root, compared by realpath)"
   ],
   "enumeration_method": "keryx ctx rg for movedTo and walk.cwd in src/lib; every consumer of walk.cwd listed; the symlink variant run through /bin/sh by review-highload, by the orchestrator and by review-verifier (three target shapes: .git in the target, ancestor marker, no marker)."
  }
 },
 {
  "id": "F-025",
  "reviewer": "review-highload",
  "severity": "major",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "bunfigState reads bunfig.toml with readFileSync and no check that the target is a regular file and no size cap. recordBunfigBaseline runs at the start of every runAgentTurn (agent.ts 2248-2253), in every permission mode, before any prompt. The read is new in this PR: at base 01e0dbfe nothing read bunfig.toml at agent session start.",
  "impact": "Trigger: open a project whose bunfig.toml is a git-stored symlink to /dev/stdin (git stores symlinks, so a cloned repository can carry it), or any local FIFO. Outcome: readFileSync blocks forever and the agent process hangs at the first turn of the session, before any confirmation. A symlink to /dev/zero is NOT a hang: Bun's string cap makes the read fail in about 0.7 to 0.9 s and the result fails closed (preload true), so the memory-exhaustion part of the report is not reproduced.",
  "suggested_fix": "lstat/stat first; if the path is not a regular file return { fingerprint: \"unreadable\", preload: true } without opening it. Cap the size (for example 1 MiB) with the same fail-closed result. Keep ENOENT as \"absent\".",
  "evidence": "Wave C review-verifier: special-bunfig.ts under `ulimit -v 4000000` and `timeout 15`: fifo status 124, /dev/stdin on a live pipe status 124, /dev/zero recorded in 655 ms with `bun test routine = false`. verifier/clone-bunfig.sh committed bunfig.toml as a symlink (mode 120000 blob), cloned it, ran recordBunfigBaseline on the clone: target /dev/stdin status 124 (hang), target /dev/zero 894 ms, fail closed. git grep at 01e0dbfe: no bunfig read in trust-routine-command.ts or agent.ts.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-025",
  "quote": "const text = readFileSync(path.join(root, \"bunfig.toml\"), \"utf8\");",
  "class_scope": {
   "sites": [
    "src/lib/trust-routine-command.ts: bunfigState (readFileSync of bunfig.toml)",
    "src/lib/trust-routine-command.ts: recordBunfigBaseline (called every runAgentTurn, src/commands/agent.ts 2248-2253)",
    "src/lib/trust-routine-command.ts: isRoutineBunTest (second reader of the same file)"
   ],
   "enumeration_method": "keryx ctx rg for bunfigState, recordBunfigBaseline and readFileSync in trust-routine-command.ts and agent.ts; git grep at base 01e0dbfe shows no bunfig read before this PR."
  }
 },
 {
  "id": "F-026",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "file": "src/commands/agent.ts",
  "problem": "Residual of round-1 F-006. The agent-level wiring added for AC6/AC7 is not pinned. The AC7 test passes with the tool cwd dropped from routineContext (ag-latch-cwd), with the context dropped at the latch lift (ag-gate-ctx), with the process-cwd recordBunfigBaseline() call removed (ag-baseline-process) and with shell-exec-tool no longer exposing workingDirectory (sh-workdir). AC7 runs with the process cwd in the keryx repo, whose bunfig has a preload, so `bun test` is never routine there: the test cannot fail for the reason it states and has no positive control. The fixer did not add the review-auto call-site test.",
  "impact": "Trigger: a regression in any of those four wirings. Outcome: the suite stays green; in a clean-project process cwd a lost untrusted flag at the lift site auto-runs `bun test` after untrusted content, and review commands are judged against the wrong directory.",
  "suggested_fix": "In agent-trust-orchestration.test.ts: run AC7 with process.chdir into a clean temp project and assert one approval and nothing run; add a positive control; judge a review command against the tool directory; cover a turn with no shell workingDirectory; assert shellExecTool('/x').workingDirectory === '/x'. Drafts that pass at HEAD and kill the mutants: scratchpad/t2r2/review-testing-practices/proposed-agent.test.ts (4 tests).",
  "evidence": "keryx review mutate (own package, wider agent tests): ag-latch-cwd, ag-gate-ctx, sh-workdir survived (research-evidence/mutation-1.json); the proposed tests kill all four and pass at HEAD.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-026",
  "quote": "...(tool.workingDirectory === undefined ? {} : { cwd: tool.workingDirectory }),",
  "class_scope": {
   "sites": [
    "src/commands/agent.ts: routineContext construction (untrustedContent and cwd), about line 5645",
    "src/commands/agent.ts: review-auto call site, about line 5650",
    "src/commands/agent.ts: untrusted-latch lift call site, about line 5682",
    "src/commands/agent.ts: recordBunfigBaseline() at turn start, lines 2248-2253",
    "src/harness/tool/builtin/shell-exec-tool.ts: workingDirectory exposed on the tool"
   ],
   "enumeration_method": "keryx ctx rg for isTrustRoutineCommand, recordBunfigBaseline and workingDirectory; the four unkilled mutants (ag-latch-cwd, ag-gate-ctx, ag-baseline-process, sh-workdir) map one to one onto these sites."
  }
 },
 {
  "id": "F-027",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "No test asserts that non-test bun subcommands are refused: removing `words[1] === \"test\"` passes the suite (seg-bun-test). Rated major by the reviewer; the code is correct at HEAD, no present wrong outcome exists, and the comparable round-1 gap F-012 was minor, so it is minor here.",
  "impact": "Trigger: a future edit drops the subcommand check. Outcome: bun install, run, upgrade, update and bare bun become routine.",
  "suggested_fix": "Add a negative test for `bun`, `bun install`, `bun run`, `bun upgrade`, `bun update`, `bun x` next to the positive `bun test` (proposed-lib.test.ts test 1).",
  "evidence": "Mutant seg-bun-test survived; differential probe HEAD false, mutant true.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-027",
  "quote": "return words[1] === \"test\" && isRoutineBunTest(words, walk);"
 },
 {
  "id": "F-028",
  "reviewer": "review-performance",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "bunfigState always runs Bun.TOML.parse (quadratic in file size) on the whole bunfig.toml, and isRoutineBunTest calls it before comparing the fingerprint with the baseline; recordBunfigBaseline calls it although it needs only the fingerprint. Also reported by review-highload (F-003).",
  "impact": "A large bunfig.toml (grown in the turn, from a checked-out branch, or hostile) blocks the event loop on every `bun test` classification, up to twice per shell call: 970 KB 1.1 s, a changed 1.22 MB file 3.97 s through isTrustRoutineCommand, result false, parse discarded. Realistic bunfigs cost under 1 ms.",
  "suggested_fix": "Hash first and compare to the baseline before parsing; parse only on a match and cache the verdict per fingerprint; treat a file above a small cap as preload true; have recordBunfigBaseline compute only the fingerprint. Shares the stat and cap fix with F-025.",
  "evidence": "review-performance toml.ts and bigbunfig.ts: 118 KB 13 ms, 478 KB 293 ms, 970 KB 1113 ms, 1.29 MB flat keys 28.9 s; SHA-256 of 970 KB 1.4 ms.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-028",
  "quote": "const now = bunfigState(root);"
 },
 {
  "id": "F-029",
  "reviewer": "review-architecture",
  "severity": "minor",
  "file": "src/lib/contained-path.ts",
  "problem": "After the F-002 fix the extraRoots parameter of placePathWithinSync cannot change a result: an extra root is kept only when it is inside the project root, so anything inside it is already inside the root. review-path-flags.ts still passes [\".metaproject\"], and the review-path-flags header, docs/docs/guides/permission-modes.md (about line 256) and the test 'an extra root is allowed' (contained-path-place.test.ts:59) still describe .metaproject as a second allowed root. Reported by review-architecture, review-style and review-testing-practices.",
  "impact": "Misleading API and docs; a later edit to the filter could widen confinement while the test still passes. No wrong runtime outcome today.",
  "suggested_fix": "Drop extraRoots and the argument, and reword header, guide and test titles to 'inside the project root (a .metaproject link out of the project is refused)'; or keep it and make it meaningful with a test that fails without it.",
  "evidence": "Probes by architecture and style: identical results for extraRoots [\".metaproject\"] and [] on inside, outside and symlinked-.metaproject cases.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-029",
  "quote": ".filter((real): real is string => real !== null && isInside(rootReal, real)),"
 },
 {
  "id": "F-030",
  "reviewer": "review-style",
  "severity": "minor",
  "file": "docs/docs/guides/permission-modes.md",
  "problem": "The guide says a `cd` elsewhere 'is not followed'. The code follows plain cd targets (`cd sub && cd .. && bun test` is routine) and fails closed only for unknowable ones (options, `-`, expandable targets, a relative target with CDPATH set). The guide also lists an unreadable bunfig as asking but omits one that does not parse.",
  "impact": "The doc misstates what the code enforces.",
  "suggested_fix": "Reword to: the command runs in the project root, judged after following the chain's cds; a cd whose target cannot be known makes it ask. Extend the bunfig sentence to 'appears, changes, cannot be read or does not parse'. If F-024 is fixed, add symlinked directories to the unknowable list.",
  "evidence": "style probe.ts with real bun: 'cd sub && cd .. && bun test' true, 'cd sub && bun test' false.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-030",
  "quote": "the shell's own working directory (a `cd` elsewhere, or to a target the shell may expand,"
 },
 {
  "id": "F-031",
  "reviewer": "review-style",
  "severity": "minor",
  "file": "docs/docs/cli-reference.md",
  "problem": "Round-1 F-019 asked for the cli-reference rows of review slice, retry-plan and dispatch-check to state the confinement. Only the permission-modes guide changed; cli-reference.md says nothing about the refusal.",
  "impact": "`--out`, `--diff`, `--manifest`, `--state`, `--result` and `--payload` now refuse paths outside the project root for every caller, and stdin `-` stays exempt for three flags; the command reference does not say so.",
  "suggested_fix": "One sentence under the three command intros and in the `--out` row: path flags must resolve (symlinks followed) inside the project root; `-` is standard input where a flag accepts it.",
  "evidence": "git diff --stat 01e0dbfe..HEAD -- docs lists only guides/permission-modes.md.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-031",
  "quote": null
 },
 {
  "id": "F-032",
  "reviewer": "review-style",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "The file header no longer describes the module: it promises the table runs 'even after untrusted content' although bun test is routine only while no untrusted content entered the turn, names only trust mode although review-auto shares the table, and says 'two reads of the file system' while the module also walks up with existsSync and takes realpath of cwd and root.",
  "impact": "A maintainer could treat bun test like the other rows and drop the latch, or miss that classification does file-system I/O.",
  "suggested_fix": "Say: runs without a prompt in trust and review-auto, even after untrusted content, except bun test; and list the file-system reads (project root walk, real path of cwd and root, bunfig.toml, a review command's path flags).",
  "evidence": "trust-routine-command.ts:1-11 versus :196-204.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-032",
  "quote": "// Narrow allowlist of local, non-publishing commands a `trust`-mode turn may run"
 },
 {
  "id": "F-033",
  "reviewer": "vantage-review",
  "severity": "minor",
  "file": "src/commands/review-slice.ts",
  "problem": "Behaviour change not asked for by any AC: `--manifest` is placed as a path, and `-` is exempt only for --diff, --payload and --result. At c8262aa8 dispatch-check passed `--manifest -` unplaced to readJsonSource, which reads stdin for `-`; at HEAD it becomes the absolute path of a file named `-`. retry-plan already resolved it as a file at the base, so only dispatch-check changed. Raised by review-clean-code and review-architecture; review-highload stated the opposite direction, which the orchestrator checked against both versions of the source. --manifest - is not in the help text.",
  "impact": "`keryx review dispatch-check --payload p.json --manifest -` with the manifest on stdin now fails with 'manifest is unreadable: .../-' instead of reading it. Undocumented use, low reach.",
  "suggested_fix": "Add `--manifest` to the stdin exemption for dispatch-check only, or state in the help and docs that it takes a file.",
  "evidence": "git show c8262aa8:src/commands/review-slice.ts lines 218-224 (manifestSource raw into readJsonSource) versus HEAD lines 233-239; readJsonSource treats source === \"-\" as stdin (HEAD line 174). Security probe: `--manifest -` becomes the absolute path of a file named `-`.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-033",
  "quote": "const manifest = manifestSource === undefined ? undefined : await readJsonSource<SliceManifest>(manifestSource, \"manifest\");"
 },
 {
  "id": "F-034",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "src/commands/review-slice.ts",
  "problem": "guardPaths both refuses and builds the placer, and its name says only the first; the returned closure is bound to `placed` while a PlacedPathResult inside is also `placed`. The closure returns string | undefined even with a fallback, so two callers need `as string` (lines 155 and 277); `args` lost its `readonly`. runRetryPlan keeps `const manifestPath = manifestSource;`, a pure alias left from removing path.resolve (line 273).",
  "impact": "Readability and type honesty only.",
  "suggested_fix": "Name it for the closure, give it two overloads or two functions (place(flag) and placeOr(flag, fallback)) so the casts go, restore `readonly string[]`, drop the alias.",
  "evidence": "review-slice.ts:40-54, 142-155, 228-233, 264-277.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-034",
  "quote": "function guardPaths(command: string, args: string[]): (flag: string, fallback?: string) => string | undefined {"
 },
 {
  "id": "F-035",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "src/lib/contained-path.ts",
  "problem": "placePathWithinSync is about 42 lines mixing allowed-root computation, an ancestor walk with lstat and a verdict, and takes four positional parameters of which three adjacent strings (projectRoot, candidate, cwd) are easy to swap, while its caller passes the same pair as a `where` object.",
  "impact": "The ancestor walk and the allowed-root rule cannot be tested on their own, and a swapped argument compiles.",
  "suggested_fix": "Extract nearestExistingAncestor() and allowedRoots(); take { projectRoot, cwd } as one object.",
  "evidence": "contained-path.ts:137-185; review-path-flags.ts:34-41.",
  "confidence": "medium",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-035",
  "quote": "export function placePathWithinSync("
 },
 {
  "id": "F-036",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "Unpinned cd edge cases: the arity guard (bare `cd` throws a TypeError, `cd a b` is treated as routine without it, seg-cd-arity), CDPATH exemptions for absolute, ./ and ../ targets and an empty CDPATH, `cd \"\"`, a path flag repeated as `--out=ok --out $X`, and no path-flag value after `cd $X`.",
  "impact": "A regression would silently widen or narrow the routine set; several survive the four PR test files.",
  "suggested_fix": "Add the cases from proposed-lib.test.ts tests 2, 5 and 7.",
  "evidence": "Survivors seg-cd-arity, movedTo-abs-exempt, movedTo-dotdotslash-exempt, movedTo-cdpath-empty, movedTo-empty, rf-flags, rf-empty; the proposed tests kill them and pass at HEAD.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-036",
  "quote": "if (cdpath !== undefined && cdpath !== \"\" && !path.isAbsolute(target) && !target.startsWith(\"./\") && !target.startsWith(\"../\")) {"
 },
 {
  "id": "F-037",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/review-path-flags.ts",
  "problem": "Only the --diff use of stdin `-` is pinned. Removing --payload or --result from STDIN_FLAGS, or exempting `-` for every flag (so a symlink named `-` lets `--out -` or `--manifest -` escape), passes all tests. The flag-inventory guard (review-slice-paths.test.ts:245-260) is sound for the two flag lists but does not assert STDIN_FLAGS is a subset of the confined flags, and its command-to-flag map is hand-listed (review-logic, info).",
  "impact": "The stdin exemption can regress unseen in either direction.",
  "suggested_fix": "Unit-test placeReviewPath: `-` is stdin for the three flags and placed for --out and --manifest; assert no file `-` is created; derive the guard's map from the exported *_FLAGS arrays (proposed-lib.test.ts test 10, proposed-slice.test.ts test 2).",
  "evidence": "Survivors rpf-stdin-set-payload, rpf-stdin-set-result, rpf-stdin-any-flag.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-037",
  "quote": "if (value === \"-\" && STDIN_FLAGS.has(flag)) return { ok: true, path: \"-\" };"
 },
 {
  "id": "F-038",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/commands/review-slice.ts",
  "problem": "The use-time re-placement (round-1 F-003 and F-011) is pinned for `--out` only. Skipping the late placement of retry-plan --state, --manifest and --result, or dispatch-check --payload, and the early refusal of a duplicate occurrence (`--out ok --out=<outside>`), passes the suite.",
  "impact": "A regression reopens the check-versus-use window on a write path (--state).",
  "suggested_fix": "A --state swap test (replace a directory by a symlink to outside during the stdin --result - read, expect 'outside the project root'), a duplicate-occurrence test, and a `link/../x.json` read test per read flag (proposed-slice.test.ts tests 1, 3, 4).",
  "evidence": "Survivors rs-rp-state, rs-rp-result, rs-rp-manifest, rs-dc-payload, rs-guard-refusal, rs-guard-throw.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-038",
  "quote": "const statePath = placed(\"--state\", path.join(manifestDir, RETRY_STATE_NAME)) as string;"
 },
 {
  "id": "F-039",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "Baseline keying is unpinned: recording from a subdirectory, through a symlinked path, with the default process cwd; a symlinked project root for bun test and for placePathWithinSync; and a clean bunfig with string values (the object guard in carriesPreload: dropping it recurses on strings and wrongly refuses bun test).",
  "impact": "A symlinked project could be keyed under two roots; the regression is invisible to the suite.",
  "suggested_fix": "proposed-lib.test.ts tests 3, 4, 6 and 8.",
  "evidence": "Survivors baseline-root-cwd, baseline-no-real, baseline-default-cwd, top-cwd-default, bun-root-real, bun-cwd-real, cp-root-real, top-walk-root, preload-object-guard.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-039",
  "quote": "const baseline = bunfigBaselines.get(root);"
 },
 {
  "id": "F-040",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.test.ts",
  "problem": "Round-1 F-014 is half fixed: this file (the module-level dir, `outside`, every projectDir() result) and bareProject() in agent-trust-orchestration.test.ts create tmp directories and never remove them; the module-global bunfigBaselines Map is shared across tests.",
  "impact": "Directories accumulate in the OS temp dir on every run.",
  "suggested_fix": "Track created dirs and rmSync them in afterEach/afterAll, as review-slice-paths.test.ts does.",
  "evidence": "No rmSync, afterEach or afterAll in trust-routine-command.test.ts.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-040",
  "quote": null
 },
 {
  "id": "F-041",
  "reviewer": "vantage-review",
  "severity": "info",
  "file": "src/commands/agent.ts",
  "problem": "Round-1 leftovers not done: F-023 (resolveProjectRoot still eager; isTrustRoutineCommand is evaluated twice per shell call at lines 5650 and 5682, +2 to 8 us each), F-022 (test header cites only Flow 426 AC1/AC2; finding ids cited in interactive-tools.ts:72 and in test titles; placePathWithinSync sits between resolveContainedPath and its documented sync twin), F-016 (the nullable realpath is still written twice: realOf in placePathWithinSync and the try/catch in resolveContainedPathSync), and a JSDoc that says recordBunfigBaseline is called 'when a session starts' while it runs every turn.",
  "impact": "Readability and a few microseconds.",
  "suggested_fix": "Evaluate the verdict once; hoist one realOrNull helper; cite Flow 441 AC6 instead of finding ids; move placePathWithinSync below resolveContainedPathSync.",
  "evidence": "review-clean-code, review-style, review-architecture, review-performance round-1 dispositions.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-041",
  "quote": "isTrustRoutineCommand(command, routineContext) &&"
 },
 {
  "id": "F-042",
  "reviewer": "review-logic",
  "severity": "info",
  "file": "src/lib/contained-path.ts",
  "problem": "placePathWithinSync accepts a candidate containing a NUL byte (ok = true). Not a bypass: the later fs call throws and argv cannot carry NUL.",
  "impact": "The refusal comes from an fs exception instead of the guard.",
  "suggested_fix": "Refuse \\u0000 in placePathWithinSync.",
  "evidence": "review-logic place-probe.ts case 'nul byte'; review-security-code note 5.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-042",
  "quote": "export function placePathWithinSync("
 },
 {
  "id": "F-043",
  "reviewer": "review-performance",
  "severity": "info",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "areReviewPathFlagsInside places every value of every confined flag with no cap (about 63 us per value, three times: gate and command twice). 12,500 repeated values (100 KB) cost 864 ms against 122 ms before.",
  "impact": "Degenerate input only; no legitimate command repeats a path flag more than once.",
  "suggested_fix": "Treat a confined flag given more than a few times as not routine and refuse it.",
  "evidence": "review-performance many.ts.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-043",
  "quote": "const values = confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag));"
 },
 {
  "id": "F-044",
  "reviewer": "review-testing-practices",
  "severity": "info",
  "file": "src/lib/contained-path.ts",
  "problem": "The segment-wise check in isInside (a name starting with two dots such as `..data/x` is inside) has no test (mutant cp-isinside-dotdot). isInside is pre-existing and correct at HEAD; the reviewer's wording that it uses a prefix test is wrong.",
  "impact": "Pre-existing function; a test gap only.",
  "suggested_fix": "Assert placePathWithinSync(root, '..data/x', root).ok is true and '../x' false (proposed-lib.test.ts test 9).",
  "evidence": "contained-path.ts:54-67 read by the orchestrator.",
  "confidence": "high",
  "global_id": "2026-10-13-pr-1000-round2-b2120e39#F-044",
  "quote": "function isInside(root: string, candidate: string): boolean {",
  "location_class": "pre-existing"
 }
]
```
