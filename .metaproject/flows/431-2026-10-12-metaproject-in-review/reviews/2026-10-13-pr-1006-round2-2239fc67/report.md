# PR 1006 — review round 2

Head `2239fc67975bb71ecbf5d2a923dc0f5404d28c78`, merge base `4c230be4ddd1fb16a46092476caa0d2813ddc532`, round-1 head `b91875c22955c3ce843c929d85356df191bad79d`. Review id `2026-10-13-pr-1006-round2-2239fc67`. Mode `all`, mutation pass run, Wave C `review-verifier` run.

## Verdict

**Not ready to merge: request changes.** 40 findings, 0 blockers, 11 major, 24 minor, 5 info (0 pre-existing). Wave C deleted none. Round 1 produced 1 blocker and 14 majors. The blocker and nine of the fourteen majors are fixed; the remaining findings are residuals of five round-1 fixes (lock and publish, head handling, shell quoting, the waiver gate, the TUI refresh) plus new defects that the fixes surfaced. This is round 2 of 3: a third round is verified by mutation only.

The eleven majors:

- R2-01 `src/review/managed.ts`: completeManagedReview records the coverage waiver in research.json (line 816) before the close can fail, and restores research.json in exactly one branch: when packageRes.
- R2-02 `src/review/layers.ts`: loadPackageGraph checks layers.json (graph.status ok, graphCommit equal to the head) and then loads the graph directory without checking that it exists or matches.
- R2-03 `src/review/layers.ts`: buildPackageGraph compares `git rev-parse HEAD` of the temporary worktree (always 40 hex) with the raw prHead, and refreshLayers takes prHead unchanged from input, manife.
- R2-04 `src/review/layers-payload.ts`: The truncation loop in buildLayersBlock pops entries only from affected, symbols, relatedTests, wiki and memory.
- R2-05 `src/lib/command-risk.ts`: touchesCoverageWaiver tests the raw command string with /--waive-coverage\b/i, but the flag is decided by the shell and the CLI, not by the text.
- R2-06 `src/flow/review-gate.ts`: The PR adds coverageGateErrors to packageResearchErrors (src/review/research.ts:52).
- R2-07 `src/commands/agent.ts`: The new `keryx review layers|chunks|coverage` subcommands were added to the CLI but not to the prompt-free lists.
- R2-08 `src/review/layers.ts`: buildPackageGraph removes its worktree, staging directory and (through withFileLock) the lock only in a finally block, and nothing on the refresh path installs a SIGTERM .
- R2-09 `src/tui/review-layers-actions.ts`: runLayersRefreshInChild, the production runner behind the TUI `l` action (R1-13), is never executed by any test.
- R2-10 `src/commands/review-layers.ts`: ensurePackageLayers waits for an in-flight refresh and refuses when the wait times out, but no test covers that branch.
- R2-11 `src/review/layers.ts`: No test covers a stale refresh lock.

## Round-1 disposition (blocker and majors)

| Round-1 | Result | Note |
|---|---|---|
| R1-01 | held | Fix verified at head. |
| R1-02 | partly | Lock and two-step publish exist and `loadPackageGraph` refuses while the lock is held. Still open: a kill between the two renames leaves an ok record with no graph (R2-02); the wait path and the stale lock are unpinned (R2-10, R2-11); a SIGTERM leaks the worktree (R2-08). |
| R1-03 | held | Fix verified at head (detached temp worktree). |
| R1-04 | partly | Head order is input, manifest, checkout, but the head is stored raw: a short or symbolic head always fails the graph (R2-03). |
| R1-05 | held | Fix verified at head (comment note R2-37). |
| R1-06 | held | Fix verified at head. |
| R1-07 | held | recordChunk runs under a lock; sibling writers do not (R2-19, minor). |
| R1-08 | held | Fix verified at head. |
| R1-09 | partly | `layers block` hints quote paths, six other hint sites do not (R2-13). |
| R1-10 | partly | Waiver requires the flag and a quote and is confirmation-gated, but restore on a failed close is incomplete (R2-01) and the marker is bypassable by shell quoting (R2-05). |
| R1-11 | held | Fix verified at head. |
| R1-12 | partly | `review complete` now has tests, but none for the failure after the waiver write (R2-01). |
| R1-13 | partly | TUI refresh runs in a child with a pending guard, but the real runner is untested (R2-09) and a failed graph is shown as refreshed (R2-20). |
| R1-14 | held | Fix verified at head. |
| R1-15 | held | Fix verified at head. |

## Findings: major

- **R2-01** `src/review/managed.ts:819` (review-architecture, high, in-diff). completeManagedReview records the coverage waiver in research.json (line 816) before the close can fail, and restores research.json in exactly one branch: when packageResearchErrors reports a problem (line 819). Fix: Wrap everything between the waiver write and the manifest write in one try/catch that restores researchBefore on any throw and rethrows; better, pass the waiver into the coverage computation in memory and write it to research.json only in the same step as the manifest write.
- **R2-02** `src/review/layers.ts:467` (review-architecture, high, in-diff). loadPackageGraph checks layers.json (graph.status ok, graphCommit equal to the head) and then loads the graph directory without checking that it exists or matches. Fix: In loadPackageGraph (and in ensurePackageLayers before it returns an existing record) require that the graph directory exists, that build.json exists with commit equal to layers.graphCommit, and that nodes are non-empty when layers.graph.nodes is non-zero; throw PackageGraphError or refresh otherwise.
- **R2-03** `src/review/layers.ts:286` (review-logic, high, in-diff). buildPackageGraph compares `git rev-parse HEAD` of the temporary worktree (always 40 hex) with the raw prHead, and refreshLayers takes prHead unchanged from input, manifest target.head or the checkout. Fix: Resolve the head once at the start of refreshLayers with `git rev-parse --verify <head>^{commit}` (and the base the same way), store the full SHA in layers.prHead, and compare against that; or make resolveCreateHead write the full SHA to the manifest.
- **R2-04** `src/review/layers-payload.ts:288` (review-logic, high, in-diff). The truncation loop in buildLayersBlock pops entries only from affected, symbols, relatedTests, wiki and memory. Fix: After the lists are empty cut `files` too (record it in `truncated`) and throw only when the fixed overhead alone exceeds maxBytes.
- **R2-05** `src/lib/command-risk.ts:629` (review-security-code, high, in-diff). touchesCoverageWaiver tests the raw command string with /--waive-coverage\b/i, but the flag is decided by the shell and the CLI, not by the text. Fix: Detect the flag on parsed shell words as touchesSchedulerControl does (strip quotes and escapes; treat parameter expansion or command substitution in a flag position of `review complete` as touching), and add a second line of defence inside runComplete (a TTY requirement like `flow confirm`, or a token issued by the approval path).
- **R2-06** `src/flow/review-gate.ts:445` (review-regression, high, blast-radius). The PR adds coverageGateErrors to packageResearchErrors (src/review/research.ts:52). Fix: Apply the coverage-completeness gate only to open packages, or only to packages that carry a layers.json or chunk plan written by this version; leave closed legacy rounds readable by the review gate.
- **R2-07** `src/commands/agent.ts:5737` (review-regression, high, blast-radius). The new `keryx review layers|chunks|coverage` subcommands were added to the CLI but not to the prompt-free lists. Fix: Add layers, chunks and coverage (confined to --package, which REVIEW_CONFINED_PATH_FLAGS already enforces) to TRUST_ROUTINE_KEYRYX and to the approvesPackageCommand switch; keep --waive-coverage and the chunk-estimate answer on the human-confirmation floor.
- **R2-08** `src/review/layers.ts:305` (review-highload, high, in-diff). buildPackageGraph removes its worktree, staging directory and (through withFileLock) the lock only in a finally block, and nothing on the refresh path installs a SIGTERM or SIGINT handler. Fix: Register SIGTERM/SIGINT handlers for the duration of buildPackageGraph that run the same cleanup and re-raise; kill the TUI child's process group.
- **R2-09** `src/tui/review-layers-actions.ts:27` (review-testing-practices, high, in-diff). runLayersRefreshInChild, the production runner behind the TUI `l` action (R1-13), is never executed by any test. Fix: Export an argv builder (for example layersRefreshArgv(packageDir)) and assert it exactly, or run runLayersRefreshInChild against a stub entry script through an injectable entry path (one that prints a valid LayersFile for `refresh --package X --json`, one that exits 1 with stderr, one that prints non-JSON) and assert the resolved value and rejected messages.
- **R2-10** `src/commands/review-layers.ts:67` (review-testing-practices, high, in-diff). ensurePackageLayers waits for an in-flight refresh and refuses when the wait times out, but no test covers that branch. Fix: In review-layers.test.ts create the lock directory with a fresh heartbeat, call ensurePackageLayers with a short injected wait and assert the in-flight refusal; then release the lock and assert it proceeds.
- **R2-11** `src/review/layers.ts:439` (review-testing-practices, high, in-diff). No test covers a stale refresh lock. Fix: Create the lock directory by hand with a heartbeat older than the stale window, call refreshLayers and assert it takes the lock and publishes; a second case with a fresh lock asserts it does not; the same for layersRefreshInFlight returning false for a stale lock.

## Findings: minor

