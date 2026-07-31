# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx modules --json` emits valid JSON describing every module and whether it is enabled; the same invocation run twice produces byte-identical output, and entries are sorted so the result is diffable.
- AC2: `COMMAND_DESCRIPTORS` contains a descriptor for every agent-facing maintenance command previously missing — `gdgraph build`, `wiki collect`, `wiki check-links`, `test analyze`, `test status`, `memory index`, `ctx status`, `status`, `modules status` — each with a summary, at least one intent phrase, and an argument schema.
- AC3: Every descriptor's `read` flag matches what the command actually does: commands that write into `.metaproject/` declare `read: false` and carry a non-empty `sideEffects`, and no command that writes is marked `read: true`.
- AC4: A coverage test enumerates the agent-facing CLI surface and fails when a command has no descriptor. Every deliberate exclusion sits in one explicit allowlist with a stated reason, and the test fails if an exclusion has no reason.
- AC5: `keryx commands --json` remains deterministic — two consecutive runs are byte-identical and entries are sorted by `(module, command)`.
- AC6: `bunx tsc --noEmit` is clean, `bun test` is green with no reduction from the pre-change baseline, and `keryx health run` reports a passing gate.
- AC7: No command's runtime behaviour changes. The diff adds descriptors, a `--json` output path, and tests; it does not alter what any existing command does.
