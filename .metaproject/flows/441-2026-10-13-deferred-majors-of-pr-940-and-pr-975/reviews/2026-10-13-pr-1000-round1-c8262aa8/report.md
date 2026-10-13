# Review report: PR 1000 (flow 441 T2, trust table)

Orchestrator: vantage-review. Generic engine: review-orchestrator. Round 1. Head c8262aa8, base origin/main. Mode all.

Verdict: changes requested. 0 blocker, 6 major, 13 minor, 4 info. The table and the command layer agree on the common cases (`..`, absolute paths, symlinked subdirectories, `--out=path` and `--out path`), and AC7 holds in production. Six majors remain: three escapes of the confinement (cd divergence, symlinked `.metaproject`, dispatch-check re-read) and three test gaps (leaked exit code, vacuous AC9 positive test, unpinned agent.ts wiring).

Verification mode: annotate. Wave C verifiers checked 13 findings (F-001 to F-011, F-015, F-019); 13 confirmed, 0 refuted. F-008 and F-007 texts were corrected to the verifier results.

## Findings

### Major

- **F-001** (major, review-security-code, verified) `src/lib/trust-routine-command.ts`
  - Problem: The table follows `cd` lexically (movedTo -> path.resolve(cwd, target)) but /bin/sh does not. isExpandable rejects only a value starting with `~` or containing `$`, and movedTo accepts any two-word `cd`. So `cd -P`, `cd -L`, `cd --` (goes to $HOME), `cd \.\.` (backslash removal), and glob targets such as `cd .?` or `cd l*` leave the table believing the shell is in one directory while it is in another. Every cwd-dependent rule (the three review path-flag checks and the `bun test` cwd === project root check) is then evaluated against the wrong directory. The runtime backstop refuseOutsidePaths derives its root from resolveProjectRoot(process.cwd()), and in the shell the cwd has already moved, so it falls back to the moved cwd and agrees with whatever the path says. It is not an independent second layer.
  - Impact: Trigger: trust or review-auto mode, untrusted content in the turn, and a command such as `cd .? && keryx review retry-plan --manifest proj/.metaproject/data/review/slices/manifest.json --state home/settings.json --next-wave --reviewer r1`, or `cd l* && keryx review slice --diff ../proj/d.diff --out x` where l* is an in-repo symlink to an outside directory. Outcome: isTrustRoutineCommand returns true with untrustedContent=true, so no approval prompt is raised, and the review tools write manifest.json, slice-NN.diff or a retry-state JSON into a directory outside the project (reproduced in $HOME and in the parent of the project). AC8, AC9 and AC10 are defeated for every cd-prefixed command. The write is limited to the files these tools produce, but the directory is attacker-chosen.
  - Fix: Treat `cd` as unknown (set walk.cwd to undefined, which makes every cwd-dependent check fail closed) unless the target is a plain word: reject a leading `-`, and any backslash, `*`, `?`, `[`, `{`, `}`, `~`, `$` or backtick. Better still, resolve the cd target with realpath and the same placePathWithinSync rule instead of lexically. Pass the real moved cwd to refuseOutsidePaths only if the command layer can know it. Add tests for `cd -P`, `cd --`, `cd \.\.`, `cd .?`, `cd l*`, `cd [.][.]`.

- **F-002** (major, review-security-code, verified) `src/lib/contained-path.ts`
  - Problem: placePathWithinSync adds the REAL path of each extra root to the allowed list. review-path-flags.ts passes [".metaproject"], so when `.metaproject` is a symlink the directory it points to becomes an allowed root, and nothing requires that real path to stay inside the project. A symlinked `.metaproject` (a shared metaproject, or a symlink committed to the reviewed repository) therefore widens AC8 to wherever the link points, including `/`.
  - Impact: Trigger: a project whose `.metaproject` is a symlink to an outside directory D, then `keryx review slice --diff d.diff --out D/x` or `--out ../victim/x` (trust or review-auto, untrusted content in the turn). Outcome: both the command-layer confinement and the trust table accept the path, the table returns routine with no prompt, and the command writes manifest.json and slice-01.diff, and deletes slice-NN.diff files, in D. With `.metaproject -> /` an absolute `--out /home/<user>/.ssh/x` is accepted. The writes are fixed file names and diff text, so this is bounded, but it is the symlink-escape class AC8 exists to close.
  - Fix: Resolve each extra root with realpath and keep it only when it is inside the project root's real path (isInside(rootReal, thatReal)), or refuse an extra root that lstat reports as a symbolic link. If worktrees must share a main checkout's `.metaproject`, make that an explicit opt-in. Add a test: `.metaproject` symlinked to an outside directory, `--out <outside>/x` refused.

- **F-003** (major, review-logic, verified) `src/commands/review-slice.ts`
  - Problem: Check versus use in runDispatchCheck. placePathWithinSync judges the --manifest value lexically after resolving the nearest existing ancestor, so `link/../m.json` is judged as `<root>/m.json` (inside). readJsonSource then opens the raw string, and the kernel resolves `link/..` physically. When `link` is a symlink to an outside directory the file read is `<outside>/m.json`. runSlice and runRetryPlan resolve the path first and use the resolved value; only dispatch-check re-reads the raw argument.
  - Impact: Trigger: `keryx review dispatch-check --payload p.json --manifest link/../m.json` with `link` a symlink to an outside directory. Outcome: the table says routine, the confinement check passes, and the command reads and parses a JSON file outside the project root. AC9 requires dispatch-check --manifest to refuse outside paths. The read is limited to JSON-shaped files, so this is a confinement bypass, not arbitrary disclosure.
  - Fix: Make refuseOutsidePaths return the resolved path that placePathWithinSync computed and pass it to readJsonSource in runDispatchCheck (as runSlice and runRetryPlan already do for their paths). Optionally have placePathWithinSync reject a `..` component that follows a symlinked component. Add a test with `link/../m.json`.

- **F-004** (major, review-testing-practices, verified) `src/commands/review-slice-paths.test.ts`
  - Problem: The test "AC9: the same flags stay usable inside the project" drives runDispatchCheck with payload {} to a failing check, which sets process.exitCode = 1. afterEach restores `process.exitCode = originalExitCode`, which is undefined, and in bun 1.4.2 assigning undefined does not reset the exit code. The repo convention (review.test.ts, hooks.test.ts) resets with `process.exitCode = 0`.
  - Impact: Trigger: `bun test src/commands/review-slice-paths.test.ts`, or any run whose last writer of the exit code is this file. Outcome: all tests pass and the process exits 1, so any step that gates on the exit status (a CI test leg with an explicit file list, `keryx review verify`, an AC check command) reports a failed run. In a multi-file run every later file starts with exitCode 1; whether a whole `bun test` is healed depends on file order, which is luck, not design.
  - Fix: Restore with `process.exitCode = originalExitCode ?? 0`. Better, stop causing the leak: give the inside-project test a payload that passes, or assert the exit code explicitly and reset it.

- **F-005** (major, review-testing-practices, verified) `src/commands/review-slice-paths.test.ts`
  - Problem: The positive control for AC9 swallows every throw and has no assertion: `runDispatchCheck(...).catch(() => {})`, with a comment saying 'what matters is that it is not refused for the path'. It cannot fail, not even on the path refusal it says it rules out. There is also no inside-path test at command level for retry-plan --manifest or --state.
  - Impact: Trigger: a regression that makes dispatch-check or retry-plan refuse a path inside the project (for example a wrong project root). Outcome: the suite stays green because the refusal is caught and discarded. Over-refusal of `.metaproject/reviews/manifest.json` would ship unnoticed. AC9 says each flag refuses outside paths; the inside half has no failing test.
  - Fix: Remove `.catch(() => {})`. Feed a payload that passes the check (or use --json and assert the output) and assert `resolves` plus an unchanged exit code. Add the same positive case for retry-plan --manifest and --state with an inside path, and assert the state file is written inside.

- **F-006** (major, review-testing-practices, verified) `src/commands/agent.ts`
  - Problem: AC6 and AC7 are tested only by calling isTrustRoutineCommand directly. Nothing runs `bun test` through runAgentTurn, so three production wirings are unpinned: the recordBunfigBaseline() call in runAgentTurn, and the `{ untrustedContent: untrustedOrigin }` argument at the review-auto site and at the untrusted-latch site. In the agent tests the cwd is this repository, whose bunfig has a preload, so `bun test` is non-routine there under any wiring. The two edits in agent-trust-orchestration.test.ts (`bun test src/foo.test.ts` -> `keryx ctx run -- git status`) were required by AC5, but they removed the only agent-level `bun test` case and no replacement was added.
  - Impact: Trigger 1: delete `{ untrustedContent: untrustedOrigin }` at the latch site. In a project without a bunfig preload `bun test` becomes routine after an MCP or web result entered the turn (AC7 broken in production) and every test stays green. Trigger 2: delete recordBunfigBaseline() from runAgentTurn. `bun test` is then never routine in a real session, so the AC6 'stays true' half is false in production and every test stays green. The mutation run confirms both.
  - Fix: In agent-trust-orchestration.test.ts add two runAgentTurn tests that process.chdir into a temp project (with .git, no bunfig, restored in finally): (1) trust mode, no untrusted content: `bun test --bail` raises no approval and runs; (2) runAfterUntrusted('trust', ['bun test']) raises one approval and does not run. Keep the `git status` rows for the ctx-run wrapper coverage.