- **R2-12** `src/commands/review-layers.ts:72` (review-architecture, high, in-diff). ensurePackageLayers returns any existing layers.json whose prHead matches, including one whose graph layer is `failed` (a transient 'could not check out', a lock timeout, disk full). Fix: Reuse the existing record only when graph.status is ok (otherwise refresh); keep the previous ok graph record when a new build fails and the old directory is intact; move the freshness decision into src/review/layers.ts and the shared command helpers into one module.
- **R2-13** `src/review/coverage-complete.ts:225` (review-clean-code, high, in-diff). R1-09 says paths in command hints are shell-quoted, but only layers-payload.ts quotes (shellQuote, line 187). Fix: Move shellQuote to a small lib module (for example src/lib/shell-quote.ts) and use it at every hint site; add one test that feeds a directory with a space and asserts the hint round-trips.
- **R2-14** `src/review/layers.ts:281` (review-highload, medium, in-diff). Every refresh runs `git worktree prune` in the operator's repository, and the lock that guards it is per package while git state is per repository. Fix: Do not prune the shared repo on every refresh: remove only the worktree this run created and prune only entries under the keryx-layers- temp prefix, or prune only after a failed add; serialize worktree add/remove under a repo-level lock and retry once on a lock error.
- **R2-15** `src/review/layers.ts:283` (review-highload, high, in-diff). `git worktree add` in the operator's repository runs the operator's own post-checkout hook (and core.hooksPath hooks, fsmonitor, LFS smudge filters) on every refresh, with the temp worktree path. Fix: Pass `-c core.hooksPath=/dev/null` (and `-c core.fsmonitor=false`) on the worktree add, or export the tree with git archive / read-tree into a temp directory so no hook runs and no .git metadata is created.
- **R2-16** `src/review/chunks-estimate.ts:150` (review-security-code, medium, in-diff). `keryx review chunks estimate --answer yes --quote ...` is the second operator-quote gate in this PR (it lifts the 25-pass ceiling for chunkRunBlocker), but the command is not in touchesHumanConfirmation and answerChunkEstimate only requires a non-empty quote. Fix: Add the `--answer` form of `review chunks estimate` to the human-confirmation set (parsed, as for the waiver) or require a terminal, and say in the help that the quote is recorded, not verified.
- **R2-17** `src/review/coverage-complete.ts:198` (review-security-code, medium, in-diff). recordCoverageWaiver checks only that the quote, after the flag text is removed, is at least MIN_WAIVER_QUOTE_LENGTH (8) characters; `--waive-coverage ........` passes. Fix: Treat the quote as a record and rely on the confirmation gate for authority; store the stripped text; name the unit in the constant and the message; optionally bind the waiver to the file list and head with a digest written by the CLI and re-checked by coverageGateErrors.
- **R2-18** `src/review/coverage-complete.ts:190` (review-testing-practices, medium, in-diff). The waiver quote gate is exercised only with '', '   ', 'ok', '--waive-coverage' and 'waive coverage'. There is no boundary case (7 versus 8 characters), no padding case and no prose quote that contains the phrase 'waive coverage' next to real words. Fix: Add cases for 7 and 8 characters (reject, accept), a punctuation-only quote of 8+ characters (decide and pin the intended result) and a prose quote containing 'waive coverage'.
- **R2-19** `src/review/chunks-estimate.ts:132` (review-highload, medium, in-diff). chunk-estimate.json, chunks.json and chunk-pass.json are written by read-modify-write functions that do not take the chunk-state lock that recordChunk now holds: recordChunkEstimate and answerChunkEstimate (chunks-estimate.ts:131-154), ensureChunkPlan and mergeChunkPass (chunks.ts:125-163, 380-384) and nextChunk, which hands the same chunk to two concurrent callers (review-chunks.ts:90-96). Fix: Take the same CHUNK_STATE_LOCK in every writer, or route them through one locked helper; name the wait constant.
- **R2-20** `src/tui/review-layers-actions.ts:47` (review-logic, high, in-diff). The refresh child prints the layers JSON and exits 1 when the graph failed; runLayersRefreshInChild resolves whenever stdout is valid JSON and ignores the error, so the TUI reports 'Layers refreshed for <id>: graph: failed; ...'. The summary line also omits graph.error. Fix: Return `Layers refresh failed ...: ${graph.error}` when layers.graph.status !== 'ok'.
- **R2-21** `src/tui/reviews-inspector.ts:132` (review-highload, medium, in-diff). The TUI double-start guard is a Set created per modal instance, so it does not cover a modal reopened while its child still runs, a second TUI or a CLI refresh. Fix: After acquiring the lock re-read layers.json and return it when it matches prHead with graph ok (unless forced); hold the guard at module level keyed by package directory; kill the child on teardown; refuse when process.argv[1] is undefined.
- **R2-22** `src/review/layers-payload.ts:283` (review-performance, high, in-diff). The truncation loop pops one entry from the longest list and then re-stringifies the whole block to check its size, so the cost is O(pops x block size), quadratic in the overflow; maxBytes is 8192 while the pre-truncation block is hundreds of KB. Fix: Pre-cap each list to what can fit in maxBytes, or pop in batches proportional to the overshoot and keep the final exact check.
- **R2-23** `src/review/layers.ts:421` (review-performance, high, in-diff). refreshLayers always rebuilds the package graph (detached checkout, graph build, rename), even when the existing layers.json already has graphCommit equal to the head being refreshed. Fix: Before buildPackageGraph read the existing record and build.json; when graph.status is ok and the commit equals prHead, reuse it and skip the checkout and build, with a --force path for a deliberate rebuild.
- **R2-24** `src/commands/review.ts:787` (review-performance, medium, in-diff). runCreate calls refreshCreatedPackageLayers for attach-review, review-flow and ingest, so commands that otherwise finish in milliseconds block for a full detached checkout, graph build, wiki dry-run and memory index. Fix: Make the create-time refresh opt-in or lazy: skip it on ingest and attach and rely on ensurePackageLayers at review start and dispatch-check; or run it in the background.
- **R2-25** `src/review/layers.ts:54` (review-highload, medium, in-diff). The refresh lock wait is a fixed 120 s while the refresh it waits on scales with repository size and the TUI child is allowed 15 minutes. Fix: Derive the wait from the holder's heartbeat (wait while the lock is live, up to the child timeout) and re-check layers.json for the same head after acquiring the lock.
- **R2-26** `src/review/layers.ts:467` (review-performance, medium, in-diff). Each package keeps its own graph (48 MB measured, calls.jsonl 38.6 MB) with no retention or pruning code, and every `layers block` call loads the whole graph from disk and discards it (1.01 s wall, 398 MB RSS per call, one call per reviewer slice). Fix: Delete layers/graph for closed or old packages (a `review layers prune` or on archive); compute the blocks of all slices in one invocation, or cache the derived per-slice block next to layers.json keyed by (graphCommit, files hash).
- **R2-27** `src/review/layers.ts:415` (review-performance, medium, in-diff). The default base for the wiki freshness mark is `prHead~1`. Fix: Default the base to the manifest's target ref (merge base) when it is recorded, and fall back to `prHead~1` only when it is not; add a test with a two-commit PR.
- **R2-28** `src/review/chunks.test.ts:227` (review-testing-practices, medium, in-diff). The 'no temp file left' assertions for layers.json and chunk-pass.json read the directory after a successful write. Fix: Rename the tests to say what they check, or inject a failure (make the target a directory, or stub the rename) and assert the previous file survives intact.
- **R2-29** `src/commands/review-layers.test.ts:81` (review-testing-practices, medium, in-diff). In the `--package` confinement test the `../escape` case is satisfied by 'not a directory' (the path does not exist), so it does not prove the containment check; only `outside` and `linked-out` do. Fix: Create the escape target (a real directory one level above the project root) before the case so containment is the only reason to refuse.
- **R2-30** `src/review/chunks.ts:338` (review-testing-practices, medium, in-diff). mergeFindings has no unknown-severity case (the `?? 5` rank), no tie case and no case where the same chunk is merged twice (the `chunks.includes` dedupe); ensureChunkPlan has no legacy-plan case (a plan with no droppedKey must be kept, not replanned). Fix: Add: severity 'weird' merged against 'minor' keeps 'minor'; merging the same chunk twice lists it once; a chunks.json without droppedKey comes back unchanged with its recorded passes intact.
- **R2-31** `CHANGELOG.md:5` (review-style, high, in-diff). The 0.3.113 CHANGELOG entry says the graph is built 'in a worktree under the package', but the code creates the detached worktree in the OS temp directory (layers.ts:282, mkdtemp(tmpdir()/keryx-layers-)). Fix: Reword: 'built at the PR head in a detached worktree in the OS temp directory (removed after the build)'.
- **R2-32** `src/commands/review.ts:4204` (review-style, medium, in-diff). The top-level `keryx review --help` synopsis for dispatch-check lists --payload, --manifest, --max-bytes and --json but not --package, which the command accepts (DISPATCH_CHECK_FLAGS, runDispatchCheck calls ensurePackageLayers) and `dispatch-check --help` lists. Fix: Add [--package <dir>] to the dispatch-check synopsis at review.ts:4203-4204.
- **R2-33** `src/review/chunks-estimate.ts:38` (review-clean-code, medium, in-diff). readChunkLimits is a private reader of routing.config.json with its own JSON.parse, defaults and bare catch; it does not use the shared loader in harness/routing/config.ts that carries the trust gate for that file. Fix: Read the reviewChunks block through the shared loader (or its trusted accessor), report a malformed file, and state the clamp (or reject floor(value) < 1) in the comment.
- **R2-34** `src/review/chunks.ts:123` (review-clean-code, high, in-diff). The ensureChunkPlan doc comment says an existing plan is kept, but when the stored droppedKey differs from the current dropped set and no outcome is recorded the code re-cuts and overwrites chunks.json (132-161); it refuses only when outcomes exist. Fix: Reword to 'a plan whose dropped set still matches is kept; a plan cut from a different dropped set is replaced while no pass is recorded and refused once one is'; add a test for the replace branch.
- **R2-35** `src/review/layers.ts:197` (review-clean-code, medium, in-diff). manifestHead hand-rolls the 'read JSON, swallow errors, fall back' reader that R1-24 replaced with readJsonFileOr four times (readLayers uses it twelve lines below), and carries its own head rule /^[0-9a-f]{7,64}$/i while an explicit input head only goes through assertGitRevision. Fix: Use readJsonFileOr and one isCommitId helper for both values, or resolve the input with rev-parse --verify to a full sha.

## Findings: info

