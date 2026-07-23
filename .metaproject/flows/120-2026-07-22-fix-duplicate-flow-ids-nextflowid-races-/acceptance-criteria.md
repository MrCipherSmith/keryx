# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx flow init` run from two linked git worktrees of the same clone (sequentially and concurrently) never produces two flows with the same numeric id; a regression test drives both worktrees and asserts distinct ids.
- AC2: When the repository is not a git checkout, `keryx flow init` still allocates ids using the local `.metaproject/flows` listing and the existing file lock; covered by a test that runs init outside a git repo.
- AC3: `resolveFlowDir` throws on a bare numeric id that matches more than one flow directory, and the error names every candidate directory; exact directory names and unique slugs still resolve. Covered by unit tests.
- AC4: Every caller of `resolveFlowDir` surfaces that ambiguity as a clean failure, not a silent pick: `keryx flow status|task done|ac confirm|complete`, `keryx review --flow`, and `ManagedFlowPort.completeFromGate` — the harness path fails closed and writes no evidence into a guessed flow package. Covered by tests for the CLI path and the harness path.
- AC5: `keryx flow check` reports duplicate numeric ids as a distinct repo-level issue naming both directories and treats it as a hard failure (non-zero exit, same severity as the existing checksum rule); `keryx flow list` visibly marks colliding ids. The hard rule lands only after the existing collisions are repaired (AC7), so the gate is never knowingly red on `main`.
- AC6: `keryx flow renumber <dir> --to <id> --reason "<why>"` exists, is the only supported way to change a flow's number, and atomically moves the directory, rewrites `flow.json.id`, appends a `renumbered` history event, and records the old→new mapping. It refuses a target id that is already taken or previously used. Covered by tests including the refusal cases.
- AC7: After running the repair, `.metaproject/flows` contains no duplicate numeric ids: the second member of each of 002, 084 and 103 has a fresh unused id, the old→new mapping is committed, and `keryx flow check` reports zero duplicate-id issues.
- AC8: The pre-existing acceptance-criteria checksum mismatch on `002-2026-07-10-gdgraph-java-python-import-resolution` is either resolved through `keryx flow ac update` with a reason, or documented in this flow's journal as knowingly untouched — it is not silently rewritten by the renumbering.
- AC9: `keryx health run` gate passes and the full test suite is green on the branch, with no `.metaproject/flows` fixture left behind by the new tests.
- AC10: The repo-wide allocation rule and the worktree requirement for parallel flow work are documented in `.metaproject/skills/flow/` and recorded in project memory.
