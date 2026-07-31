# Implementation Plan

Status: formalized 2026-07-30

## Approach

Three changes, smallest first, each independently testable.

**1. `keryx modules --json`.** `keryx modules status` already resolves module
state for its human table; the JSON path emits the same resolved state as a
sorted, stable object rather than recomputing it. Sorting on emit keeps the
output byte-stable and diffable, matching the discipline
`src/standard/command-registry.ts` already documents for `keryx commands --json`.

**2. Extend `COMMAND_DESCRIPTORS`.** Add the agent-facing maintenance commands
the registry omits, with honest flags:

| Command | `read` | `model` | Note |
|---|---|---|---|
| `gdgraph build` | false | false | Writes graph artifacts. |
| `wiki collect` | false | false | Writes wiki pages. |
| `wiki check-links` | true | false | Pure check. |
| `test analyze` | false | false | Writes the testing context report. |
| `test status` | true | false | |
| `memory index` | false | false | Writes the memory index. |
| `ctx status` | true | false | |
| `status` | true | false | |
| `modules status` | true | false | Gains `json: true` from change 1. |

Flags are derived from what each command actually does, not from convenience.
`read: false` is the honest answer whenever a command writes into
`.metaproject/`, because the remote surface classifies write operations as `ask`.

**3. A coverage guard.** A test that enumerates the agent-facing CLI surface and
fails when a command has no descriptor. Commands deliberately excluded —
interactive (`shell`), lifecycle (`init`, `update`), or dangerous
(`harness exec`) — are listed in one explicit allowlist in the test, so an
exclusion is a visible decision rather than an omission.

The guard is the point of the flow. Gaps 1 and 2 existed because nothing
enforced coverage; adding entries without adding the guard would leave the same
hole open.

## Steps

1. Add `--json` to `keryx modules`, emitting sorted deterministic state.
2. Add the missing descriptors with accurate `read`/`model`/`json` flags.
3. Add the coverage test plus its explicit exclusion allowlist.
4. Assert `keryx commands --json` remains deterministic across two runs.
5. Run typecheck, the full suite, and `keryx health run`.

## Risks

- **Wrong `read` flag.** A command marked `read: true` that actually writes
  would let the future remote surface run it without an approval. Mitigated by
  deriving each flag from the command's own side effects and asserting the
  write-side commands carry `sideEffects` in the coverage test.
- **Coverage guard becomes noise.** If the exclusion allowlist is vague it will
  be widened casually. Mitigated by requiring a reason string per exclusion.
- **Non-determinism.** Both emit paths sort before output, and a test compares
  two consecutive runs byte-for-byte.
