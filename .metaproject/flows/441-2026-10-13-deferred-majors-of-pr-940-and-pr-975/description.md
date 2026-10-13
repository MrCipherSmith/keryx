# Deferred majors of PR 940 and PR 975

Status: registered, criteria not frozen (the operator freezes)
Source: user description (origin: human-request); PRD and criteria first drafted in PR 991 (docs/requirements/keryx-deferred-majors-940-975/)

## Outcome criteria

- Запрос (дословно): «Долги и 2 фло, последнее про использование metaproject в ревью.» (source: helyx channel message 200493, 2026-10-12; polls 135, 137, 138, 142, 145)
- Эффект (формализация агента): the five majors deferred from the review rounds of PR 940 and PR 975 (F-001, F-007, F-008, D-01, D-02) are each closed by a test that is red before and green after, and the routine-command table and the review-result parser cannot silently widen again.
- Как наблюдать (предложение агента): the named tests fail on origin/main at 249bc59b and pass on the merge; `keryx review slice --out /tmp/x` exits non-zero; the replay report of the closed rounds' raw files is checked in; the release note lists the five IDs.

## Problem

Five major defects were found and deliberately deferred. Each one is small and local, and none is covered by a test that fails today.

| ID | Where | Defect | Open on main |
|---|---|---|---|
| F-001 | `src/tui/tui-shell.ts` | A queued slash line that starts no turn stalls the rest of the queue | yes |
| F-007 | `src/lib/trust-routine-command.ts` | `bun test` with any arguments is a routine command, so it runs without a prompt | yes |
| F-008 | `src/commands/review-slice.ts`, `src/lib/trust-routine-command.ts` | Three routine review commands write to a path taken verbatim from a flag | yes |
| D-01 | `src/review/ledger.ts` | `parseReviewResult` can return a nested or a later object instead of the reviewer's result | yes |
| D-02 | flow 427 acceptance criteria | Two criteria name a verify command whose test file does not exist | yes |

## Goal

Each defect is closed by a test that is red before and green after the change, and the routine-command table and the result parser cannot silently widen again.

## Non-goals

- The minor and info findings of the two rounds (F-002 to F-006, F-009 to F-015 of PR 940; the rest of the 975 list). Only the five majors and the three findings that share D-01's function.
- Redesign of the trust routine table, or of the queue. Each fix is local.
- Any change to the review depth or metaproject-in-review work (`docs/requirements/keryx-review-depth-parity/`, `docs/requirements/keryx-review-metaproject/`).

## Users

- The operator, who queues several lines in the shell and expects each to run.
- The operator in `trust` and `review-auto` mode, who relies on "routine" meaning "cannot run repository code or write outside the project".
- `review complete` and the ledger, which trust the parsed reviewer result to decide coverage.

## Requirements

### R1 - A queued line that starts no turn does not stall the queue (F-001)

**Current behaviour.** When a turn settles, three sites take the next queued line with `forceHandoff.takeNext() ?? mainQueue.shift()` and hand it to `remoteQueue.runQueued(next)`: `src/tui/tui-shell.ts:9618` (turn complete), `:9927` (with `busWakeController?.onSettle()` in the else branch) and `:10023` (`leaseHoldController.onRelease`). `runQueued` (`src/tui/remote-queue-wiring.ts:158`) only calls `runLine`. In `runLine`, a slash command that starts no turn returns without draining: `/compact` returns at `src/tui/tui-shell.ts:8786-8808`, and `/model`, `/goal`, `/connect` behave the same way. The line after it stays in `mainQueue` until the operator types something. A queue of `['/compact', 'question']` therefore never dispatches `question`.