- **R2-36** `src/review/layers-usage.ts:73` (review-highload, medium, in-diff). readToolLog checks that the real path is a regular file and then reads the whole file into memory with no size cap (stat then read, so a regular file swapped for a FIFO between the two calls would block). Fix: Reject files over a cap from stat.size and stream the lines, or return unknown above the cap.
- **R2-37** `src/review/chunks.ts:321` (review-style, high, in-diff). The comment calls critical, high, medium and low 'aliases', but `low` ranks 3, a step between minor (2) and info (4), so it is not an alias of any contract severity. Fix: State that low sits between minor and info, or map it to 2 or 4 if an alias is intended.
- **R2-38** `src/review/chunks.ts:276` (review-clean-code, high, in-diff). recordChunk and recordChunkLocked repeat the same inline return type, the lock wait is a bare `30_000` (layers.ts uses named constants), and recordChunkLocked (about 42 lines) mixes reading state, planning the retry and deciding the split. Fix: Name the type once (ChunkRecordResult) and the constant, and split the pure decision from the locked I/O.
- **R2-39** `src/commands/review-chunks.ts:90` (review-clean-code, high, in-diff). ensureEstimateRecorded takes a `modeFlag` that its only caller (`chunks next`, line 146) never passes, and `chunks next` computes the estimate twice (chunkRunBlocker, then ensureEstimateRecorded). Fix: Drop the parameter or pass `--mode`; compute the estimate once; drop `export` where only the defining file uses the name.
- **R2-40** `src/trigger/unattended.ts:55` (review-architecture, medium, blast-radius). --waive-coverage is a human-confirmation command in command-risk.ts, but the unattended floor keeps its own regex list (FORBIDDEN_FLOW_VERBS), which does not name it. Fix: Add the waiver marker to the unattended forbidden verbs, or derive both lists from one shared constant.

(Full problem, impact, fix, evidence and class_scope text for every finding is in the keryx:findings block below.)

## Questions

- Q1. `ensurePackageLayers` treats a `failed` graph at the same head as final (R2-12). Is a transient failure meant to be sticky until a manual `layers refresh`, or should the next review start retry? The answer decides the fix for R2-12 and the sticky half of R2-03.
- Q2. Should `keryx review chunks estimate --answer` be a human-confirmation command like `--waive-coverage` (R2-16)? The cost question is operator-owned in the PRD wording, but the code gates only the waiver.
- Q3. Is the coverage-completeness gate meant to apply to closed legacy rounds (R2-06)? The PR text says nothing; the fix depends on the answer.

## Pre-existing

None filed. Noted and not filed: FLOW_CONFIRM_MARKER in `command-risk.ts` has the same text-match weakness as R2-05 and predates this PR. It does not block.

## Verified clean

- AC1 (no model call on refresh) and memory indexing outside the working copy: R1-01 and R1-11 held at head.
- Path confinement of `--package` for layers, chunks and coverage: `outside` and `linked-out` are refused; `..` is covered only by the existence check (R2-29, minor).
- A normal refresh leaves nothing behind in the temp directory or the repository (performance reviewer, measured); the leak is on signals only (R2-08).
- Chunk plan keys, `droppedKey` handling and the retry/split decision are logically correct for the covered inputs (logic reviewer); the gaps are tests (R2-30).
- Security: the temporary worktree runs the operator's own hooks, not the PR's (R2-15); no secret or injection path found beyond R2-05 and R2-16.
- Docs and README match the flags except R2-31 and R2-32.

## Mutation pass

25 mutants were run through `keryx review mutate` against the focused suite (baseline green). Killed 13: a02, a03, a05, a06, a07, a08, a09, a10, a11, a12, a14, a15, a16. Survived 12: m-1, m-2, m-3, m-4, m-5, m-6, m-7, m-8, m-9, a01, a04, a13. Cited as forcing evidence on majors: m-2 (R2-09), m-3 (R2-10), m-8 and m-9 (R2-11). The other survivors are named in the evidence of the minors R2-14, R2-18, R2-28, R2-30 and show as "survived in the mutation pass". a04 (the ENOENT rethrow in `layers.ts`) and a13 (the TUI execFile timeout dropped) survived and are not filed separately: both sit on lines already covered by R2-09 and R2-08.

Record location: `/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/t6pkg-r2/mut/research-evidence/` (`mutants.json`, `mutation-1.json`, `mutation-1.md`). It is not yet inside the package, which the parent creates. To record it in the real package, either copy `mut/research-evidence/*` into `<package>/research-evidence/`, or re-run in the real package dir:

`keryx review mutate --test "bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts" --package <package-dir> --spec <package-dir>/research-evidence/mutants.json --json`

## Wave C

`review-verifier` ran or read a check for every major and for R2-12, R2-13, R2-16, R2-20, R2-27, R2-31, R2-32, R2-34, R2-37, R2-39, R2-19. It deleted nothing. Executed and reproduced: R2-01, R2-02 (missing-graph half; the crash-window script was not re-run), R2-03, R2-04, R2-05, R2-06, R2-07, R2-08. It found two variants listed under R2-05 (`$F`, `$(echo ...)`) to be caught because the literal text is present; R2-05 was corrected before this report. Not re-checked by Wave C and left as reported: the timing and memory figures of R2-22 to R2-26, the contention claim in R2-14, and R2-15, R2-17, R2-18, R2-21, R2-28 to R2-30, R2-33, R2-35, R2-36, R2-38, R2-40.

## Metadata

- Orchestrator: `vantage-review`
- Generic engine: `review-orchestrator`
- Keryx projection path: `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`
- Reviewers dispatched: review-architecture, review-clean-code, review-highload, review-logic, review-performance, review-regression (scope B), review-security-code, review-style, review-testing-practices, review-verifier (Wave C).
- Vantage overlays: none selected. The retained scope-A paths are in the Keryx repository (src/review, src/commands, src/tui, src/lib, src/gdskills, docs); none match the Vantage frontend paths, so all nine overlays were skipped as path-gated. No Vantage flag was passed.
- Project-local reviewer packages: applied as recorded in the parent's reviewers.json and reviewer-brief.md for this round; this facade did not change that selection.
- Vantage rule files read: none (no overlay selected). The Keryx rule set was applied through the round brief.
- Scope A: code.diff and code-delta.diff; scope B: blast-radius.json (40-file cap).
- Routing audit: graph_used no (not-relevant: blast radius came precomputed in the brief); wiki_used no (not-relevant); ctx_used yes (`keryx ctx rg`, `keryx ctx` routed searches by the reviewers and Wave C); raw_rg_used no. Raw `head`, `tail` and `python` were used for scratch work only, with the hook marker where required.

## keryx:findings

