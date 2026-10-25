# Implementation Plan

Status: final for freeze

## Verification of the analysis, and what changed in the plan

Re-checked against origin/main 0.3.130 (the local checkout was ~300 commits behind):

- Totals recomputed with the analyst's scripts pointed at this tree: 73 records, 1956 runs, 598 min, 985 repeat runs (313 min), 141 of 507 repeated mutants changed status. The earlier 69-record figures hold in shape.
- `--bail` is a flag of `bun test`, not of `mutate`: `--test` is a free command string. So the work is a conservative rewrite of that string, not a pass-through flag. 70 of 73 recorded commands are plain `bun test <paths>`; the other three are `sh <script>` (twice) and `env VAR=... bun test ...` (once).
- Bail semantics checked on bun 1.4.2: red run exits 1 and stops after the first failure, a green run exits 0 either way. A green run cannot stop earlier by construction, so a survivor cannot become a kill.
- The probe's 79% saving came from wide commands (52 s -> 3.7 s); on a narrow command it saved nothing (7.0 s -> 6.7 s). Its two "survivors" were red on the current code, so no true survivor was ever measured. The replay below covers that.
- R4 as written wants stage A/B counters and `reused`; those belong to R2/R3 phase 2. Only baseline, mutant time, copy time and the bail flag are in this flow.
- D4 (schema fields `head`, `treeHash`): taken as yes, because the fields are optional and additive. Decided by the agent, not ratified by the operator.

## Approach

`src/review/mutate.ts`:

1. `withBail(command)`: returns the command with `--bail` inserted after `bun test` when the whole string is `[env] [NAME=value ...] bun test <plain tokens>` (letters, digits and `_ . / : = , @ + % -` only; no quotes, `$`, backticks, `;`, `&`, `|`, redirects, globs, `\`, newline) and has no `--bail` already; otherwise returns `undefined`. A string it cannot read with certainty runs unchanged.
2. `runMutation({ bail })`, default on. The baseline runs `options.command` unchanged. Mutant rows carry the command actually run in `command`. The record gets `bail: true` only when applied.
3. Provenance on the record, all optional: `startedAt` (ISO), `head` (git commit of the reviewed worktree), `treeHash` (sha256 of `git diff HEAD --binary` plus the content of untracked, non-ignored files), `loadavg` (1/5/15 min). `head` and `treeHash` are left out when the worktree is not a git checkout or git fails.
4. Timing on the record, optional: `copyMs`, `mutantsMs` (sum of mutant run times). The table header prints them, the bail note, and the provenance line.

`src/commands/review.ts`: `--no-bail` on `mutate` (in `MUTATE_FLAGS`), passed as `bail: false`.

Docs, same change: `SKILL.detail.md` "The mutation pass" (bundled and installed copy), `docs/docs/cli-reference.md`, `CHANGELOG.md`. No version bump (batched releases).

## Steps

1. T1 context: this file and `context.md`.
2. T2 tests first (tests-creator): `withBail` table; runMutation with a real `bun test` fixture for kill, survive, timeout under bail; `--no-bail`; provenance in and outside git; old record without new fields.
3. T3 implement (task-implementer) until those pass; narrow test slice only, CI runs the full suite.
4. T4 docs.
5. T5 replay: sample of recorded mutants on this tree, `--no-bail` against default, via the real command. Evidence in `replay-bail.md` in the flow folder.
6. T6 self-review, draft PR.

## Risks

- A command shape the matcher accepts but `bun` reads differently (a flag that takes a value and swallows `--bail`). `--bail` goes right after `test`, before any other argument, so it is never a flag's value.
- Replay needs a quiet machine; load is recorded with the result, and a noisy run is repeated.
- `treeHash` over a large dirty tree costs time. It is computed once per pass and capped (more than 20000 untracked files: left out).
- State x event matrix: not applicable, no UI or held state.