### Minor

- **F-007** (minor, review-highload, verified) `src/lib/trust-routine-command.ts`
  - Problem: The bunfig baseline and every cwd-relative check in the table are keyed on process.cwd(). Neither isTrustRoutineCommand call site in agent.ts passes `cwd`, and recordBunfigBaseline() is called without a root. One reviewer found that an ACP session binds its shell tool to its own root (roster.ts shellExecTool(root), run with cwd: root, server.ts takes a client-supplied cwd for session/new) so the process cwd and the session root can differ; another read src/process/shell-spawn.ts and found the shell inherits process.cwd(). The shell cwd is the session root: shell-exec-tool.ts makeCommandRunner(root) spawns with cwd: root and nothing calls process.chdir (shell-spawn.ts is not what sets it). ACP sets no permissionMode so it falls back to ask and trust is unreachable there, but review-auto is reachable: runAgentTurn calls setReviewSystem('review-auto') on a matching operator line or KERYX_REVIEW_SYSTEM, and ACP calls runAgentTurn from server.ts:1215.
  - Impact: If the session root differs from the process cwd, `bun test` is judged against the wrong project's bunfig and the path-flag checks resolve against the wrong cwd (probe: process cwd is a clean project A, session root is B with a preload; isTrustRoutineCommand('bun test') is true, with { cwd: B } it is false). Reach: review-auto through ACP (verifier ran it: bun test executed the session root's preload while the table judged the process cwd's empty bunfig). Under untrusted content `bun test` still cannot lift the latch at agent.ts:5674, so the exposure is the routine-without-prompt path in review-auto. Kept minor because it needs review-auto plus an ACP session root that differs from the process cwd.
  - Fix: Give the agent turn the root its tools are bound to and pass it as `cwd` at both call sites and to recordBunfigBaseline(root); keep process.cwd() only as the default for hosts that set no root. Add a test with a process cwd and a context.cwd in different projects.