```json keryx:findings
[
 {
  "id": "R2-01",
  "reviewer": "review-architecture",
  "severity": "major",
  "problem": "completeManagedReview records the coverage waiver in research.json (line 816) before the close can fail, and restores research.json in exactly one branch: when packageResearchErrors reports a problem (line 819). recordDispositions (824), the manifest validation throw (831-834), the manifest write (835) and writeReviewNotes (848) can still throw afterwards, and then the waiver stays recorded while the manifest stays open. The comment at 812-813 promises that a close that then fails takes the waiver back. R1-10 is therefore only partly fixed.",
  "impact": "Failing input: `keryx review complete --waive-coverage \"<8+ chars>\" --finding F-999 --disposition dismissed-incorrect --evidence x` throws at recordDispositions with the waiver already on disk. A following plain `keryx review complete` (no flag, no new operator quote) passes coverageGateErrors on the stale waiver and closes the review with uncovered in-scope files. That is the bypass R1-10 existed to close. Reproduced by the architecture reviewer with a scratch copy of managed.test.ts; the logic, clean-code, high-load, security and testing reviewers reached the same site independently.",
  "suggested_fix": "Wrap everything between the waiver write and the manifest write in one try/catch that restores researchBefore on any throw and rethrows; better, pass the waiver into the coverage computation in memory and write it to research.json only in the same step as the manifest write. Add one test per throw site (unknown finding id, invalid manifest, write failure) asserting research.json is byte-identical afterwards and that a second plain close still refuses with the coverage message.",
  "evidence": "Reproduced: scratch copy of managed.test.ts (close with waiveCoverage and an invalid disposition throws, research.json keeps dispatch.coverageWaiver, a second close without the flag succeeds). Read managed.ts 799-857: the restore at 819 is inside the researchProblems branch only. The existing test at managed.test.ts:1707-1757 covers only the packageResearchErrors failure. recordCoverageWaiver has a single caller.",
  "confidence": "high",
  "file": "src/review/managed.ts",
  "line": 819,
  "quote": "if (coverageWaiver !== undefined && researchBefore !== undefined) await writeFileAtomic(researchPath, researchBefore);",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/managed.ts:816",
    "src/review/managed.ts:819",
    "src/review/managed.ts:824",
    "src/review/managed.ts:831-834",
    "src/review/managed.ts:835",
    "src/review/managed.ts:848",
    "src/review/coverage-complete.ts:196"
   ],
   "enumeration_method": "keryx ctx rg for recordCoverageWaiver / coverageWaiver / waiveCoverage across src (one writer, called only from completeManagedReview), then a statement-by-statement walk of completeManagedReview from the waiver write (816) to the end of the function, listing every await or throw not covered by the single restore at 819; code after the manifest write cannot leave an open manifest, so it is out of the class."
  }
 },
 {
  "id": "R2-02",
  "reviewer": "review-architecture",
  "severity": "major",
  "problem": "loadPackageGraph checks layers.json (graph.status ok, graphCommit equal to the head) and then loads the graph directory without checking that it exists or matches. publishDirectory moves the live graph aside and moves the staged one in with two separate renames (246, 252), so a kill between them leaves no graph directory while the previous layers.json still says ok at the same head. loadGraph turns a missing jsonl file into an empty array, build.json is written (294) and never read, and ensurePackageLayers returns the stale ok record because existing.prHead === head, so nothing rebuilds. The header comment at layers.ts:16-18 promises that a reader refuses a graph whose recorded commit differs; nothing reads the recorded commit.",
  "impact": "Reviewer layers blocks are built from an empty graph that reports ok: buildLayersBlock (layers-payload.ts:228) tells reviewers that no code depends on the changed files, as fact, and the error is persistent (every later review of the same head) and silent. Reproduced twice: layers.json with graph ok / 900 nodes and no graph directory gives ensurePackageLayers status ok nodes 900 and loadPackageGraph nodes 0; a crash-window experiment gave 2 nodes and 1 edge before, 0 and 0 after, no error. Only the blast-radius path (review.ts:3524) refuses an empty graph.",
  "suggested_fix": "In loadPackageGraph (and in ensurePackageLayers before it returns an existing record) require that the graph directory exists, that build.json exists with commit equal to layers.graphCommit, and that nodes are non-empty when layers.graph.nodes is non-zero; throw PackageGraphError or refresh otherwise. Recover on lock acquisition: if finalDir is missing and a `.old.*` sibling exists, rename it back before building. Alternatively publish with a single atomic switch (a pointer file written with writeFileAtomic) instead of two directory renames. Add a layers.test.ts case with layers.json ok and the graph directory removed.",
  "evidence": "Experiments: architecture scratch-missing-graph.ts and high-load crashwindow.ts (both under the scratchpad) showed the output above. `keryx ctx rg GRAPH_BUILD_FILE src`: one definition (layers.ts:49) and one write (294), zero readers. No test in src/review covers a publish interrupted between the renames or a load with the graph directory missing.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 467,
  "quote": "return { graph: await loadGraph(packageDir, dataDir), dataDir, layers };",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/layers.ts:246",
    "src/review/layers.ts:252",
    "src/review/layers.ts:294",
    "src/review/layers.ts:467",
    "src/review/layers-payload.ts:228",
    "src/commands/review-layers.ts:72",
    "src/commands/review.ts:785",
    "src/commands/review.ts:3524",
    "src/commands/review-slice.ts:251"
   ],
   "enumeration_method": "keryx ctx rg for `loadPackageGraph(` and `loadGraph(` (consumers of a possibly missing graph directory: layers-payload.ts:228 unguarded, review.ts:3524 guarded by an empty-graph refusal), for `ensurePackageLayers` and `refreshCreatedPackageLayers` (consumers of the stale ok record), for `GRAPH_BUILD_FILE|build.json` (one writer, no reader) and for `rename(` in src/review/layers.ts (the two publish renames)."
  }
 },
 {
  "id": "R2-03",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "buildPackageGraph compares `git rev-parse HEAD` of the temporary worktree (always 40 hex) with the raw prHead, and refreshLayers takes prHead unchanged from input, manifest target.head or the checkout. `review create --head <7-39 hex>` is accepted (review.ts:1065) and written to the manifest, and `layers refresh --head main` / `HEAD~0` pass assertGitRevision, so the equality fails for every abbreviated or symbolic head.",
  "impact": "graph.status becomes failed with 'graph would be built at <40-hex>, not the PR head <short>' on every refresh; loadPackageGraph, the layers block, the blast-radius layer and chunks then refuse for the whole package. layers.json keeps the short prHead, so ensurePackageLayers returns the same failed record for the same head without retrying. Reproduced: refreshLayers({prHead: secondCommit.slice(0,8)}) gave graph failed. The existing tests pass only full SHAs.",
  "suggested_fix": "Resolve the head once at the start of refreshLayers with `git rev-parse --verify <head>^{commit}` (and the base the same way), store the full SHA in layers.prHead, and compare against that; or make resolveCreateHead write the full SHA to the manifest. Add tests with an 8-character head and a branch name.",
  "evidence": "Probe probe1.test.ts 'short head' under the scratchpad, run against the worktree. Read layers.ts:400-441 (prHead stored raw) and 285-288 (strict equality); review.ts:1065 accepts /^[0-9a-f]{7,40}$/i.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 286,
  "quote": "if (builtFrom !== prHead) {",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/layers.ts:286",
    "src/review/layers.ts:406-414",
    "src/review/layers.ts:463",
    "src/commands/review.ts:1065-1070",
    "src/commands/review-layers.ts:72"
   ],
   "enumeration_method": "keryx ctx rg for prHead / prHead comparisons across src/review/layers.ts, src/commands/review-layers.ts and src/commands/review.ts; every site that stores or compares a head without canonicalising it."
  }
 },
 {
  "id": "R2-04",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "The truncation loop in buildLayersBlock pops entries only from affected, symbols, relatedTests, wiki and memory. The `files` list (up to MAX_BLOCK_FILES = 100 paths) is never shrunk, so when files plus the truncation records exceed maxBytes with every other list empty the function throws instead of returning a truncated block.",
  "impact": "`keryx review layers block --files <100 long paths>` fails for the whole call, so a large, deeply nested reviewer slice gets no layers block at all. This breaks the bounded-block contract (AC5, fixes.md R1-19). Reproduced with 100 paths of 97 characters: the block needs 10250 bytes against the 8192 default and throws. Flow package paths in this repository are routinely that long.",
  "suggested_fix": "After the lists are empty cut `files` too (record it in `truncated`) and throw only when the fixed overhead alone exceeds maxBytes. Add a test with 100 long paths and the default maxBytes.",
  "evidence": "Probe probe1.test.ts '100 files' under the scratchpad threw with the 'every list empty' message at about 10250 bytes. Read layers-payload.ts:222-292; no test uses 100 long paths.",
  "confidence": "high",
  "file": "src/review/layers-payload.ts",
  "line": 288,
  "quote": "if (victim === null) throw new Error(`The layers block needs ${sizeOf(withTruncation())} bytes with every list empty; maxBytes is ${maxBytes}.`);",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/layers-payload.ts:227",
    "src/review/layers-payload.ts:283-290"
   ],
   "enumeration_method": "Read buildLayersBlock in full and listed every list that enters the byte count (files, the truncated record and the five sections); `keryx ctx rg maxBytes|sizeOf` in layers-payload.ts shows no other consumer of the cap."
  }
 },
 {
  "id": "R2-05",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "touchesCoverageWaiver tests the raw command string with /--waive-coverage\\b/i, but the flag is decided by the shell and the CLI, not by the text. A probe of touchesHumanConfirmation returned false for --waive-\"\"coverage, --waive-cov''erage, `$'\\x2d\\x2dwaive-coverage'` and `--waive\\-coverage`; every one of those runs the CLI with the flag after shell expansion (the plain, `bash -c` and variable-assignment forms that keep the literal text are caught). The sibling touchesSchedulerControl parses words and handles quoting; this marker copied the weaker text match. runComplete (review.ts:3862) has no TTY or token check behind it, unlike `flow confirm`.",
  "impact": "An agent or prompt-injected model that runs shell commands can run `keryx review complete --waive-coverage <self-written quote>` without the human ever seeing the confirmation card, in auto, trust and plan mode alike. That defeats AC10 and R1-10: the review closes with unreviewed in-scope files and research.json records an 'operator' decision that no operator made.",
  "suggested_fix": "Detect the flag on parsed shell words as touchesSchedulerControl does (strip quotes and escapes; treat parameter expansion or command substitution in a flag position of `review complete` as touching), and add a second line of defence inside runComplete (a TTY requirement like `flow confirm`, or a token issued by the approval path). Add tests for the quoting, escape, variable and substitution variants above.",
  "evidence": "Probe sec-probe.ts (scratchpad) over 12 command variants, re-run by the Wave C verifier: the literal, `bash -c`, `$F` and `$(echo ...)` forms are true (the literal text is present); the split-quote, ANSI-C-quote and backslash forms are false. Read command-risk.ts:625-638, review.ts runComplete (no confirmation check) and flow.ts `flow confirm` (checks a TTY). The older FLOW_CONFIRM_MARKER (line 390) has the same text-match weakness but is pre-existing and not filed here.",
  "confidence": "high",
  "file": "src/lib/command-risk.ts",
  "line": 629,
  "quote": "const COVERAGE_WAIVER_MARKER = /--waive-coverage\\b/i;",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/lib/command-risk.ts:629",
    "src/lib/command-risk.ts:636-637",
    "src/lib/command-risk.ts:626",
    "src/commands/review.ts:3862",
    "src/commands/review.ts:3869-3878"
   ],
   "enumeration_method": "keryx ctx rg for COVERAGE_WAIVER_MARKER|touchesCoverageWaiver|touchesHumanConfirmation across src/lib/command-risk.ts and its consumers (shell-permissions, shell-approval, agent.ts, trust-routine-command.ts, supervise-mcp.ts, acp-permission.ts); all consumers call the one function, so the marker is the single site, plus the missing in-CLI gate at runComplete."
  }
 },
 {
  "id": "R2-06",
  "reviewer": "review-regression",
  "severity": "major",
  "problem": "The PR adds coverageGateErrors to packageResearchErrors (src/review/research.ts:52). readReviewRounds in the flow review gate calls packageResearchErrors for every package of the flow, closed ones included. Any earlier round whose blast-radius.json lists cap-dropped files, with no chunk plan and no waiver, now fails, because chunk plans did not exist before this change.",
  "impact": "Such a round gets ingested=false, the `ingested-round` condition becomes unobserved ('repair or remove the package'), and a flow cannot pass the review gate over a round that was legitimately closed before the change. Probe: a copy of a closed package (flow 417, PR 939) given a blast radius with two cap-dropped files returned the 'in-scope file(s) are uncovered' error; 10 of 19 dispatch packages under the worktree's flows are blocked by the gate (all drafts, which is intended).",
  "suggested_fix": "Apply the coverage-completeness gate only to open packages, or only to packages that carry a layers.json or chunk plan written by this version; leave closed legacy rounds readable by the review gate.",
  "evidence": "Probe scripts closed.ts and legacy2.ts under r2probe/ in the scratchpad. Gate path: review-gate.ts readReviewRounds -> packageResearchErrors -> coverageGateErrors -> ingested false -> ingested-round unobserved.",
  "confidence": "high",
  "file": "src/flow/review-gate.ts",
  "line": 445,
  "quote": "problems.push(...await packageResearchErrors(packageDir, manifest?.[\"artifacts\"], rawFindings));",
  "pre_existing": false,
  "location_class": "blast-radius",
  "class_scope": {
   "sites": [
    "src/flow/review-gate.ts:445",
    "src/review/managed.ts:735",
    "src/review/managed.ts:817"
   ],
   "enumeration_method": "keryx ctx rg for every caller of packageResearchErrors in src; only review-gate.ts:445 runs over closed packages, the other two apply to open packages and are intended."
  }
 },
 {
  "id": "R2-07",
  "reviewer": "review-regression",
  "severity": "major",
  "problem": "The new `keryx review layers|chunks|coverage` subcommands were added to the CLI but not to the prompt-free lists. TRUST_ROUTINE_KEYRYX (src/lib/trust-routine-command.ts:71-98) has no rows for them, and AutomaticReviewRun.approvesPackageCommand (src/commands/automatic-review.ts:372-414) falls to `default: return false`. The coverage gate's own error text tells the reviewer to run `keryx review chunks next --package <dir>`.",
  "impact": "In trust mode these commands raise approval prompts; in an automatic review, which used to run the whole package flow without a question, they are refused, so the new coverage gate cannot be satisfied unattended. Probe on `--package <dir>`: blast-radius and complete are routine and auto-approved; layers refresh|status|block, chunks plan|next|estimate and coverage prompt and are auto-refused.",
  "suggested_fix": "Add layers, chunks and coverage (confined to --package, which REVIEW_CONFINED_PATH_FLAGS already enforces) to TRUST_ROUTINE_KEYRYX and to the approvesPackageCommand switch; keep --waive-coverage and the chunk-estimate answer on the human-confirmation floor.",
  "evidence": "Probe r2probe/routine.ts (scratchpad) ran isTrustRoutineCommand and AutomaticReviewRun.approvesShell over nine commands; `keryx ctx rg layers|chunks|coverage src/lib/trust-routine-command.ts` has no match.",
  "confidence": "high",
  "file": "src/commands/agent.ts",
  "line": 5737,
  "quote": "const isRoutine = (): boolean => (routineVerdict ??= isTrustRoutineCommand(command, routineContext));",
  "pre_existing": false,
  "location_class": "blast-radius",
  "class_scope": {
   "sites": [
    "src/lib/trust-routine-command.ts:71-98",
    "src/commands/automatic-review.ts:372-414",
    "src/commands/agent.ts:5737",
    "src/commands/agent.ts:5787"
   ],
   "enumeration_method": "Every consumer of the two prompt-free lists: isTrustRoutineCommand (agent.ts routine verdict) and AutomaticReviewRun.approvesShell (agent.ts reviewScoped branch); the probe ran each new subcommand and subverb against both."
  }
 },
 {
  "id": "R2-08",
  "reviewer": "review-highload",
  "severity": "major",
  "problem": "buildPackageGraph removes its worktree, staging directory and (through withFileLock) the lock only in a finally block, and nothing on the refresh path installs a SIGTERM or SIGINT handler. A catchable signal ends the process without the finally, leaving a full checkout of the PR head in os.tmpdir() (keryx-layers-*), a `.git/worktrees/<name>` entry in the USER's repository, the graph.<uuid> staging directory and the lock directory. `git worktree prune` at the next refresh does not remove the entry because the worktree directory still exists. This is distinct from the skipped SIGKILL half of R1-16, which covered the temp directory only.",
  "impact": "Reachable on normal operator paths: the TUI child runs with a 15-minute execFile timeout that SIGTERMs only the direct child (review-layers-actions.ts:28), Ctrl-C during `review attach` or `review layers refresh`, a cancelled CI job. Each occurrence leaks a repo-sized checkout plus a stale worktree registration that shows in `git worktree list` and survives every later refresh; there is no sweeper, so repeated timeouts on a large repo fill the temp partition.",
  "suggested_fix": "Register SIGTERM/SIGINT handlers for the duration of buildPackageGraph that run the same cleanup and re-raise; kill the TUI child's process group. Sweep at refresh start (under the lock): remove `keryx-layers-*` worktrees listed by `git worktree list --porcelain` that lie under os.tmpdir() and are older than the lock stale window, then prune. Alternatively create the worktree under a per-package directory so a later refresh can find its own leftovers.",
  "evidence": "Experiment sigterm.ts (scratchpad hl/): refreshLayers with a sleeping stub build, SIGTERM mid-build; the tmp worktree, the .git/worktrees entry, graph.<uuid> staging and refresh.lock all remained, and a second refresh's prune left the entry listed. `keryx ctx rg 'process.on|process.once'` with SIGTERM/SIGINT over src/review, src/commands/review-layers.ts and src/tui/review-layers-actions.ts finds no handler. The performance reviewer confirmed that a normal run leaves nothing behind.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 305,
  "quote": "await deps.git(input.projectRoot, [\"worktree\", \"remove\", \"--force\", \"--end-of-options\", worktree]);",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/layers.ts:281",
    "src/review/layers.ts:283",
    "src/review/layers.ts:302-307",
    "src/tui/review-layers-actions.ts:28"
   ],
   "enumeration_method": "keryx ctx rg for \"worktree\" in src (all worktree add/remove/prune uses are in layers.ts), for mkdtemp / tmpdir() in src/review, and for SIGTERM/SIGINT handlers across the refresh path (none); the TUI child with a timeout is the only SIGTERM source in the diff."
  }
 },
 {
  "id": "R2-09",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "problem": "runLayersRefreshInChild, the production runner behind the TUI `l` action (R1-13), is never executed by any test. Every test in review-layers-actions.test.ts and reviews-inspector.test.ts injects the runner, so the assertions prove the mock and the pending guard, not the child process. Unpinned: the entry, the subcommand words, `--package <dir>`, `--json`, the stdout JSON parse, the error fallback message and the timeout.",
  "impact": "Changing `refresh` to `status`, or dropping `--json`, leaves every test green while the TUI action silently does something else or fails to parse. The R1-13 fix is the one piece of the PR whose real wiring is unverified.",
  "suggested_fix": "Export an argv builder (for example layersRefreshArgv(packageDir)) and assert it exactly, or run runLayersRefreshInChild against a stub entry script through an injectable entry path (one that prints a valid LayersFile for `refresh --package X --json`, one that exits 1 with stderr, one that prints non-JSON) and assert the resolved value and rejected messages.",
  "evidence": "mutant:m-2 (argv `refresh` replaced by `status`) survived the full focused suite. `keryx ctx rg runLayersRefreshInChild` shows no test import.",
  "confidence": "high",
  "file": "src/tui/review-layers-actions.ts",
  "line": 27,
  "quote": "[...SAFE_BUN_SPAWN_ARGS, process.argv[1] ?? \"\", \"review\", \"layers\", \"refresh\", \"--package\", packageDir, \"--json\"],",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/tui/review-layers-actions.ts:23",
    "src/tui/review-layers-actions.ts:27",
    "src/tui/review-layers-actions.ts:28",
    "src/tui/review-layers-actions.ts:31",
    "src/tui/review-layers-actions.ts:33"
   ],
   "enumeration_method": "keryx ctx rg -n 'runLayersRefreshInChild|execFile' src/tui src/review, then checked every test under src/tui for an import of the real runner (none); the five sites are the argv, options, parse and error fallback of the one function."
  }
 },
 {
  "id": "R2-10",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "problem": "ensurePackageLayers waits for an in-flight refresh and refuses when the wait times out, but no test covers that branch. layers.test.ts pins that loadPackageGraph refuses while the lock is held and review-layers.test.ts pins the ready path, but nothing holds the lock and calls ensurePackageLayers.",
  "impact": "Removing the wait lets the orchestrator read, or start a second refresh against, a half-published graph; the reader side of the R1-02 lock, the path the orchestrator actually uses before each review, is unpinned.",
  "suggested_fix": "In review-layers.test.ts create the lock directory with a fresh heartbeat, call ensurePackageLayers with a short injected wait and assert the in-flight refusal; then release the lock and assert it proceeds.",
  "evidence": "mutant:m-3 (`if (false as boolean) {` in place of the wait guard) survived the full focused suite.",
  "confidence": "high",
  "file": "src/commands/review-layers.ts",
  "line": 67,
  "quote": "if (!(await waitForLayersRefresh(packageDir))) {",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/commands/review-layers.ts:67",
    "src/review/layers.ts:181"
   ],
   "enumeration_method": "keryx ctx rg -n 'waitForLayersRefresh|layersRefreshInFlight' src: two production sites (the wait in ensurePackageLayers and the isLockHeld wrapper); only the loadPackageGraph refusal is exercised by tests."
  }
 },
 {
  "id": "R2-11",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "problem": "No test covers a stale refresh lock. The lock passes staleMs: LOCK_STALE_MS so a crashed refresh does not block reviews forever, and layersRefreshInFlight uses the same bound through isLockHeld. Every lock test uses a live holder.",
  "impact": "If the stale bound is mis-set (never stale, or always stale) no test fails; the only recovery path of the R1-02 lock is unverified, and a dead refresh would block every later review of the package.",
  "suggested_fix": "Create the lock directory by hand with a heartbeat older than the stale window, call refreshLayers and assert it takes the lock and publishes; a second case with a fresh lock asserts it does not; the same for layersRefreshInFlight returning false for a stale lock.",
  "evidence": "mutant:m-8 (`staleMs` set to 3_600_000_000 at the withFileLock call) and mutant:m-9 (isLockHeld bound set to 0 in layersRefreshInFlight) both survived the full focused suite. No stale-lock case in src/review/layers*.test.ts.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 439,
  "quote": "{ timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS },",
  "pre_existing": false,
  "location_class": "in-diff",
  "class_scope": {
   "sites": [
    "src/review/layers.ts:53",
    "src/review/layers.ts:181",
    "src/review/layers.ts:439"
   ],
   "enumeration_method": "keryx ctx rg -n 'LOCK_STALE_MS|staleMs' src/review/layers.ts: one definition and two uses (the lock and the isLockHeld mirror)."
  }
 },
 {
  "id": "R2-12",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "ensurePackageLayers returns any existing layers.json whose prHead matches, including one whose graph layer is `failed` (a transient 'could not check out', a lock timeout, disk full). A later refresh that fails also overwrites a good layers.json with the failed record while the earlier good graph directory is still on disk. The head policy is also applied here and again in refreshLayers, in two layers, so the two can drift; review-chunks.ts imports resolvePackageDir/wantsHelp from this sibling command module, and review-slice.ts:31 and learn.ts:208 keep their own wantsHelp copies.",
  "impact": "A transient failure becomes sticky for the head: `layers block` and loadPackageGraph keep refusing with 'the package graph is failed' until someone runs `review layers refresh` by hand. No test stages a failed graph with the same head.",
  "suggested_fix": "Reuse the existing record only when graph.status is ok (otherwise refresh); keep the previous ok graph record when a new build fails and the old directory is intact; move the freshness decision into src/review/layers.ts and the shared command helpers into one module. Add a test with a failed graph and the same head.",
  "evidence": "Read review-layers.ts:63-79: the early return has no status check. Raised independently by the clean-code, high-load, architecture and testing reviewers.",
  "confidence": "high",
  "file": "src/commands/review-layers.ts",
  "line": 72,
  "quote": "if (existing !== null && (head === undefined || existing.prHead === head)) return existing;",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-13",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "R1-09 says paths in command hints are shell-quoted, but only layers-payload.ts quotes (shellQuote, line 187). Six other hint sites interpolate the package directory raw: coverage-complete.ts:225-226, layers.ts:458, commands/review-layers.ts:112, tui/review-panel.ts:156, tui/review-layers-actions.ts:60 and chunks-estimate.ts:166 (twice). shellQuote lives in layers-payload.ts, which imports layers.ts, so layers.ts cannot reuse it without a cycle.",
  "impact": "A package directory containing a space, quote or `;` gives a hint that fails or runs something else when pasted. These hints are shown to operators and to the orchestrator agent, which runs them.",
  "suggested_fix": "Move shellQuote to a small lib module (for example src/lib/shell-quote.ts) and use it at every hint site; add one test that feeds a directory with a space and asserts the hint round-trips.",
  "evidence": "`keryx ctx rg '--package ${'` outside tests lists the six files above; only layers-payload.ts:209 uses shellQuote.",
  "confidence": "high",
  "file": "src/review/coverage-complete.ts",
  "line": 225,
  "quote": "keryx review chunks next --package ${dir}",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-14",
  "reviewer": "review-highload",
  "severity": "minor",
  "problem": "Every refresh runs `git worktree prune` in the operator's repository, and the lock that guards it is per package while git state is per repository. Prune deletes the administrative entries of any registered worktree whose directory is currently missing (an unmounted disk, a moved path), not only keryx's, and it can drop another refresh's entry when two packages of one repo refresh at once. buildPackageGraph also does four jobs in one body (worktree lifecycle, commit check, build, publish).",
  "impact": "A review can silently drop the registration of the operator's own linked worktrees, and concurrent refreshes of different packages run prune/add/remove against the same .git: a 6-worker stress loop produced 'cannot lock ref HEAD', 'Directory not empty' and 'not a git repository' errors, and a failed add is recorded as a failed graph layer (see the sticky-failure finding). Rare in practice, hence minor. No test pins the prune (mutation a01, removing it, survived).",
  "suggested_fix": "Do not prune the shared repo on every refresh: remove only the worktree this run created and prune only entries under the keryx-layers- temp prefix, or prune only after a failed add; serialize worktree add/remove under a repo-level lock and retry once on a lock error. Extract withDetachedWorktree().",
  "evidence": "Experiment wtstress.sh (scratchpad hl/) for the contention; read layers.ts:260-309; security reviewer read layers.ts:275-289.",
  "confidence": "medium",
  "file": "src/review/layers.ts",
  "line": 281,
  "quote": "await deps.git(input.projectRoot, [\"worktree\", \"prune\"]);",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-15",
  "reviewer": "review-highload",
  "severity": "minor",
  "problem": "`git worktree add` in the operator's repository runs the operator's own post-checkout hook (and core.hooksPath hooks, fsmonitor, LFS smudge filters) on every refresh, with the temp worktree path. The security reviewer confirmed the hook is the operator's, not the PR's, so this gives the PR no code execution.",
  "impact": "A heavy or side-effecting post-checkout hook (dependency install, notification) fires on every review, outside the expectation that a review leaves the repository untouched. Confirmed with a marker-writing hook in a scratch repo.",
  "suggested_fix": "Pass `-c core.hooksPath=/dev/null` (and `-c core.fsmonitor=false`) on the worktree add, or export the tree with git archive / read-tree into a temp directory so no hook runs and no .git metadata is created.",
  "evidence": "Scratch repo hook wrote a marker on each `git worktree add`; layers.ts:283 passes no hook override.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 283,
  "quote": "const added = await deps.git(input.projectRoot, [\"worktree\", \"add\", \"--detach\", \"--force\", \"--end-of-options\", worktree, prHead]);",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-16",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "`keryx review chunks estimate --answer yes --quote ...` is the second operator-quote gate in this PR (it lifts the 25-pass ceiling for chunkRunBlocker), but the command is not in touchesHumanConfirmation and answerChunkEstimate only requires a non-empty quote.",
  "impact": "An agent can answer yes to its own over-ceiling cost question with an invented quote and spend the larger run without the operator. Bounded to cost and time, not integrity.",
  "suggested_fix": "Add the `--answer` form of `review chunks estimate` to the human-confirmation set (parsed, as for the waiver) or require a terminal, and say in the help that the quote is recorded, not verified.",
  "evidence": "Read chunks-estimate.ts:147-167, review-chunks.ts:125-131; `keryx ctx rg` over command-risk.ts shows no marker for this command.",
  "confidence": "medium",
  "file": "src/review/chunks-estimate.ts",
  "line": 150,
  "quote": "if (quote.trim() === \"\") throw new Error(\"The answer needs the operator's own words (--quote).\");",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-17",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "recordCoverageWaiver checks only that the quote, after the flag text is removed, is at least MIN_WAIVER_QUOTE_LENGTH (8) characters; `--waive-coverage ........` passes. It then stores `operatorQuote.trim()` (line 207), which can still contain the flag text the check treated as not the operator's words. The variable is called `words` and the message says 'a short sentence', but the unit is characters. readCoverageWaiver accepts any non-empty quote and time, and research.json is a plain file the reviewing agent can write.",
  "impact": "The waiver is a record, not proof: with the regex bypass or a direct research.json edit an agent can produce a waiver that looks operator-authored. Bounded by the same attacker model and auditable in the package.",
  "suggested_fix": "Treat the quote as a record and rely on the confirmation gate for authority; store the stripped text; name the unit in the constant and the message; optionally bind the waiver to the file list and head with a digest written by the CLI and re-checked by coverageGateErrors.",
  "evidence": "Read coverage-complete.ts:83-88, 190-210, 215-232. (The style reviewer's claim that the check counts words was refuted: it is a character count.)",
  "confidence": "medium",
  "file": "src/review/coverage-complete.ts",
  "line": 198,
  "quote": "const words = operatorQuote.replace(/-{0,2}waive[- ]?coverage/gi, \"\").trim();",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-18",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The waiver quote gate is exercised only with '', '   ', 'ok', '--waive-coverage' and 'waive coverage'. There is no boundary case (7 versus 8 characters), no padding case and no prose quote that contains the phrase 'waive coverage' next to real words.",
  "impact": "Lowering the constant from 8 to 3 passes the whole suite (the mutation m-1 survived), so the 'operator's own words' check is weaker than its comment. The flag is a human-confirmation command, which bounds the risk.",
  "suggested_fix": "Add cases for 7 and 8 characters (reject, accept), a punctuation-only quote of 8+ characters (decide and pin the intended result) and a prose quote containing 'waive coverage'.",
  "evidence": "Survived in the mutation pass: m-1 (constant 8 to 3).",
  "confidence": "medium",
  "file": "src/review/coverage-complete.ts",
  "line": 190,
  "quote": "const MIN_WAIVER_QUOTE_LENGTH = 8;",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-19",
  "reviewer": "review-highload",
  "severity": "minor",
  "problem": "chunk-estimate.json, chunks.json and chunk-pass.json are written by read-modify-write functions that do not take the chunk-state lock that recordChunk now holds: recordChunkEstimate and answerChunkEstimate (chunks-estimate.ts:131-154), ensureChunkPlan and mergeChunkPass (chunks.ts:125-163, 380-384) and nextChunk, which hands the same chunk to two concurrent callers (review-chunks.ts:90-96). The 30 s lock wait is also a bare literal shorter than a slow recordChunk on a large pass.",
  "impact": "Two concurrent chunk runs on one package can lose the operator's estimate answer, overwrite a pass snapshot with an older one or run a chunk twice. The failure mode is fail-closed (the coverage gate refuses), so bounded.",
  "suggested_fix": "Take the same CHUNK_STATE_LOCK in every writer, or route them through one locked helper; name the wait constant.",
  "evidence": "Read chunks.ts:271-318 and the listed writers; `keryx ctx rg CHUNK_STATE_LOCK` shows one use.",
  "confidence": "medium",
  "file": "src/review/chunks-estimate.ts",
  "line": 132,
  "quote": "const previous = await readChunkEstimate(packageDir);",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-20",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "The refresh child prints the layers JSON and exits 1 when the graph failed; runLayersRefreshInChild resolves whenever stdout is valid JSON and ignores the error, so the TUI reports 'Layers refreshed for <id>: graph: failed; ...'. The summary line also omits graph.error.",
  "impact": "The operator sees 'refreshed' for a refresh whose graph failed, with no reason (the short-head defect makes this likely). The 'graph: failed' text is present, so it is misleading rather than silent.",
  "suggested_fix": "Return `Layers refresh failed ...: ${graph.error}` when layers.graph.status !== 'ok'.",
  "evidence": "Read review-layers-actions.ts:29-47, review-layers.ts:104, layers-view.ts:25-28. Not run.",
  "confidence": "high",
  "file": "src/tui/review-layers-actions.ts",
  "line": 47,
  "quote": "return `Layers refreshed for ${row.reviewId}: ${layersSummaryLine(layers)}`;",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-21",
  "reviewer": "review-highload",
  "severity": "minor",
  "problem": "The TUI double-start guard is a Set created per modal instance, so it does not cover a modal reopened while its child still runs, a second TUI or a CLI refresh. The only cross-process guard is the package lock: the second child waits up to LOCK_WAIT_MS and then either rebuilds the graph again (refreshLayers does not re-check layers.json after acquiring the lock) or throws a timeout. Nothing aborts the child when the TUI exits, a timeout kills only the direct child, and runLayersRefreshInChild falls back to `process.argv[1] ?? \"\"`, which becomes a bun run with no script.",
  "impact": "A redundant full graph rebuild (minutes on a large repo) and a worktree checkout per extra start; an orphaned child continues after the TUI exits.",
  "suggested_fix": "After acquiring the lock re-read layers.json and return it when it matches prHead with graph ok (unless forced); hold the guard at module level keyed by package directory; kill the child on teardown; refuse when process.argv[1] is undefined.",
  "evidence": "reviews-inspector.ts:132; review-layers-actions.ts:27-28; layers.ts:418-440 builds unconditionally after the lock is granted.",
  "confidence": "medium",
  "file": "src/tui/reviews-inspector.ts",
  "line": 132,
  "quote": "const pendingReviews = new Set<string>();",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-22",
  "reviewer": "review-performance",
  "severity": "minor",
  "problem": "The truncation loop pops one entry from the longest list and then re-stringifies the whole block to check its size, so the cost is O(pops x block size), quadratic in the overflow; maxBytes is 8192 while the pre-truncation block is hundreds of KB.",
  "impact": "Measured on this repository (graph 3,065 nodes, 184,793 call edges): 100 hub files take 975 ms in buildLayersBlock; synthetic lists 3x larger take 2.18 s and 10x take 54.7 s (33,538 iterations). It runs once per reviewer block call, so 9-12 reviewers pay it each time. Around 1 s today, which is why it stays minor.",
  "suggested_fix": "Pre-cap each list to what can fit in maxBytes, or pop in batches proportional to the overshoot and keep the final exact check.",
  "evidence": "hub.ts (real buildLayersBlock, 100 hubs: 975 ms) and trunc.ts (emulated loop) under the scratchpad perf/; layers-payload.ts:283-290.",
  "confidence": "high",
  "file": "src/review/layers-payload.ts",
  "line": 283,
  "quote": "while (sizeOf(withTruncation()) > maxBytes) {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-23",
  "reviewer": "review-performance",
  "severity": "minor",
  "problem": "refreshLayers always rebuilds the package graph (detached checkout, graph build, rename), even when the existing layers.json already has graphCommit equal to the head being refreshed.",
  "impact": "An explicit `keryx review layers refresh` and the TUI `l` key on an unchanged head spend 14-19 s and a 157 MB checkout to produce the same 48 MB graph (measured 19.4 s and 14.3 s; graph build alone 10-13.5 s). A user who presses `l` to refresh the wiki or memory layer pays the full price.",
  "suggested_fix": "Before buildPackageGraph read the existing record and build.json; when graph.status is ok and the commit equals prHead, reuse it and skip the checkout and build, with a --force path for a deliberate rebuild.",
  "evidence": "Timing from refresh.ts on a 12,782-file clone at the PR head; layers.ts:421 calls buildPackageGraph unconditionally inside the lock.",
  "confidence": "high",
  "file": "src/review/layers.ts",
  "line": 421,
  "quote": "const graph = await buildPackageGraph(deps, input, prHead);",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-24",
  "reviewer": "review-performance",
  "severity": "minor",
  "problem": "runCreate calls refreshCreatedPackageLayers for attach-review, review-flow and ingest, so commands that otherwise finish in milliseconds block for a full detached checkout, graph build, wiki dry-run and memory index.",
  "impact": "About 14-19 s of wall time, a 157 MB temporary checkout and a 48 MB graph per created package, whether or not a review is then run. The acceptance criteria require fresh layers at review start and at dispatch (ensurePackageLayers in dispatch-check already covers dispatch). Failures are non-blocking, the time cost is not.",
  "suggested_fix": "Make the create-time refresh opt-in or lazy: skip it on ingest and attach and rely on ensurePackageLayers at review start and dispatch-check; or run it in the background.",
  "evidence": "Timing from refresh.ts; review.ts:785-795 and 844; review-slice.ts:251.",
  "confidence": "medium",
  "file": "src/commands/review.ts",
  "line": 787,
  "quote": "const layers = await ensurePackageLayers(packageDir, {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-25",
  "reviewer": "review-highload",
  "severity": "minor",
  "problem": "The refresh lock wait is a fixed 120 s while the refresh it waits on scales with repository size and the TUI child is allowed 15 minutes. A waiter that times out throws, which makes `review slice` or `layers block` fail instead of waiting; a waiter that does get the lock after the holder finished rebuilds everything.",
  "impact": "Spurious failures of slice/block while a long refresh runs, and a redundant rebuild afterwards. Today a refresh takes 14-19 s, so there is about 6x headroom; a repository 6x larger would time out.",
  "suggested_fix": "Derive the wait from the holder's heartbeat (wait while the lock is live, up to the child timeout) and re-check layers.json for the same head after acquiring the lock.",
  "evidence": "layers.ts:53-54 and 439; review-layers-actions.ts REFRESH_TIMEOUT_MS; measured refresh 14.3-19.4 s.",
  "confidence": "medium",
  "file": "src/review/layers.ts",
  "line": 54,
  "quote": "const LOCK_WAIT_MS = 120_000;",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-26",
  "reviewer": "review-performance",
  "severity": "minor",
  "problem": "Each package keeps its own graph (48 MB measured, calls.jsonl 38.6 MB) with no retention or pruning code, and every `layers block` call loads the whole graph from disk and discards it (1.01 s wall, 398 MB RSS per call, one call per reviewer slice).",
  "impact": "100 reviewed PRs is about 4.8 GB under .metaproject/reviews; with 9-12 reviewers running concurrently the block calls peak around 3.6-4.8 GB of RSS on a small machine.",
  "suggested_fix": "Delete layers/graph for closed or old packages (a `review layers prune` or on archive); compute the blocks of all slices in one invocation, or cache the derived per-slice block next to layers.json keyed by (graphCommit, files hash).",
  "evidence": "block.ts/parts.ts timings under the scratchpad perf/; bundled review-orchestrator SKILL.md runs one `layers block` per reviewer.",
  "confidence": "medium",
  "file": "src/review/layers.ts",
  "line": 467,
  "quote": "return { graph: await loadGraph(packageDir, dataDir), dataDir, layers };",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-27",
  "reviewer": "review-performance",
  "severity": "minor",
  "problem": "The default base for the wiki freshness mark is `prHead~1`. The automatic callers (ensurePackageLayers, refreshCreatedPackageLayers, the TUI refresh) pass no base, and the manifest's target ref is not used, so previewFreshness covers only the last commit of the PR, not `merge-base..prHead`.",
  "impact": "pagesStaleProse (the AC4 wiki divergence mark) undercounts pages made stale by earlier commits of the same PR; a multi-commit PR can show zero stale prose pages while its first commits changed them. The value is informational, so minor.",
  "suggested_fix": "Default the base to the manifest's target ref (merge base) when it is recorded, and fall back to `prHead~1` only when it is not; add a test with a two-commit PR.",
  "evidence": "Read layers.ts:156-157, 311-359, 415 and review-layers.ts:63-79: no caller passes `base`. Raised as a lead by the performance reviewer and verified in source.",
  "confidence": "medium",
  "file": "src/review/layers.ts",
  "line": 415,
  "quote": "const base = input.base ?? (prHead === null ? null : `${prHead}~1`);",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-28",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The 'no temp file left' assertions for layers.json and chunk-pass.json read the directory after a successful write. They pass with a plain writeFile as well as with writeFileAtomic, so they pin the absence of leftovers, not atomicity; the same shape applies to chunks.json and chunk-state.json.",
  "impact": "A regression from writeFileAtomic to a plain write (the R1-17 fix) is not detected; mutation m-4 (Bun.write for layers.json) survived.",
  "suggested_fix": "Rename the tests to say what they check, or inject a failure (make the target a directory, or stub the rename) and assert the previous file survives intact.",
  "evidence": "Survived in the mutation pass: m-4. Observationally equivalent unless a fault is injected.",
  "confidence": "medium",
  "file": "src/review/chunks.test.ts",
  "line": 227,
  "quote": "test(\"chunk-pass.json is replaced whole, with no temp file left (R1-17)\", async () => {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-29",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "In the `--package` confinement test the `../escape` case is satisfied by 'not a directory' (the path does not exist), so it does not prove the containment check; only `outside` and `linked-out` do.",
  "impact": "A regression that drops the `..` containment check would still pass that case.",
  "suggested_fix": "Create the escape target (a real directory one level above the project root) before the case so containment is the only reason to refuse.",
  "evidence": "review-layers.test.ts:81: `../escape` has no fixture directory.",
  "confidence": "medium",
  "file": "src/commands/review-layers.test.ts",
  "line": 81,
  "quote": "for (const where of [\"outside\", \"linked-out\", \"../escape\"] as const) {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-30",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "mergeFindings has no unknown-severity case (the `?? 5` rank), no tie case and no case where the same chunk is merged twice (the `chunks.includes` dedupe); ensureChunkPlan has no legacy-plan case (a plan with no droppedKey must be kept, not replanned).",
  "impact": "An unknown severity could outrank a known one, a chunk could be listed twice on a finding, and an upgrade could replan and discard recorded passes, all without a failing test; mutations m-5 (`?? -1`), m-6 (dedupe removed) and m-7 (droppedKey guard removed) all survived.",
  "suggested_fix": "Add: severity 'weird' merged against 'minor' keeps 'minor'; merging the same chunk twice lists it once; a chunks.json without droppedKey comes back unchanged with its recorded passes intact.",
  "evidence": "Survived in the mutation pass: m-5, m-6, m-7.",
  "confidence": "medium",
  "file": "src/review/chunks.ts",
  "line": 338,
  "quote": "const rank = (value: ChunkFinding): number => SEVERITY_RANK[String(value.severity ?? \"\").toLowerCase()] ?? 5;",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-31",
  "reviewer": "review-style",
  "severity": "minor",
  "problem": "The 0.3.113 CHANGELOG entry says the graph is built 'in a worktree under the package', but the code creates the detached worktree in the OS temp directory (layers.ts:282, mkdtemp(tmpdir()/keryx-layers-)).",
  "impact": "A reader looking for the worktree, or for a leftover after a kill, in the package directory will not find it; the release note hides the one place an operator would need to look.",
  "suggested_fix": "Reword: 'built at the PR head in a detached worktree in the OS temp directory (removed after the build)'.",
  "evidence": "CHANGELOG.md:5 versus layers.ts:282; the phrase appears nowhere else in README or docs.",
  "confidence": "high",
  "file": "CHANGELOG.md",
  "line": 5,
  "quote": "built at the PR head in a worktree under the package",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-32",
  "reviewer": "review-style",
  "severity": "minor",
  "problem": "The top-level `keryx review --help` synopsis for dispatch-check lists --payload, --manifest, --max-bytes and --json but not --package, which the command accepts (DISPATCH_CHECK_FLAGS, runDispatchCheck calls ensurePackageLayers) and `dispatch-check --help` lists.",
  "impact": "Two help screens for one command disagree; the docs say dispatch-check refreshes layers when given --package, but the main help gives no hint of the flag.",
  "suggested_fix": "Add [--package <dir>] to the dispatch-check synopsis at review.ts:4203-4204.",
  "evidence": "review.ts:4203-4204 versus review-slice.ts printDispatchCheckHelp and runDispatchCheck (~249-253); docs keep-the-wiki-current.md:256.",
  "confidence": "medium",
  "file": "src/commands/review.ts",
  "line": 4204,
  "quote": "[--max-bytes <n>] [--json]",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-33",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "readChunkLimits is a private reader of routing.config.json with its own JSON.parse, defaults and bare catch; it does not use the shared loader in harness/routing/config.ts that carries the trust gate for that file. Its doc comment (line 35) says any field set badly keeps its default, but maxPasses is clamped to 100 (line 42) and a fractional value below 1 floors to a ceiling of 0.",
  "impact": "The ceiling that bounds a chunk run can be raised by whatever routing.config.json sits in the reviewed checkout without the gate applied to the rest of the file, and a malformed file looks the same as no file. The comment misstates the clamp.",
  "suggested_fix": "Read the reviewChunks block through the shared loader (or its trusted accessor), report a malformed file, and state the clamp (or reject floor(value) < 1) in the comment.",
  "evidence": "chunks-estimate.ts:35-50 and harness/routing/config.ts; caller estimateChunkRun at chunks-estimate.ts:77.",
  "confidence": "medium",
  "file": "src/review/chunks-estimate.ts",
  "line": 38,
  "quote": "const parsed = JSON.parse(await readFile(path.join(projectRoot, \"routing.config.json\"), \"utf8\")) as { reviewChunks?: Record<string, unknown> };",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-34",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "The ensureChunkPlan doc comment says an existing plan is kept, but when the stored droppedKey differs from the current dropped set and no outcome is recorded the code re-cuts and overwrites chunks.json (132-161); it refuses only when outcomes exist.",
  "impact": "A reader trusts the comment; a rerun of `chunks plan` after the blast radius changed silently replaces the plan and a stale chunk-estimate.json refers to the old planKey. The refusal message points at the comment's rule, not the code's.",
  "suggested_fix": "Reword to 'a plan whose dropped set still matches is kept; a plan cut from a different dropped set is replaced while no pass is recorded and refused once one is'; add a test for the replace branch.",
  "evidence": "chunks.ts:121-163: the early return is only at line 131.",
  "confidence": "high",
  "file": "src/review/chunks.ts",
  "line": 123,
  "quote": "A plan that exists is kept: once a pass has been recorded the plan may not move under it.",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-35",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "manifestHead hand-rolls the 'read JSON, swallow errors, fall back' reader that R1-24 replaced with readJsonFileOr four times (readLayers uses it twelve lines below), and carries its own head rule /^[0-9a-f]{7,64}$/i while an explicit input head only goes through assertGitRevision. The same head has two acceptance rules.",
  "impact": "Duplicate reader of the class R1-24 removed; a branch name passed as input is accepted and stored while loadPackageGraph compares layers.graphCommit (a sha) with it and refuses. Latent mismatch, no confirmed CLI path other than the short-head defect.",
  "suggested_fix": "Use readJsonFileOr and one isCommitId helper for both values, or resolve the input with rev-parse --verify to a full sha.",
  "evidence": "layers.ts:195-208 and lib/git-revision.ts:6-9.",
  "confidence": "medium",
  "file": "src/review/layers.ts",
  "line": 197,
  "quote": "const manifest = JSON.parse(await readFile(path.join(packageDir, MANIFEST_FILE), \"utf8\")) as { target?: { head?: unknown } };",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-36",
  "reviewer": "review-highload",
  "severity": "info",
  "problem": "readToolLog checks that the real path is a regular file and then reads the whole file into memory with no size cap (stat then read, so a regular file swapped for a FIFO between the two calls would block).",
  "impact": "A multi-hundred-MB log is read in full once per reviewer. Measured on a 53 MB / 200k-line log: 44 ms read, 451 ms count; the log comes from the operator's own input directory.",
  "suggested_fix": "Reject files over a cap from stat.size and stream the lines, or return unknown above the cap.",
  "evidence": "layers-usage.ts:63-77; perf measurement; security reviewer read the same path.",
  "confidence": "medium",
  "file": "src/review/layers-usage.ts",
  "line": 73,
  "quote": "return await readFile(real, \"utf8\");",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-37",
  "reviewer": "review-style",
  "severity": "info",
  "problem": "The comment calls critical, high, medium and low 'aliases', but `low` ranks 3, a step between minor (2) and info (4), so it is not an alias of any contract severity.",
  "impact": "A maintainer reading 'aliases' will assume low maps to minor or info.",
  "suggested_fix": "State that low sits between minor and info, or map it to 2 or 4 if an alias is intended.",
  "evidence": "chunks.ts:320-321.",
  "confidence": "high",
  "file": "src/review/chunks.ts",
  "line": 321,
  "quote": "const SEVERITY_RANK: Record<string, number> = { blocker: 0, critical: 0, major: 1, high: 1, minor: 2, medium: 2, low: 3, info: 4 };",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-38",
  "reviewer": "review-clean-code",
  "severity": "info",
  "problem": "recordChunk and recordChunkLocked repeat the same inline return type, the lock wait is a bare `30_000` (layers.ts uses named constants), and recordChunkLocked (about 42 lines) mixes reading state, planning the retry and deciding the split.",
  "impact": "Readability and testability only; the retry rules cannot be tested without the lock and file I/O.",
  "suggested_fix": "Name the type once (ChunkRecordResult) and the constant, and split the pure decision from the locked I/O.",
  "evidence": "chunks.ts:271-318.",
  "confidence": "high",
  "file": "src/review/chunks.ts",
  "line": 276,
  "quote": "async function recordChunkLocked(packageDir: string, chunkId: string, result: ChunkResultInput): Promise<{ decision: RetryDecision; reason: string; state: ChunkRunState }> {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-39",
  "reviewer": "review-clean-code",
  "severity": "info",
  "problem": "ensureEstimateRecorded takes a `modeFlag` that its only caller (`chunks next`, line 146) never passes, and `chunks next` computes the estimate twice (chunkRunBlocker, then ensureEstimateRecorded). Exports with no non-test consumer widen the surface: layersRefreshInFlight, emptyChunkState, readCoverage, publishDirectory.",
  "impact": "No wrong behaviour; a parameter nobody can set, duplicate file stats per `next`, and exported names the product does not use.",
  "suggested_fix": "Drop the parameter or pass `--mode`; compute the estimate once; drop `export` where only the defining file uses the name.",
  "evidence": "`keryx ctx rg` for modeFlag (review-chunks.ts:90, 95) and for the four export names over src (no consumer outside the defining file and its tests).",
  "confidence": "high",
  "file": "src/commands/review-chunks.ts",
  "line": 90,
  "quote": "async function ensureEstimateRecorded(packageDir: string, projectRoot: string, modeFlag?: string): Promise<void> {",
  "pre_existing": false,
  "location_class": "in-diff"
 },
 {
  "id": "R2-40",
  "reviewer": "review-architecture",
  "severity": "info",
  "problem": "--waive-coverage is a human-confirmation command in command-risk.ts, but the unattended floor keeps its own regex list (FORBIDDEN_FLOW_VERBS), which does not name it.",
  "impact": "No concrete bypass: an unattended run has no approver, so the confirmation floor denies the call. The two lists can drift.",
  "suggested_fix": "Add the waiver marker to the unattended forbidden verbs, or derive both lists from one shared constant.",
  "evidence": "unattended.ts:55-78 and the sacReviewConfirmation path in agent.ts ~5726-5865; the regression reviewer agreed it is defence in depth only.",
  "confidence": "medium",
  "file": "src/trigger/unattended.ts",
  "line": 55,
  "quote": "const FORBIDDEN_FLOW_VERBS: readonly RegExp[] = [",
  "pre_existing": false,
  "location_class": "blast-radius"
 }
]
```
