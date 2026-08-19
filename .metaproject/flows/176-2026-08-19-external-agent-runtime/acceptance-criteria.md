# Acceptance Criteria

Rules:
- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/keryx-external-agent-runtime/specification.md` §10
(AC1–AC15), plus AC16–AC17 covering prerequisites the specification assumes.
Every criterion is verifiable offline on a machine with neither CLI installed,
except AC16 which is the act of recording the fixtures the others run against.

## Criteria

- AC1: A dispatch with `runtime.kind = "external"` and `agent = "codex-cli"` validates against the extended `subagent-dispatch` schema; one naming an unknown `agent` is rejected; and a `sandbox` absent from an entry's `sandboxModes` is rejected with an agent-cannot-do-that reason, exercised against a synthetic registry entry. Pure, offline.
- AC2: `sandbox: "read-only"` combined with `allowed_actions` containing `write`, `network`, or `spawn-subagent` is rejected with a named reason; `run-command` alone does not trigger rejection. Pure, offline.
- AC3: `sandbox: "worktree-write"` against a shipped registry entry passes both the schema and the `sandboxModes` check, then is refused by the runtime with a keryx-does-not-yet reason distinguishable from AC1's.
- AC4: Each codec's `buildArgv` output is asserted element by element, including that no prompt element directly follows a variadic flag. No CLI required.
- AC5: Each codec parses its recorded fixtures into the canonical event sequence, and `reduceAgents` folds that sequence without modification to the fold.
- AC6: `classifyFailure` returns the correct cause for each recorded failure fixture, covering at minimum: not-logged-in with exit code 0, usage limit, argv rejected by the CLI version, empty output, and a successful exploration whose output contains the word `error`.
- AC7: The environment builder removes every named denied variable and every prefix-swept variable from a synthetic parent environment, and adds the depth marker. Pure, offline.
- AC8: A run driven by a fixture transcript containing write attempts leaves the repository working tree byte-identical, and the worktree is removed on every terminal path including thrown errors and killed processes.
- AC9: With the capability disabled, or under a remote transport, or with CI detected, every external spawn entry point returns a named refusal and creates no process.
- AC10: An operator message emits a `user_message` canonical event and, for a `streamingInput: true` agent, is written to the child's stdin; for a `streamingInput: false` agent it is delivered through the resume argv.
- AC11: `force` produces the resume argv carrying the keryx-assigned session id and the operator's message.
- AC12: Supervision triggers fire from the fold, not from raw events: a fixture transcript of N events produces at most one parent update per trigger condition.
- AC13: A structured result that fails `subagent-result` validation yields `SubagentCompletionStatus: "Error"`, never a silent downgrade to free text.
- AC14: No failure path substitutes another runtime, another agent, or the parent's own model, asserted by a test in which every configured agent fails.
- AC15: `package.json` gains no runtime dependency.
- AC16: Recorded JSONL fixtures are committed for both `codex-cli` and `claude-cli` under `fixtures/external/<agent>/`, covering the cases AC5 and AC6 enumerate, each annotated with the CLI version it was captured from.
- AC17: External execution reuses `spawnChild`; no second spawn path, second budget ledger, second depth accounting, or second event stream exists, verified by review against `src/harness/child/`.
