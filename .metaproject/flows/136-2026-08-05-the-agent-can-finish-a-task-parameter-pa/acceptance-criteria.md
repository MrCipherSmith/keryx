# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Scope change, 2026-08-05

The unattended posture was descoped out of this flow after three review rounds,
into `docs/requirements/keryx-unattended-posture/`. The criteria that governed it
— the former AC3–AC8, and AC11's dependence on the flag — went with it. Nothing
was weakened to make this flow pass: the code those criteria governed is not in
this branch at all.

The criteria below are the retained ones, renumbered. AC14 is new and is the one
thing the descoped work left behind that must not travel with it: the read
channel this flow's own parameter-parity change opened.

## Criteria

- AC1: `graph_affected` accepts an optional `depth` (positive integer) and an optional `ranked` (boolean), passes both through to the graph port, and a test asserts the depth-2 result differs from the depth-1 result on a fixture with a transitive dependent.
- AC2: No metaproject tool accepts a strict subset of the arguments its wrapped CLI verb accepts. A test enumerates the tool/verb pairs and fails on any tool that cannot express what its verb can. Where a tool deliberately routes or refuses one of its verb's options, the exception is declared in the parity contract and the test fails if the declaration and the behaviour disagree.
- AC9: `buildAgentSystemInstruction` (`src/commands/agent.ts`) and the shell instruction (`src/commands/shell.ts`) advertise the same tool set, and that set equals the registered tools. A test asserts all three agree and fails if any drifts.
- AC10: The instruction "Prefer ONE correct shell_exec over many exploratory tool calls when the user asks to run a known keryx workflow" no longer routes the model to the shell for a question a registered tool answers. A test asserts the instruction text does not tell the model to prefer shell over a tool for those classes.
- AC12: `bun run check` and `bun run check:doc-links` pass; no test is skipped or weakened for this work.
- AC13: No documentation claim is widened beyond what a test covers. `docs/docs/harness.md` and `docs/docs/cli-reference.md` describe the widened tool surface, including what it does NOT do.
- AC14: `search_code` cannot be steered into reading outside the project root by any accepted input. The pattern never reaches ripgrep as a positional operand, there is exactly one operand and it is a root-confined path, and symlink traversal is off on every invocation. A test proves it end to end against real ripgrep with an in-root symlink pointing out of the project.