**Desired behaviour.** One helper, `drainNext`, owns "take the next queued line and run it, and keep going while the line run started no turn". The three sites call it. A line that starts a turn stops the drain (the turn's own settle continues it); a line that starts none (a slash command handled inline) drains the next one. The drain is bounded by the queue length, so it cannot loop.

**Risks.** The three sites differ today in what they do around the drain (`onSettle()` in the else branch, the lease-release site). The helper must keep those differences; a regression test per site is part of the AC. A line that starts a turn asynchronously must not be mistaken for one that starts none: the helper decides by the busy state after `runLine` returns, the same state `runLine` itself uses.

### R2 - `bun test` is not a routine command when it can run repository code (F-007)

**Current behaviour.** `isRoutineSegment` returns `words[1] === "test"` for any `bun test ...` (`src/lib/trust-routine-command.ts:129-130`). That accepts `bun test --preload ./x.ts`, `bun test` in a directory whose `bunfig.toml` has a `preload`, `keryx ctx run -- bun test ...` (`isRoutineKeryx` hands the tail to `isRoutineSegment`, `:112-117`), and `cd <dir> && bun test` for any `<dir>` (`case "cd"` accepts any single argument, `:125-126`). `bun test` loads and runs repository code, so after untrusted content entered the turn it is a way to run that content without a prompt.

**Desired behaviour.** A decision for the operator, with a recommended default (see Decision 1): `bun test` is routine only with no arguments after it, in the project root, with an unchanged `bunfig.toml` (and no `preload` in it); with any argument, with a `cd` to a directory other than the project root, or after untrusted content entered the turn, it asks. The same applies inside `keryx ctx run --`.

**Risks.** Routine `bun test` is what makes review-auto runs unattended; narrowing it adds prompts. The no-argument form keeps the common case. The "unchanged bunfig" check needs a stable reference (a hash recorded at session start), which is a new piece of state.

### R3 - Routine review commands cannot write outside the project (F-008)

**Current behaviour.** `review slice`, `review dispatch-check` and `review retry-plan` are rows of `TRUST_ROUTINE_KEYRYX` (`src/lib/trust-routine-command.ts:60-78`). `review slice --out <dir>` resolves the directory with `path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR)` (`src/commands/review-slice.ts:122`) and writes `slice-NN.diff` and the manifest into it through `writeFileAtomic` (`:107`, `:137`). `retry-plan --state <file>` moves the retry state file the same way, and `--manifest` names the file read and rewritten. Nothing confines these paths, yet the commands run without a prompt.

**Desired behaviour.** A path flag of these three commands must resolve inside the project root or inside `.metaproject/`. Either the command itself refuses an outside path with a named reason, or the routine table treats the command as non-routine when a path flag is present (see Decision 2). The refusal is in the command, so it holds for a direct call as well as for a model-issued one.

**Risks.** Existing review flows pass `--out` under `.metaproject/reviews/...`; the allowed set must include them. Symlinks: the check compares the real path of the nearest existing ancestor, not the string.

### R4 - `parseReviewResult` returns the reviewer's result, not a fragment (D-01, D-03, D-05, D-10)

**Current behaviour.** `src/review/ledger.ts:83-117`. With no fenced `REVIEW_RESULT` block, the bare-JSON branch scans every `{` (`:93-94`), balances braces, and keeps the last object that has a string `status` (`:109`). Consequences: (a) a truncated reply `{"status":"DONE","slices":[{"status":"DONE", ...` fails to parse as the outer object, the scan resumes at the next `{` and returns a nested `slices[]` entry as the result; (b) a trailing `{"status":"DONE"}` after a `{"status":"BLOCKED", ...}` overrides it, because the last one wins; (c) an object with a string `status` and nothing else (no `reviewer`, no `findings` array) is accepted. D-03, D-05 and D-10 are further cases in the same function and are closed with it.

**Desired behaviour.** After a failed outer candidate the scan resumes after that candidate's end, not at its next `{`. Only a top-level object that carries `reviewer` or a `findings` array is accepted. When a `REVIEW_RESULT` marker is present, the object after it is preferred. Two distinct status objects in one reply are ambiguous and give no result (the existing "no parseable REVIEW_RESULT block" gap is raised, `src/review/ledger.ts:157`). The fenced-block branch is unchanged.

**Risks.** A stricter parser can turn a reply that parsed by luck into a gap; the replay of the closed rounds in the repository (every `raw/` file of a closed round) is part of the AC so a regression shows before release.

### R5 - Every verify command in an acceptance criterion names a test that exists (D-02)

**Current behaviour.** AC2 and AC5 of flow 427 carry `[verify: exec \`bun test ... src/commands/review-slice.test.ts\`]` (`.metaproject/flows/427-2026-10-11-review-autonomy-hardening/acceptance-criteria.md`, lines 4 and 7). `src/commands/review-slice.test.ts` does not exist on main; `src/commands/review-slice.ts` is the only `review-slice*` file under `src/`. The verify command therefore exercises nothing for the command-level behaviour the criteria promise.

**Desired behaviour.** Add `src/commands/review-slice.test.ts` covering the command-level behaviour the two criteria name: reading a result through the command, the `UnreadableInput` exit, and `scopeFingerprint` changing for same-size content. A repository check fails when a `[verify: exec ...]` command names a test file that does not exist. Where a criterion cannot be backed by a test, its verify command is corrected, with the reason, by `keryx flow ac update` on the owner's decision (the file is checksum-protected after freeze).

**Risks.** The flow 427 AC file is frozen; any edit goes through `keryx flow ac update` and needs the operator. The test file is the preferred route because it needs no AC edit.

## Decisions for the operator

1. **F-007 scope.** Recommended: no-argument `bun test` in the project root with an unchanged `bunfig.toml` stays routine; everything else asks. Alternative: `bun test` is never routine. The second is simpler and safer; the first keeps unattended review runs.
2. **F-008 place of the fix.** Recommended: confine the path in the command (works for every caller), and additionally drop the three commands from the routine table when a path flag points outside the project root. Alternative: table only.
3. **Flow shape.** Recommended: one flow with five tasks (R1 to R5), because each is small and local and they share one release. Alternative: split R1 (TUI) from R2/R3 (trust table) and R4/R5 (ledger) into three flows if they should be reviewed separately.

### Operator answers (poll 137, 2026-10-13)

Confirmed by the operator in message 201365 ("Записывай 137").

1. **F-007 scope:** "Только без флагов пути и вывода". `bun test` stays routine only when it carries no path-valued and no output-valued flag. This is wider than the recommended default (no arguments at all), so AC5 and AC6 now name an allow-list of flags that take no path or output value; every other flag, and every positional path, asks. The allow-list is fixed in T2 and shown to the operator before the criteria are frozen. The `bunfig.toml` check, the `cd` rule and the untrusted-content rule are unchanged.
2. **F-008 place of the fix:** both. The command refuses an outside path itself, and the routine table treats the three commands as non-routine when a path flag points outside the project root.
3. **Flow shape:** one flow, five criteria groups (R1 to R5), one pull request chain.

### Operator answers (poll 142, 2026-10-13)

1. **AC6 allow-list:** `--bail`, `--only`, `--todo`, `--rerun-each N`, `--timeout N` (flags without a path or output value). Closed list; everything else asks. Now written into AC6.
2. **AC13 two different `status` objects:** take the object after the `REVIEW_RESULT` marker; without a marker, no result (gap). Written into AC13.
3. **AC16 files that parsed by luck:** decided file by file together with the operator, not by tuning the parser. Written into AC16 and T4.
4. **AC19:** flow 427 AC2 and AC5 are not edited; the missing `review-slice.test.ts` is added (AC17).

## Tasks

- T1: R4 and R5 (ledger parser, review-slice tests). Ledger and tests only, no TUI.
- T2: R2 and R3 (trust table and the confinement of path flags).
- T3: R1 (queue drain helper and three-site tests).
- T4: replay of the closed review rounds' `raw/` files through the new parser; a no-op report is the pass condition, and every difference is decided file by file with the operator.


## Out of scope

No behaviour outside the five majors and the three findings that share D-01's function; no redesign of the trust table or the queue.