- **F-008** (minor, review-security-code, verified) `src/lib/trust-routine-command.ts`
  - Problem: The preload detector /(?:^|[\s.[,{])"?preload"?\s*=/m misses key spellings that bun 1.4.2 honours: a single-quoted key (`'preload' = [...]`), a double-quoted key with a TOML unicode escape (`"pre\u006coad"`), and an inline-table single-quoted key. (A plain double-quoted `"preload" =` key IS caught; the verifier re-ran single-quoted and inline single-quoted under bun 1.4.2 and both ran the preload with the table returning routine.) The fingerprint is a hash of bunfig.toml only, so editing the preload target or a test file between baseline and run does not trip it either.
  - Impact: Latent only. At both agent.ts call sites `bun test` is never routine under untrusted content, and a bunfig that changes after the first fingerprint is refused anyway, so a model-written preload cannot appear after the baseline. The regex is the only barrier if a future caller passes untrustedContent=false after untrusted content, or if the project already carried such a key at process start. AC6 is slightly weaker than written for those spellings.
  - Fix: Parse the file with Bun.TOML (or match any quoted or bare key form) and fail closed when parsing fails; or refuse `bun test` whenever the text contains the substring `preload`. Hash the resolved preload targets too if the baseline is meant to cover them. Keep a comment next to the regex saying the call-site rule is the real guard.

- **F-009** (minor, review-logic, verified) `src/lib/trust-routine-command.ts`
  - Problem: isExpandable ignores backslash, glob and brace expansion for the path-flag values. The value is judged literally, but the shell rewrites it before the command sees it: `--out \/etc/x` becomes /etc/x, `--out toou*` and `--out .?/x` expand to other paths (a brace form is only harmful when the shell is bash; dash does not expand it). The doc comment ('a value the shell would expand cannot be judged here') promises more than the function does.
  - Impact: The table can judge a relative, in-project value routine while the shell passes an outside path. The command-layer refuseOutsidePaths still refuses the real value, so this is a prompt-avoidance gap in the table (the operator is not asked, the command then fails), not an escape, unless combined with F-001. The wrong comment is a false assurance to the next maintainer.
  - Fix: Extend isExpandable to backslash, `*`, `?`, `[`, `{` and backtick and treat such values as not routine; share the predicate with the cd fix in F-001. Or narrow the comment to what the code tests.

- **F-010** (minor, review-security-code, verified) `src/lib/review-path-flags.ts`
  - Problem: REVIEW_CONFINED_PATH_FLAGS confines only --out, --manifest and --state. The same routine rows still take `--diff` (slice), `--result` and `--slices` (retry-plan) and `--payload` (dispatch-check) with any path, and readSliceText resolves manifest entry.path unchecked. The map is a hand-typed third copy of the flag inventory, keyed by bare subcommand name and not tied to SLICE_FLAGS, DISPATCH_CHECK_FLAGS or RETRY_PLAN_FLAGS in review-slice.ts, with a fail-open default (a subcommand that is not a key is routine). The header claim that the two layers 'cannot drift apart' holds for the placement rule only.
  - Impact: Read direction: `keryx review slice --diff /path/outside --out .metaproject/data/review/slices` is routine, and the text of any diff-shaped file outside the project is copied into the project's slice file and from there into reviewer dispatch payloads (read-poc.ts copied a line `+AWS_SECRET_ACCESS_KEY=...` from an outside file; a plain-text outside file yields 0 slices). Drift: whoever adds a path flag to one of the three commands, or a new routine row, must remember a map in another layer, and no test fails if they forget. The brief lists only the three flags, so whether --diff is a deliberate exception is an open question.
  - Fix: Declare the confined flags on the table row itself (a `confinedPathFlags` field on the row), and add one guard test in src/commands that checks every flag of the three FLAGS arrays is either confined or listed as unconfined by design. Add --diff, --result, --slices and --payload to the confined set, or document the exception in AC8 and reword the header.

- **F-011** (minor, review-highload, verified) `src/commands/review-slice.ts`
  - Problem: refuseOutsidePaths judges the real path of the flag value, but runSlice, runRetryPlan and runDispatchCheck then discard that verdict and re-resolve the raw flag lexically (`path.resolve(optionValue(args, "--out") ...)`) before mkdir, readdir, rm and write. In runSlice the window between check and use includes `await deps.gitDiff(...)`, about 20 ms measured.
  - Impact: An actor that can create a symlink in the project during that window redirects the writes: the probe swapped `out` for a symlink to an outside directory inside the diff step, and runSlice deleted the outside slice-99.diff and wrote manifest.json and slice-01.diff there. Anything that can create the symlink can already write the tree, so this is hardening, not an escalation. Same defect class as F-003.
  - Fix: Return the placed path from refuseOutsidePaths and use it for mkdir, readdir, rm and the writes in all three runners (which also closes F-003). Optionally create the directory first, then re-check its realpath once before the first write.

- **F-012** (minor, review-testing-practices, reviewer-reported) `src/lib/trust-routine-command.test.ts`
  - Problem: AC6 branches have no killing test: the equals form `--rerun-each=N` (only `--timeout=5000 --bail` is a positive), non-integer values in the equals form (only the empty `--timeout=` is tested), the preload regex alternatives `[`, `,` and `{`, an unreadable bunfig.toml, the first-call-wins rule of recordBunfigBaseline, `cd -` / `cd ~` / `cd $HOME` before a review path flag, and the `ctx run -- cd` walk copy.
  - Impact: The code is correct today; each branch can change without a red test. The mutation pass confirms it: bunTestArgsAllowed-eq-isCount-lengthonly, bunTestArgsAllowed-eq-flag-timeout-only, bunfigState-preload-regex-alts, bunfigState-unreadable, recordBunfigBaseline-first-wins, movedTo-expandable and isRoutineKeryx-ctxrun-walk-copy all survive. The cost lands on the next editor of the AC6 allow-list and of the baseline logic.
  - Fix: Add rows `bun test --timeout=5s`, `--timeout=1.5`, `--timeout=-1`, `--rerun-each=x` (false) and `--rerun-each=3`, `--timeout=5` (true); a bunfig `test = {preload = ["./x.ts"]}`; bunfig.toml created as a directory (false); a second recordBunfigBaseline(dir) after the rewrite (still false); `cd - && keryx review slice --out x.json` and `cd ~ && keryx review retry-plan --manifest m.json` in the AC10 table (false); `keryx ctx run -- cd /tmp && bun test` routine in the root while `cd /tmp && bun test` is not.

- **F-013** (minor, review-testing-practices, reviewer-reported) `src/lib/contained-path.ts`
  - Problem: The new confinement function placePathWithinSync has no direct test, and the command tests reach only the 'existing symlink to an existing outside directory' case. Unpinned: a dangling symlink, a looping symlink, the nearest-ancestor walk through several missing components, the extraRoots argument, and a command started from a subdirectory of the project (every test chdirs to the root).
  - Impact: Mutation survivors: placePathWithinSync-null-effective (dangling-link guard dropped), placePathWithinSync-tail (not-yet-existing tail dropped), placePathWithinSync-extra-roots (see F-002), refuseOutsidePaths-root (root is the cwd instead of the project root) and runRetryPlan-state-default (default state file beside the cwd instead of the manifest). A refactor from lstatSync to existsSync would turn the dangling-link refusal into an acceptance with no red test.
  - Fix: Add a contained-path unit test (or extend review-slice-paths.test.ts) with a dangling symlink `escape -> <outside>/not-yet` then `--out escape/x`, a two-link loop, `a/b/c` with missing components resolved inside, `.metaproject` symlinked outside, and a project started from `dir/sub` with `--out ../out/slices` accepted. Add a retry-plan test that omits --state and asserts the default lands beside the manifest.

- **F-014** (minor, review-testing-practices, reviewer-reported) `src/commands/review-slice-paths.test.ts`
  - Problem: Test hygiene: the escape assertion names a fixed, non-unique path (`<tmpdir>/escaped`), so a stale file left by an earlier failing run or another process turns the test red or hides a real write; both new test files create tmp directories with mkdtempSync and never remove them (projectDir() creates a second outside dir per table row); process.chdir is global state, safe only because bun runs the tests in a file serially.
  - Impact: Cost lands on whoever debugs a flaky red run in a shared tmp directory, and on disk use under /tmp for every suite run.
  - Fix: Make the escape target unique (`path.basename(dir) + '-escaped'` beside the project) and remove the tmp directories in afterEach with rmSync(recursive, force).

- **F-015** (minor, review-style, verified) `src/lib/contained-path.ts`
  - Problem: placePathWithinSync reuses the 'resolves outside the project root' wording when `effective === null`, that is for a dangling or looping symlink, although its own doc comment says those are refused for being unresolvable. The wording is false for a link that stays inside the project and points nowhere or at itself.
  - Impact: The operator reads a wrong reason and looks for a traversal that is not there. The sibling resolveContainedPath keeps the reasons apart, and AC8 asks for a named reason.
  - Fix: Split the branches: for `effective === null` say `refused: <candidate> cannot be resolved (dangling or looping symlink)`, and keep the 'resolves outside' text for the isInside failure.

- **F-016** (minor, review-clean-code, reviewer-reported) `src/lib/contained-path.ts`
  - Problem: The diff adds copies of the 'real path, or the resolved path when it cannot be resolved' helper (realOf in placePathWithinSync, realOrResolved in trust-routine-command.ts) next to the try/realpath/fallback in resolveContainedPath and resolveContainedPathSync, and the refusal sentence is now a literal in three places in the same module.
  - Impact: A fix to the fallback (for example how a looping or unreadable root is treated) has to be made in each copy, and realOrResolved in the trust table must agree with the root placePathWithinSync computes or the `bun test` root check and the path-flag check disagree about the project root. Finding F-015 shows the copies already disagree on when the wording is accurate.
  - Fix: Export one realOrResolved(target) and one outsideProjectMessage(candidate, rootReal) from contained-path.ts and use them from all three functions and from trust-routine-command.ts; keep realOf for the nullable case only.

- **F-017** (minor, review-architecture, reviewer-reported) `src/commands/agent.ts`
  - Problem: A process-global, first-call-wins Map (bunfigBaselines) is filled by a side effect at the top of runAgentTurn, which runs on every turn and for subagent turns. The writer is in commands/agent.ts and the reader is in lib, with an implicit ordering contract: if nobody calls recordBunfigBaseline every `bun test` is silently non-routine. The comment says 'the file this process started with' but the baseline is the file at the first runAgentTurn for that root, and the JSDoc says 'when a session starts'. Hosts that run many sessions per process (TUI, ACP server) make session and process ownership differ, and there is no reset or re-record path.
  - Impact: Fail-closed, so nothing unsafe happens. The cost: a host that classifies commands without runAgentTurn loses `bun test` with no error, and an operator who legitimately edits bunfig.toml mid-process gets a non-routine `bun test` until restart. Re-recording per turn would defeat the check, so first-wins is the right semantics; the ownership just needs to be explicit. Deleting the call in agent.ts breaks no test (F-006).
  - Fix: Make the baseline an explicit dependency (a small guard created at session or AgentDeps construction and passed through TrustRoutineContext, default 'no guard means not routine'), or keep the Map, export a reset for tests, fix the JSDoc and comment, and add one test that runAgentTurn records the baseline.

- **F-018** (minor, review-clean-code, reviewer-reported) `src/lib/trust-routine-command.ts`
  - Problem: isRoutineSegment is named as a predicate but mutates the shared Walk on `cd`, so its caller (segments.every) relies on left-to-right evaluation. The nested `ctx run` branch needs the defensive copy `{ ...walk }` so a `cd` inside `keryx ctx run --` does not leak to later segments, and nothing says why the copy is there.
  - Impact: No test pins the copy (`keryx ctx run -- cd` appears in no test file, and the mutants isRoutineKeryx-ctxrun-walk-copy and isRoutineKeryx-ctxrun-dashes survive). Someone who deletes the copy as redundant changes the cwd that `bun test` and the path flags are judged against, with no red test.
  - Fix: Keep the segment check pure: return the next cwd (or undefined) and thread it through a reduce in isTrustRoutineCommand. At minimum comment the `{ ...walk }` copy and add the test `keryx ctx run -- cd /tmp && bun test` routine in the root versus `cd /tmp && bun test` not.

- **F-019** (minor, review-regression, verified) `docs/docs/guides/permission-modes.md`
  - Problem: The permission-modes guide (line 276) still says read-only git subcommands and `bun test` run without asking in trust and review-auto. After this change only a plain or allow-listed `bun test` run in the project root, with an unchanged bunfig.toml that has no preload, stays routine, and never after untrusted content. The three review commands also gain path confinement that the guide does not mention.
  - Impact: Doc drift: an operator reading the guide expects `bun test` to run without asking in every project, and in this repository (bunfig has a preload) it always asks. The repo requires docs to stay current with behaviour changes.
  - Fix: Update the sentence at docs/docs/guides/permission-modes.md:276 and the review-command rows in docs/docs/cli-reference.md for the new `bun test` conditions and the path confinement of `review slice --out`, `retry-plan --manifest/--state` and `dispatch-check --manifest`.

### Info

- **F-020** (info, review-logic, reviewer-reported) `src/lib/review-path-flags.ts`
  - Problem: The confined-flag lookup is a plain-object read with a prototype-chain key and three sites use two guards: isRoutineKeryx checks Object.hasOwn, while reviewPathFlagsStayInside and reviewPathFlagRefusal use `REVIEW_CONFINED_PATH_FLAGS[x] ?? []`, which throws on `constructor`, `__proto__`, `toString` and `hasOwnProperty`.
  - Impact: No live path today: both runtime callers pass fixed subcommand names and the table call is hasOwn-guarded. A future caller that passes a user-typed subcommand gets a TypeError instead of 'no confined flags'.
  - Fix: Give the owner one accessor, `confinedPathFlags(command)` using Object.hasOwn (or a Map), and use it at all three sites.

- **F-021** (info, review-architecture, reviewer-reported) `src/lib/trust-routine-command.ts`
  - Problem: The table computes projectRoot once from the initial cwd while the command recomputes it from process.cwd() after a `cd`, so the two roots differ when the chain `cd`s into a nested repository (a .git inside the project). The table also now does file-system I/O at classification time (bunfig read, realpath, lstat), and the verdict is a snapshot taken before any segment of the chain runs.
  - Impact: Only fail-safe: for `cd sub && keryx review slice --out ../x` the table says routine, the real command run from sub refuses at run time. The header claim that the layers cannot drift is not literally true for the root; the runtime refusal is the authority. The check-then-use window is cheap and fail-closed.
  - Fix: Recompute walk.projectRoot after a `cd` (resolveProjectRoot(walk.cwd)) so both layers agree, or say in the header that the command's own refusal is authoritative and the table may be more permissive. If more file-state conditions arrive, split a pure classifyShape from a bindToWorkspace step.

- **F-022** (info, review-style, reviewer-reported) `src/commands/agent.ts`
  - Problem: Naming, placement and citation conventions: the agent.ts comment cites a finding id (`Flow 441 (F-007)`) where neighbouring comments cite a flow plus an acceptance criterion; the new library code cites no flow; trust-routine-command.test.ts keeps the 'Flow 426 AC1/AC2' header while the new tests are named AC5-AC10 of flow 441, so two numbering spaces share one file. Predicates bunTestArgsAllowed, reviewPathFlagsStayInside lack the is/has prefix and isCount tests a non-negative integer; the placement of placePathWithinSync splits resolveContainedPath from its documented twin; refusal text differs in form from sibling user errors in review-slice.ts and names only the project root although `.metaproject/` is allowed too; `Walk` and `movedTo` name usage rather than content; `real` and `out` are vague test names.
  - Impact: Readability only; the next reader cannot map the code to AC6/AC7 by grep.
  - Fix: Cite 'Flow 441 AC6' at the sites, add 'Flow 441' to the test header or prefix the new test names, rename the predicates (hasOnlyAllowedBunTestArgs, areReviewPathFlagsInside, isNonNegativeInteger), and move placePathWithinSync below resolveContainedPathSync.

- **F-023** (info, review-performance, reviewer-reported) `src/lib/trust-routine-command.ts`
  - Problem: resolveProjectRoot (an existsSync walk up to the first .git or .metaproject) runs eagerly for every command that passes the early floors, including ones that never need the project root.
  - Impact: Measured +7 to +9 us per call for those commands, up to about 0.25 ms for the slowest realistic case; evaluated at most twice per shell call before a /bin/sh fork. Immaterial.
  - Fix: Optional: compute projectRoot lazily inside Walk so only `bun test` and review path-flag segments pay.

## Questions

- Does the shell root always equal process.cwd() for ACP sessions? (Verified: no, it is the client-supplied session root; see F-007.)
- Should a symlinked `.metaproject` ever be an allowed root (F-002)?
- Is `--diff` a deliberate unconfined exception (F-010)? The AC lists only `--out`, `--manifest` and `--state`.
- Is baseline ownership the session or the process (F-017)? Is first-wins acceptable when a user edits bunfig mid-session?
- Is a whole-suite order-dependent exit code acceptable until F-004 is fixed?
- Doc drift: should docs/docs/guides/permission-modes.md:276 change with this PR (F-019)?

## Pre-existing (not blocking)

- Unconfined writers: `review scope --append`, `blast-radius --out`, `comments --out`, `ledger --out`, `ingest --append`, `complete --report`.
- automatic-review.ts has a separate lexical containment rule; ctx.ts uses `indexOf("--")`; splitWords has no backslash, glob or brace handling.
- The dist/cli.js hostile-cwd e2e fails where dist/cli.js is missing; schedule-security flakes in a combined run.
- Older lib-to-commands imports (narrate.ts, permission-mode-config.ts).
- The readdir/rm loop in runSlice (commit 6ea183fe).
- agent.ts already treats process.cwd() as the project root elsewhere.

## Verified clean

- Import direction and no cycle; both layers share the same placement rule.
- optionValues is a superset of optionValue; bunTestArgsAllowed forms are handled correctly.
- Baseline is keyed by realpath; deleted cwd and no-git-root do not throw.
- Performance about 100 us per call, regex linear.
- AC8 CLI check: exit 1 with a named reason and nothing written.
- 3541 tests pass in src/lib, src/security and neighbours; ctx run unwrap is correct; retry-plan reviewer name is sanitized.
- AC7 holds at agent.ts:5674 (untrustedContent is always true to the right of `untrustedOrigin &&`).

## Mutation pass

53 mutants: 32 killed, 21 survived, 0 invalid, 0 timed out (runs 1 and 2, research-evidence/mutation-1.md and mutation-2.md).
Survivors, run 1: isRoutineSegment-assignments, isRoutineSegment-cd-arity, movedTo-expandable, isRoutineKeryx-ctxrun-dashes, isRoutineKeryx-ctxrun-walk-copy, reviewPathFlagsStayInside-empty, bunfigState-unreadable, recordBunfigBaseline-first-wins, recordBunfigBaseline-root, agent-baseline-call, reviewPathFlagRefusal-metaproject-root, placePathWithinSync-extra-roots, placePathWithinSync-null-effective, placePathWithinSync-tail, refuseOutsidePaths-root, runRetryPlan-state-default.
Survivors, run 2: bunfigState-preload-regex-alts, bunTestArgsAllowed-eq-isCount-lengthonly, bunTestArgsAllowed-eq-flag-timeout-only, agent-latch-untrusted-dropped, agent-review-auto-untrusted-dropped.

## Answers to the brief

- (a) AC6 makes `bun test` false when bunfig carries a `preload`; this repo's bunfig has one, so `bun test` is never routine here. That is the stated intent.
- (b) First-wins is the only checkable reading of "unchanged". Global bunfig files are not honoured for preload by bun 1.4.2. Not exploitable for code execution through current call sites under untrusted content; the regex key-form gap is latent (F-008) and the cwd mismatch reaches review-auto only (F-007).
- (c) Confinement holds for `..`, absolute paths, symlinked subdirectory targets, `--out=path`, `--out path` and repeated flags; exceptions are F-001, F-002, F-003 and F-010.
- Test-edit verdict: the two edited tests in agent-trust-orchestration.test.ts were required by AC5 but only partly faithful: the only agent-level `bun test` case went away with no replacement (F-006).

## Not run

Vantage overlays: none selected (no frontend, no `--vantage` flag). Excluded generic reviewers: the six not in the required set for this scope (see `keryx review required`).

Vantage rule files read: none beyond the engine. Keryx projection: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md.

## Machine-readable findings


```json keryx:findings
[
 {
  "id": "F-001",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-001",
  "reviewer": "review-security-code",
  "severity": "major",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "The table follows `cd` lexically (movedTo -> path.resolve(cwd, target)) but /bin/sh does not. isExpandable rejects only a value starting with `~` or containing `$`, and movedTo accepts any two-word `cd`. So `cd -P`, `cd -L`, `cd --` (goes to $HOME), `cd \\.\\.` (backslash removal), and glob targets such as `cd .?` or `cd l*` leave the table believing the shell is in one directory while it is in another. Every cwd-dependent rule (the three review path-flag checks and the `bun test` cwd === project root check) is then evaluated against the wrong directory. The runtime backstop refuseOutsidePaths derives its root from resolveProjectRoot(process.cwd()), and in the shell the cwd has already moved, so it falls back to the moved cwd and agrees with whatever the path says. It is not an independent second layer.",
  "impact": "Trigger: trust or review-auto mode, untrusted content in the turn, and a command such as `cd .? && keryx review retry-plan --manifest proj/.metaproject/data/review/slices/manifest.json --state home/settings.json --next-wave --reviewer r1`, or `cd l* && keryx review slice --diff ../proj/d.diff --out x` where l* is an in-repo symlink to an outside directory. Outcome: isTrustRoutineCommand returns true with untrustedContent=true, so no approval prompt is raised, and the review tools write manifest.json, slice-NN.diff or a retry-state JSON into a directory outside the project (reproduced in $HOME and in the parent of the project). AC8, AC9 and AC10 are defeated for every cd-prefixed command. The write is limited to the files these tools produce, but the directory is attacker-chosen.",
  "suggested_fix": "Treat `cd` as unknown (set walk.cwd to undefined, which makes every cwd-dependent check fail closed) unless the target is a plain word: reject a leading `-`, and any backslash, `*`, `?`, `[`, `{`, `}`, `~`, `$` or backtick. Better still, resolve the cd target with realpath and the same placePathWithinSync rule instead of lexically. Pass the real moved cwd to refuseOutsidePaths only if the command layer can know it. Add tests for `cd -P`, `cd --`, `cd \\.\\.`, `cd .?`, `cd l*`, `cd [.][.]`.",
  "evidence": "Probes run against the real /bin/sh (dash) with a keryx shim: /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-logic/cd-probe.ts (cd -P, -L, --, \\.\\., .? all give tableRoutine=true and a manifest written outside the project; `cd ..` is correctly refused), /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-security-code/cdglob2-poc.ts (`cd .?`: home/settings.json created outside proj/) and /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-security-code/cdglob-poc.ts (`cd l*`: x/manifest.json and slice-01.diff written through the symlink). Mutation: isRoutineSegment-assignments, isRoutineSegment-cd-arity and movedTo-expandable all survive, so no test pins the cd rules beyond the plain forms.",
  "confidence": "high",
  "quote": "walk.cwd = movedTo(walk.cwd, words[1] as string);",
  "class_scope": {
   "sites": [
    "src/lib/trust-routine-command.ts: isRoutineSegment case \"cd\" (walk.cwd = movedTo(...))",
    "src/lib/trust-routine-command.ts: movedTo / isExpandable",
    "src/lib/trust-routine-command.ts: reviewPathFlagsStayInside (reads walk.cwd)",
    "src/lib/trust-routine-command.ts: isRoutineBunTest (cwd === project root check)",
    "src/commands/review-slice.ts: refuseOutsidePaths (not an independent layer)"
   ],
   "enumeration_method": "keryx ctx rg for movedTo, isExpandable, walk.cwd and refuseOutsidePaths in src/; every cd form (-P, -L, --, backslash, glob metacharacters) run through the real shell by two reviewers; brace targets are rejected earlier by hasUnquotedMetacharacter."
  }
 },
 {
  "id": "F-002",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-002",
  "reviewer": "review-security-code",
  "severity": "major",
  "file": "src/lib/contained-path.ts",
  "problem": "placePathWithinSync adds the REAL path of each extra root to the allowed list. review-path-flags.ts passes [\".metaproject\"], so when `.metaproject` is a symlink the directory it points to becomes an allowed root, and nothing requires that real path to stay inside the project. A symlinked `.metaproject` (a shared metaproject, or a symlink committed to the reviewed repository) therefore widens AC8 to wherever the link points, including `/`.",
  "impact": "Trigger: a project whose `.metaproject` is a symlink to an outside directory D, then `keryx review slice --diff d.diff --out D/x` or `--out ../victim/x` (trust or review-auto, untrusted content in the turn). Outcome: both the command-layer confinement and the trust table accept the path, the table returns routine with no prompt, and the command writes manifest.json and slice-01.diff, and deletes slice-NN.diff files, in D. With `.metaproject -> /` an absolute `--out /home/<user>/.ssh/x` is accepted. The writes are fixed file names and diff text, so this is bounded, but it is the symlink-escape class AC8 exists to close.",
  "suggested_fix": "Resolve each extra root with realpath and keep it only when it is inside the project root's real path (isInside(rootReal, thatReal)), or refuse an extra root that lstat reports as a symbolic link. If worktrees must share a main checkout's `.metaproject`, make that an explicit opt-in. Add a test: `.metaproject` symlinked to an outside directory, `--out <outside>/x` refused.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-security-code/mp-symlink-poc.ts printed routine=true, exit=0, victim: [\"x\"], x: [\"manifest.json\",\"slice-01.diff\"] for both commands. /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-highload/probe2.ts: `.metaproject -> outside; --out <outside>/x: ALLOWED`, `.metaproject -> / ; --out /etc/x: ALLOWED`, table returns true for `--out /home/altsay/.ssh/x`. Mutation: placePathWithinSync-extra-roots survives (replacing the allowed list with [rootReal] breaks no test), so the extra-root rule has no test in either direction.",
  "confidence": "high",
  "quote": "const allowed = [rootReal, ...extraRoots.map((extra) => realOf(path.resolve(rootReal, extra))).filter((real): real is string => real !== null)];",
  "class_scope": {
   "sites": [
    "src/lib/contained-path.ts: placePathWithinSync (allowed roots)",
    "src/lib/review-path-flags.ts: reviewPathFlagRefusal (extra root [\".metaproject\"])"
   ],
   "enumeration_method": "keryx ctx rg for placePathWithinSync and extraRoots across src/: one caller passes an extra root; both the command layer and the table reach it through reviewPathFlagRefusal."
  }
 },
 {
  "id": "F-003",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-003",
  "reviewer": "review-logic",
  "severity": "major",
  "file": "src/commands/review-slice.ts",
  "problem": "Check versus use in runDispatchCheck. placePathWithinSync judges the --manifest value lexically after resolving the nearest existing ancestor, so `link/../m.json` is judged as `<root>/m.json` (inside). readJsonSource then opens the raw string, and the kernel resolves `link/..` physically. When `link` is a symlink to an outside directory the file read is `<outside>/m.json`. runSlice and runRetryPlan resolve the path first and use the resolved value; only dispatch-check re-reads the raw argument.",
  "impact": "Trigger: `keryx review dispatch-check --payload p.json --manifest link/../m.json` with `link` a symlink to an outside directory. Outcome: the table says routine, the confinement check passes, and the command reads and parses a JSON file outside the project root. AC9 requires dispatch-check --manifest to refuse outside paths. The read is limited to JSON-shaped files, so this is a confinement bypass, not arbitrary disclosure.",
  "suggested_fix": "Make refuseOutsidePaths return the resolved path that placePathWithinSync computed and pass it to readJsonSource in runDispatchCheck (as runSlice and runRetryPlan already do for their paths). Optionally have placePathWithinSync reject a `..` component that follows a symlinked component. Add a test with `link/../m.json`.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-logic/dotdot-probe.ts: dispatch-check with `link/../m.json` exits 0 reading the outside file, and `link/../garbage.json` fails with a JSON parse error from the outside file. `--out link/../x` for slice stays inside.",
  "confidence": "high",
  "quote": "refuseOutsidePaths(...) then readJsonSource(manifestSource)  (raw, unresolved string)",
  "class_scope": {
   "sites": [
    "src/commands/review-slice.ts: runDispatchCheck (readJsonSource of the raw --manifest)",
    "src/commands/review-slice.ts: runRetryPlan and runSlice (use the resolved value, not affected)"
   ],
   "enumeration_method": "Read the three runners and compared what each passes to the file API after refuseOutsidePaths; only dispatch-check uses the raw string."
  }
 },
 {
  "id": "F-004",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-004",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "file": "src/commands/review-slice-paths.test.ts",
  "problem": "The test \"AC9: the same flags stay usable inside the project\" drives runDispatchCheck with payload {} to a failing check, which sets process.exitCode = 1. afterEach restores `process.exitCode = originalExitCode`, which is undefined, and in bun 1.4.2 assigning undefined does not reset the exit code. The repo convention (review.test.ts, hooks.test.ts) resets with `process.exitCode = 0`.",
  "impact": "Trigger: `bun test src/commands/review-slice-paths.test.ts`, or any run whose last writer of the exit code is this file. Outcome: all tests pass and the process exits 1, so any step that gates on the exit status (a CI test leg with an explicit file list, `keryx review verify`, an AC check command) reports a failed run. In a multi-file run every later file starts with exitCode 1; whether a whole `bun test` is healed depends on file order, which is luck, not design.",
  "suggested_fix": "Restore with `process.exitCode = originalExitCode ?? 0`. Better, stop causing the leak: give the inside-project test a payload that passes, or assert the exit code explicitly and reset it.",
  "evidence": "`bun test src/commands/review-slice-paths.test.ts` -> 9 pass, 0 fail, exit=1 (reproduced by the logic, testing and regression reviewers, and by the mutation baseline, which refused until the wrapper ignored the exit code). `bun -e 'process.exitCode=1; process.exitCode=undefined; console.log(process.exitCode)'` prints 1. Probe tests in /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-testing-practices/a.test.ts, b.test.ts, c.test.ts. `keryx ctx run -- bun test` over the four-file run reports `Exit code: 1` with 100 pass 0 fail.",
  "confidence": "high",
  "quote": "process.exitCode = originalExitCode;",
  "class_scope": {
   "sites": [
    "src/commands/review-slice-paths.test.ts: afterEach (process.exitCode = originalExitCode)",
    "src/commands/review-slice-paths.test.ts: test AC9 the same flags stay usable inside the project (the only test that sets exitCode)"
   ],
   "enumeration_method": "keryx ctx rg for exitCode in the changed test files: one capture and one restore in the new file; every test was run alone with -t filters and only the 'stay usable' test leaves exitCode at 1. No other changed test file sets process.exitCode."
  }
 },
 {
  "id": "F-005",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-005",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "file": "src/commands/review-slice-paths.test.ts",
  "problem": "The positive control for AC9 swallows every throw and has no assertion: `runDispatchCheck(...).catch(() => {})`, with a comment saying 'what matters is that it is not refused for the path'. It cannot fail, not even on the path refusal it says it rules out. There is also no inside-path test at command level for retry-plan --manifest or --state.",
  "impact": "Trigger: a regression that makes dispatch-check or retry-plan refuse a path inside the project (for example a wrong project root). Outcome: the suite stays green because the refusal is caught and discarded. Over-refusal of `.metaproject/reviews/manifest.json` would ship unnoticed. AC9 says each flag refuses outside paths; the inside half has no failing test.",
  "suggested_fix": "Remove `.catch(() => {})`. Feed a payload that passes the check (or use --json and assert the output) and assert `resolves` plus an unchanged exit code. Add the same positive case for retry-plan --manifest and --state with an inside path, and assert the state file is written inside.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-testing-practices/swallow.test.ts runs the identical call shape against an OUTSIDE manifest: the promise rejects with 'refused: ... resolves outside the project root', the .catch swallows it, and the test reports 1 pass 0 fail.",
  "confidence": "high",
  "quote": "await quietly(() => runDispatchCheck([\"--payload\", payload, \"--manifest\", manifest], deps).catch(() => {}));",
  "class_scope": {
   "sites": [
    "src/commands/review-slice-paths.test.ts: AC9 'stay usable' test (dispatch-check, swallowed)",
    "src/commands/review-slice-paths.test.ts: no inside-path test for retry-plan --manifest",
    "src/commands/review-slice-paths.test.ts: no inside-path test for retry-plan --state"
   ],
   "enumeration_method": "Listed every test in the file; the three AC9 refusal tests only expect a rejection, and the only inside-path command test for an AC9 flag is the swallowed one."
  }
 },
 {
  "id": "F-006",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-006",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "file": "src/commands/agent.ts",
  "problem": "AC6 and AC7 are tested only by calling isTrustRoutineCommand directly. Nothing runs `bun test` through runAgentTurn, so three production wirings are unpinned: the recordBunfigBaseline() call in runAgentTurn, and the `{ untrustedContent: untrustedOrigin }` argument at the review-auto site and at the untrusted-latch site. In the agent tests the cwd is this repository, whose bunfig has a preload, so `bun test` is non-routine there under any wiring. The two edits in agent-trust-orchestration.test.ts (`bun test src/foo.test.ts` -> `keryx ctx run -- git status`) were required by AC5, but they removed the only agent-level `bun test` case and no replacement was added.",
  "impact": "Trigger 1: delete `{ untrustedContent: untrustedOrigin }` at the latch site. In a project without a bunfig preload `bun test` becomes routine after an MCP or web result entered the turn (AC7 broken in production) and every test stays green. Trigger 2: delete recordBunfigBaseline() from runAgentTurn. `bun test` is then never routine in a real session, so the AC6 'stays true' half is false in production and every test stays green. The mutation run confirms both.",
  "suggested_fix": "In agent-trust-orchestration.test.ts add two runAgentTurn tests that process.chdir into a temp project (with .git, no bunfig, restored in finally): (1) trust mode, no untrusted content: `bun test --bail` raises no approval and runs; (2) runAfterUntrusted('trust', ['bun test']) raises one approval and does not run. Keep the `git status` rows for the ctx-run wrapper coverage.",
  "evidence": "Mutation pass (keryx review mutate, 53 mutants, package research-evidence/mutation-1.md and mutation-2.md): agent-baseline-call, agent-latch-untrusted-dropped and agent-review-auto-untrusted-dropped all SURVIVED. keryx ctx rg 'bun test' over the six test files that reference the table returned 0 matches at agent level. agent.ts has exactly two isTrustRoutineCommand call sites and one recordBunfigBaseline call.",
  "confidence": "high",
  "quote": "isTrustRoutineCommand(command, { untrustedContent: untrustedOrigin }) &&",
  "class_scope": {
   "sites": [
    "src/commands/agent.ts: runAgentTurn recordBunfigBaseline()",
    "src/commands/agent.ts: review-auto operator-denied bypass (isTrustRoutineCommand call)",
    "src/commands/agent.ts: untrustedGate (isTrustRoutineCommand call)",
    "src/commands/agent-trust-orchestration.test.ts: the two `keryx ctx run -- git status` replacements"
   ],
   "enumeration_method": "keryx ctx rg 'isTrustRoutineCommand\\(' and 'recordBunfigBaseline' in src/commands/agent.ts (2 and 1 matches); cross-checked against 'bun test' in all tests that reference the table; then the three survived mutants."
  }
 },
 {
  "id": "F-007",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-007",
  "reviewer": "review-highload",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "The bunfig baseline and every cwd-relative check in the table are keyed on process.cwd(). Neither isTrustRoutineCommand call site in agent.ts passes `cwd`, and recordBunfigBaseline() is called without a root. One reviewer found that an ACP session binds its shell tool to its own root (roster.ts shellExecTool(root), run with cwd: root, server.ts takes a client-supplied cwd for session/new) so the process cwd and the session root can differ; another read src/process/shell-spawn.ts and found the shell inherits process.cwd(). The shell cwd is the session root: shell-exec-tool.ts makeCommandRunner(root) spawns with cwd: root and nothing calls process.chdir (shell-spawn.ts is not what sets it). ACP sets no permissionMode so it falls back to ask and trust is unreachable there, but review-auto is reachable: runAgentTurn calls setReviewSystem('review-auto') on a matching operator line or KERYX_REVIEW_SYSTEM, and ACP calls runAgentTurn from server.ts:1215.",
  "impact": "If the session root differs from the process cwd, `bun test` is judged against the wrong project's bunfig and the path-flag checks resolve against the wrong cwd (probe: process cwd is a clean project A, session root is B with a preload; isTrustRoutineCommand('bun test') is true, with { cwd: B } it is false). Reach: review-auto through ACP (verifier ran it: bun test executed the session root's preload while the table judged the process cwd's empty bunfig). Under untrusted content `bun test` still cannot lift the latch at agent.ts:5674, so the exposure is the routine-without-prompt path in review-auto. Kept minor because it needs review-auto plus an ACP session root that differs from the process cwd.",
  "suggested_fix": "Give the agent turn the root its tools are bound to and pass it as `cwd` at both call sites and to recordBunfigBaseline(root); keep process.cwd() only as the default for hosts that set no root. Add a test with a process cwd and a context.cwd in different projects.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-highload/probe1.ts: `agent.ts call (no cwd), session root is B with preload: true` -> true; `with cwd=B` -> false. Sites read: server.ts:948,1215; roster.ts:73; shell-exec-tool.ts:243; agent.ts:2249,5642,5674. A reviewer's contradicting read of shell-spawn.ts was resolved by the verifier: that file does not set the cwd, makeCommandRunner does. Mutation recordBunfigBaseline-root survives (keying by cwd instead of project root breaks no test).",
  "confidence": "high",
  "quote": "const cwd = path.resolve(context.cwd ?? process.cwd());"
 },
 {
  "id": "F-008",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-008",
  "reviewer": "review-security-code",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "The preload detector /(?:^|[\\s.[,{])\"?preload\"?\\s*=/m misses key spellings that bun 1.4.2 honours: a single-quoted key (`'preload' = [...]`), a double-quoted key with a TOML unicode escape (`\"pre\\u006coad\"`), and an inline-table single-quoted key. (A plain double-quoted `\"preload\" =` key IS caught; the verifier re-ran single-quoted and inline single-quoted under bun 1.4.2 and both ran the preload with the table returning routine.) The fingerprint is a hash of bunfig.toml only, so editing the preload target or a test file between baseline and run does not trip it either.",
  "impact": "Latent only. At both agent.ts call sites `bun test` is never routine under untrusted content, and a bunfig that changes after the first fingerprint is refused anyway, so a model-written preload cannot appear after the baseline. The regex is the only barrier if a future caller passes untrustedContent=false after untrusted content, or if the project already carried such a key at process start. AC6 is slightly weaker than written for those spellings.",
  "suggested_fix": "Parse the file with Bun.TOML (or match any quoted or bare key form) and fail closed when parsing fails; or refuse `bun test` whenever the text contains the substring `preload`. Hash the resolved preload targets too if the baseline is meant to cover them. Keep a comment next to the regex saying the call-site rule is the real guard.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-logic/bunfig-probe.ts and /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-security-code/bunfig-probe.ts: spellings #2, #4 and #9 ran the preload under bun 1.4.2 while the regex returned false. bunfig-probe2.ts: ~/.bunfig.toml, XDG bunfig, parent-dir bunfig and .env BUN_OPTIONS did not run a preload; a modified preload target and a modified test file both ran their code with the hash unchanged. Mutation bunfigState-preload-regex-alts survives (dropping the comma and brace alternatives breaks no test); bunfigState-unreadable also survives.",
  "confidence": "high",
  "quote": "preload: /(?:^|[\\s.[,{])\"?preload\"?\\s*=/m.test(text)"
 },
 {
  "id": "F-009",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-009",
  "reviewer": "review-logic",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "isExpandable ignores backslash, glob and brace expansion for the path-flag values. The value is judged literally, but the shell rewrites it before the command sees it: `--out \\/etc/x` becomes /etc/x, `--out toou*` and `--out .?/x` expand to other paths (a brace form is only harmful when the shell is bash; dash does not expand it). The doc comment ('a value the shell would expand cannot be judged here') promises more than the function does.",
  "impact": "The table can judge a relative, in-project value routine while the shell passes an outside path. The command-layer refuseOutsidePaths still refuses the real value, so this is a prompt-avoidance gap in the table (the operator is not asked, the command then fails), not an escape, unless combined with F-001. The wrong comment is a false assurance to the next maintainer.",
  "suggested_fix": "Extend isExpandable to backslash, `*`, `?`, `[`, `{` and backtick and treat such values as not routine; share the predicate with the cd fix in F-001. Or narrow the comment to what the code tests.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-logic/table-probe.ts rows 1-5 (`\\/etc/x`, `toou*`, `{..,}/x`); review-style probe for `--out li*`.",
  "confidence": "high",
  "quote": "return value.startsWith(\"~\") || value.includes(\"$\");"
 },
 {
  "id": "F-010",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-010",
  "reviewer": "review-security-code",
  "severity": "minor",
  "file": "src/lib/review-path-flags.ts",
  "problem": "REVIEW_CONFINED_PATH_FLAGS confines only --out, --manifest and --state. The same routine rows still take `--diff` (slice), `--result` and `--slices` (retry-plan) and `--payload` (dispatch-check) with any path, and readSliceText resolves manifest entry.path unchecked. The map is a hand-typed third copy of the flag inventory, keyed by bare subcommand name and not tied to SLICE_FLAGS, DISPATCH_CHECK_FLAGS or RETRY_PLAN_FLAGS in review-slice.ts, with a fail-open default (a subcommand that is not a key is routine). The header claim that the two layers 'cannot drift apart' holds for the placement rule only.",
  "impact": "Read direction: `keryx review slice --diff /path/outside --out .metaproject/data/review/slices` is routine, and the text of any diff-shaped file outside the project is copied into the project's slice file and from there into reviewer dispatch payloads (read-poc.ts copied a line `+AWS_SECRET_ACCESS_KEY=...` from an outside file; a plain-text outside file yields 0 slices). Drift: whoever adds a path flag to one of the three commands, or a new routine row, must remember a map in another layer, and no test fails if they forget. The brief lists only the three flags, so whether --diff is a deliberate exception is an open question.",
  "suggested_fix": "Declare the confined flags on the table row itself (a `confinedPathFlags` field on the row), and add one guard test in src/commands that checks every flag of the three FLAGS arrays is either confined or listed as unconfined by design. Add --diff, --result, --slices and --payload to the confined set, or document the exception in AC8 and reword the header.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-security-code/read-poc.ts and /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-architecture/probe.ts: isTrustRoutineCommand is true for `slice --diff /etc/passwd`, `dispatch-check --payload /etc/passwd`, `retry-plan --manifest m.json --result /etc/passwd`, `ledger build pkg --out /etc/x`, `scope --append /etc/x` and `complete --report /etc/x`, and false only for `slice --out /etc/x`. keryx ctx rg for the three FLAGS names shows 6 hits in review-slice.ts and none in any test.",
  "confidence": "medium",
  "quote": "\"retry-plan\": [\"--manifest\", \"--state\"]"
 },
 {
  "id": "F-011",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-011",
  "reviewer": "review-highload",
  "severity": "minor",
  "file": "src/commands/review-slice.ts",
  "problem": "refuseOutsidePaths judges the real path of the flag value, but runSlice, runRetryPlan and runDispatchCheck then discard that verdict and re-resolve the raw flag lexically (`path.resolve(optionValue(args, \"--out\") ...)`) before mkdir, readdir, rm and write. In runSlice the window between check and use includes `await deps.gitDiff(...)`, about 20 ms measured.",
  "impact": "An actor that can create a symlink in the project during that window redirects the writes: the probe swapped `out` for a symlink to an outside directory inside the diff step, and runSlice deleted the outside slice-99.diff and wrote manifest.json and slice-01.diff there. Anything that can create the symlink can already write the tree, so this is hardening, not an escalation. Same defect class as F-003.",
  "suggested_fix": "Return the placed path from refuseOutsidePaths and use it for mkdir, readdir, rm and the writes in all three runners (which also closes F-003). Optionally create the directory first, then re-check its realpath once before the first write.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-highload/probe3.ts: `outside dir now holds: [ manifest.json, slice-01.diff ]`, `victim slice-99.diff still exists: false`. The swap is injected through the gitDiff dependency, so it shows the missing re-validation, not a measured race rate.",
  "confidence": "medium",
  "quote": "const outDir = path.resolve(optionValue(args, \"--out\") ?? DEFAULT_SLICE_DIR);"
 },
 {
  "id": "F-012",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-012",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.test.ts",
  "problem": "AC6 branches have no killing test: the equals form `--rerun-each=N` (only `--timeout=5000 --bail` is a positive), non-integer values in the equals form (only the empty `--timeout=` is tested), the preload regex alternatives `[`, `,` and `{`, an unreadable bunfig.toml, the first-call-wins rule of recordBunfigBaseline, `cd -` / `cd ~` / `cd $HOME` before a review path flag, and the `ctx run -- cd` walk copy.",
  "impact": "The code is correct today; each branch can change without a red test. The mutation pass confirms it: bunTestArgsAllowed-eq-isCount-lengthonly, bunTestArgsAllowed-eq-flag-timeout-only, bunfigState-preload-regex-alts, bunfigState-unreadable, recordBunfigBaseline-first-wins, movedTo-expandable and isRoutineKeryx-ctxrun-walk-copy all survive. The cost lands on the next editor of the AC6 allow-list and of the baseline logic.",
  "suggested_fix": "Add rows `bun test --timeout=5s`, `--timeout=1.5`, `--timeout=-1`, `--rerun-each=x` (false) and `--rerun-each=3`, `--timeout=5` (true); a bunfig `test = {preload = [\"./x.ts\"]}`; bunfig.toml created as a directory (false); a second recordBunfigBaseline(dir) after the rewrite (still false); `cd - && keryx review slice --out x.json` and `cd ~ && keryx review retry-plan --manifest m.json` in the AC10 table (false); `keryx ctx run -- cd /tmp && bun test` routine in the root while `cd /tmp && bun test` is not.",
  "evidence": "keryx review mutate, 53 mutants: 32 killed, 21 survived; the survivors named here are in mutation-1.md and mutation-2.md. Reviewer proposals M1-M6 in rv1000/testing.handback.txt.",
  "confidence": "high",
  "quote": "\"bun test --timeout=\","
 },
 {
  "id": "F-013",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-013",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/lib/contained-path.ts",
  "problem": "The new confinement function placePathWithinSync has no direct test, and the command tests reach only the 'existing symlink to an existing outside directory' case. Unpinned: a dangling symlink, a looping symlink, the nearest-ancestor walk through several missing components, the extraRoots argument, and a command started from a subdirectory of the project (every test chdirs to the root).",
  "impact": "Mutation survivors: placePathWithinSync-null-effective (dangling-link guard dropped), placePathWithinSync-tail (not-yet-existing tail dropped), placePathWithinSync-extra-roots (see F-002), refuseOutsidePaths-root (root is the cwd instead of the project root) and runRetryPlan-state-default (default state file beside the cwd instead of the manifest). A refactor from lstatSync to existsSync would turn the dangling-link refusal into an acceptance with no red test.",
  "suggested_fix": "Add a contained-path unit test (or extend review-slice-paths.test.ts) with a dangling symlink `escape -> <outside>/not-yet` then `--out escape/x`, a two-link loop, `a/b/c` with missing components resolved inside, `.metaproject` symlinked outside, and a project started from `dir/sub` with `--out ../out/slices` accepted. Add a retry-plan test that omits --state and asserts the default lands beside the manifest.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-testing-practices/dangling.ts: dangling -> ok:false, loop -> ok:false, plain new a/b/c -> ok:true. keryx ctx rg -l placePathWithinSync src lists no contained-path test file. Mutation survivors listed above.",
  "confidence": "high",
  "quote": "export function placePathWithinSync("
 },
 {
  "id": "F-014",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-014",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "file": "src/commands/review-slice-paths.test.ts",
  "problem": "Test hygiene: the escape assertion names a fixed, non-unique path (`<tmpdir>/escaped`), so a stale file left by an earlier failing run or another process turns the test red or hides a real write; both new test files create tmp directories with mkdtempSync and never remove them (projectDir() creates a second outside dir per table row); process.chdir is global state, safe only because bun runs the tests in a file serially.",
  "impact": "Cost lands on whoever debugs a flaky red run in a shared tmp directory, and on disk use under /tmp for every suite run.",
  "suggested_fix": "Make the escape target unique (`path.basename(dir) + '-escaped'` beside the project) and remove the tmp directories in afterEach with rmSync(recursive, force).",
  "evidence": "Read of beforeEach/afterEach in review-slice-paths.test.ts and projectDir() in trust-routine-command.test.ts: no rm anywhere.",
  "confidence": "high",
  "quote": "expect(existsSync(path.join(dir, \"..\", \"escaped\"))).toBe(false);"
 },
 {
  "id": "F-015",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-015",
  "reviewer": "review-style",
  "severity": "minor",
  "file": "src/lib/contained-path.ts",
  "problem": "placePathWithinSync reuses the 'resolves outside the project root' wording when `effective === null`, that is for a dangling or looping symlink, although its own doc comment says those are refused for being unresolvable. The wording is false for a link that stays inside the project and points nowhere or at itself.",
  "impact": "The operator reads a wrong reason and looks for a traversal that is not there. The sibling resolveContainedPath keeps the reasons apart, and AC8 asks for a named reason.",
  "suggested_fix": "Split the branches: for `effective === null` say `refused: <candidate> cannot be resolved (dangling or looping symlink)`, and keep the 'resolves outside' text for the isInside failure.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-style/probe.ts: placePathWithinSync(d,'dangling/x',d) and placePathWithinSync(d,'loop',d) both return `refused: <path> resolves outside the project root. Paths must stay inside <root>.` with both targets inside the root; reviewPathFlagRefusal('slice',['--out','dangling']) returns the same text.",
  "confidence": "high",
  "quote": "message: `refused: ${candidate} resolves outside the project root. Paths must stay inside ${rootReal}.`,"
 },
 {
  "id": "F-016",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-016",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "src/lib/contained-path.ts",
  "problem": "The diff adds copies of the 'real path, or the resolved path when it cannot be resolved' helper (realOf in placePathWithinSync, realOrResolved in trust-routine-command.ts) next to the try/realpath/fallback in resolveContainedPath and resolveContainedPathSync, and the refusal sentence is now a literal in three places in the same module.",
  "impact": "A fix to the fallback (for example how a looping or unreadable root is treated) has to be made in each copy, and realOrResolved in the trust table must agree with the root placePathWithinSync computes or the `bun test` root check and the path-flag check disagree about the project root. Finding F-015 shows the copies already disagree on when the wording is accurate.",
  "suggested_fix": "Export one realOrResolved(target) and one outsideProjectMessage(candidate, rootReal) from contained-path.ts and use them from all three functions and from trust-routine-command.ts; keep realOf for the nullable case only.",
  "evidence": "keryx ctx rg for realpathSync and 'resolves outside the project root' in src/lib/contained-path.ts and src/lib/trust-routine-command.ts: three copies of the message (lines 104, 160, 200) and three realpath-with-fallback shapes.",
  "confidence": "high",
  "quote": "const rootReal = realOf(projectRoot) ?? path.resolve(projectRoot);"
 },
 {
  "id": "F-017",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-017",
  "reviewer": "review-architecture",
  "severity": "minor",
  "file": "src/commands/agent.ts",
  "problem": "A process-global, first-call-wins Map (bunfigBaselines) is filled by a side effect at the top of runAgentTurn, which runs on every turn and for subagent turns. The writer is in commands/agent.ts and the reader is in lib, with an implicit ordering contract: if nobody calls recordBunfigBaseline every `bun test` is silently non-routine. The comment says 'the file this process started with' but the baseline is the file at the first runAgentTurn for that root, and the JSDoc says 'when a session starts'. Hosts that run many sessions per process (TUI, ACP server) make session and process ownership differ, and there is no reset or re-record path.",
  "impact": "Fail-closed, so nothing unsafe happens. The cost: a host that classifies commands without runAgentTurn loses `bun test` with no error, and an operator who legitimately edits bunfig.toml mid-process gets a non-routine `bun test` until restart. Re-recording per turn would defeat the check, so first-wins is the right semantics; the ownership just needs to be explicit. Deleting the call in agent.ts breaks no test (F-006).",
  "suggested_fix": "Make the baseline an explicit dependency (a small guard created at session or AgentDeps construction and passed through TrustRoutineContext, default 'no guard means not routine'), or keep the Map, export a reset for tests, fix the JSDoc and comment, and add one test that runAgentTurn records the baseline.",
  "evidence": "keryx ctx rg for recordBunfigBaseline / bunfigBaselines / bunfigState: the only non-test writer is agent.ts:2249; nine files call runAgentTurn. Probe 4 in review-highload shows `unchanged: true`, `after a legitimate edit and a re-record call: false`, `edit reverted: true`. Mutation recordBunfigBaseline-first-wins survives.",
  "confidence": "high",
  "quote": "  // Flow 441 (F-007): `bun test` is routine only while bunfig.toml is the file this process started with.\n  recordBunfigBaseline();"
 },
 {
  "id": "F-018",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-018",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "isRoutineSegment is named as a predicate but mutates the shared Walk on `cd`, so its caller (segments.every) relies on left-to-right evaluation. The nested `ctx run` branch needs the defensive copy `{ ...walk }` so a `cd` inside `keryx ctx run --` does not leak to later segments, and nothing says why the copy is there.",
  "impact": "No test pins the copy (`keryx ctx run -- cd` appears in no test file, and the mutants isRoutineKeryx-ctxrun-walk-copy and isRoutineKeryx-ctxrun-dashes survive). Someone who deletes the copy as redundant changes the cwd that `bun test` and the path flags are judged against, with no red test.",
  "suggested_fix": "Keep the segment check pure: return the next cwd (or undefined) and thread it through a reduce in isTrustRoutineCommand. At minimum comment the `{ ...walk }` copy and add the test `keryx ctx run -- cd /tmp && bun test` routine in the root versus `cd /tmp && bun test` not.",
  "evidence": "keryx ctx rg 'ctx run -- cd' src --glob '*.test.ts' returned no matches; mutation survivors isRoutineKeryx-ctxrun-walk-copy and isRoutineKeryx-ctxrun-dashes.",
  "confidence": "high",
  "quote": "      walk.cwd = movedTo(walk.cwd, words[1] as string);\n      return true;"
 },
 {
  "id": "F-019",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-019",
  "reviewer": "review-regression",
  "severity": "minor",
  "file": "docs/docs/guides/permission-modes.md",
  "problem": "The permission-modes guide (line 276) still says read-only git subcommands and `bun test` run without asking in trust and review-auto. After this change only a plain or allow-listed `bun test` run in the project root, with an unchanged bunfig.toml that has no preload, stays routine, and never after untrusted content. The three review commands also gain path confinement that the guide does not mention.",
  "impact": "Doc drift: an operator reading the guide expects `bun test` to run without asking in every project, and in this repository (bunfig has a preload) it always asks. The repo requires docs to stay current with behaviour changes.",
  "suggested_fix": "Update the sentence at docs/docs/guides/permission-modes.md:276 and the review-command rows in docs/docs/cli-reference.md for the new `bun test` conditions and the path confinement of `review slice --out`, `retry-plan --manifest/--state` and `dispatch-check --manifest`.",
  "evidence": "Site check: line 276 of docs/docs/guides/permission-modes.md read by review-regression; the PR diff touches no file under docs/.",
  "confidence": "medium"
 },
 {
  "id": "F-020",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-020",
  "reviewer": "review-logic",
  "severity": "info",
  "file": "src/lib/review-path-flags.ts",
  "problem": "The confined-flag lookup is a plain-object read with a prototype-chain key and three sites use two guards: isRoutineKeryx checks Object.hasOwn, while reviewPathFlagsStayInside and reviewPathFlagRefusal use `REVIEW_CONFINED_PATH_FLAGS[x] ?? []`, which throws on `constructor`, `__proto__`, `toString` and `hasOwnProperty`.",
  "impact": "No live path today: both runtime callers pass fixed subcommand names and the table call is hasOwn-guarded. A future caller that passes a user-typed subcommand gets a TypeError instead of 'no confined flags'.",
  "suggested_fix": "Give the owner one accessor, `confinedPathFlags(command)` using Object.hasOwn (or a Map), and use it at all three sites.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-logic/place-probe.ts prints 'constructor throws'; /tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-clean-code/probe1.ts shows the same TypeError for the four keys.",
  "confidence": "high",
  "quote": "REVIEW_CONFINED_PATH_FLAGS[command] ?? []"
 },
 {
  "id": "F-021",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-021",
  "reviewer": "review-architecture",
  "severity": "info",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "The table computes projectRoot once from the initial cwd while the command recomputes it from process.cwd() after a `cd`, so the two roots differ when the chain `cd`s into a nested repository (a .git inside the project). The table also now does file-system I/O at classification time (bunfig read, realpath, lstat), and the verdict is a snapshot taken before any segment of the chain runs.",
  "impact": "Only fail-safe: for `cd sub && keryx review slice --out ../x` the table says routine, the real command run from sub refuses at run time. The header claim that the layers cannot drift is not literally true for the root; the runtime refusal is the authority. The check-then-use window is cheap and fail-closed.",
  "suggested_fix": "Recompute walk.projectRoot after a `cd` (resolveProjectRoot(walk.cwd)) so both layers agree, or say in the header that the command's own refusal is authoritative and the table may be more permissive. If more file-state conditions arrive, split a pure classifyShape from a bindToWorkspace step.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-architecture/probe.ts: 'cd sub && keryx review slice --out ../x' true with proj/.git and proj/sub/.git; the real command from proj/sub refuses with 'Paths must stay inside .../proj/sub'.",
  "confidence": "high"
 },
 {
  "id": "F-022",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-022",
  "reviewer": "review-style",
  "severity": "info",
  "file": "src/commands/agent.ts",
  "problem": "Naming, placement and citation conventions: the agent.ts comment cites a finding id (`Flow 441 (F-007)`) where neighbouring comments cite a flow plus an acceptance criterion; the new library code cites no flow; trust-routine-command.test.ts keeps the 'Flow 426 AC1/AC2' header while the new tests are named AC5-AC10 of flow 441, so two numbering spaces share one file. Predicates bunTestArgsAllowed, reviewPathFlagsStayInside lack the is/has prefix and isCount tests a non-negative integer; the placement of placePathWithinSync splits resolveContainedPath from its documented twin; refusal text differs in form from sibling user errors in review-slice.ts and names only the project root although `.metaproject/` is allowed too; `Walk` and `movedTo` name usage rather than content; `real` and `out` are vague test names.",
  "impact": "Readability only; the next reader cannot map the code to AC6/AC7 by grep.",
  "suggested_fix": "Cite 'Flow 441 AC6' at the sites, add 'Flow 441' to the test header or prefix the new test names, rename the predicates (hasOnlyAllowedBunTestArgs, areReviewPathFlagsInside, isNonNegativeInteger), and move placePathWithinSync below resolveContainedPathSync.",
  "evidence": "review-style F-005..F-009 and review-clean-code CC-7: code sites listed in rv1000/style.handback.txt and clean.handback.txt.",
  "confidence": "medium"
 },
 {
  "id": "F-023",
  "global_id": "2026-10-13-pr-1000-round1-c8262aa8#F-023",
  "reviewer": "review-performance",
  "severity": "info",
  "file": "src/lib/trust-routine-command.ts",
  "problem": "resolveProjectRoot (an existsSync walk up to the first .git or .metaproject) runs eagerly for every command that passes the early floors, including ones that never need the project root.",
  "impact": "Measured +7 to +9 us per call for those commands, up to about 0.25 ms for the slowest realistic case; evaluated at most twice per shell call before a /bin/sh fork. Immaterial.",
  "suggested_fix": "Optional: compute projectRoot lazily inside Walk so only `bun test` and review path-flag segments pay.",
  "evidence": "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/review-performance/bench.ts, 10000 iterations after 500 warm-up, bun 1.4.2: 'ls -la' 15.5 us old vs 22.2 us new; 'bun test' 17.8 vs 83.7; 'retry-plan --manifest --state' 95.2 vs 243.2. The preload regex is linear (8 MB inputs in 21-64 ms).",
  "confidence": "high",
  "quote": "const walk: Walk = { projectRoot: resolveProjectRoot(cwd), cwd, untrusted: context.untrustedContent === true };"
 }
]
```
