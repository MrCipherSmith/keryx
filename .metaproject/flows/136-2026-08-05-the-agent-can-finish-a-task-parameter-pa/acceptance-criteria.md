# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `graph_affected` accepts an optional `depth` (positive integer) and an optional `ranked` (boolean), passes both through to the graph port, and a test asserts the depth-2 result differs from the depth-1 result on a fixture with a transitive dependent.
- AC2: No metaproject tool accepts a strict subset of the arguments its wrapped CLI verb accepts. A test enumerates the tool/verb pairs and fails on any tool that cannot express what its verb can.
- AC3: `keryx shell` accepts a documented unattended flag. Under it, a run whose only tool calls are `risk: "read"` completes with no prompt and no operator input.
- AC4: Under the unattended flag, a `deny` remains terminal. A test asserts that a policy-denied action is refused with the flag set exactly as it is without it.
- AC5: Under the unattended flag, an `ask` with no approver resolves to `deny`, never to allow. A test asserts the refusal.
- AC6: Under the unattended flag, a destructive-class action is refused regardless of any profile entry. A test asserts the refusal and that no filesystem change occurred.
- AC7: With no flag, behaviour is unchanged: a test pins that an `ask` still prompts and that the default posture was not loosened to make the flag look good.
- AC8: The unattended posture is visible in the TUI header and recorded in the run record, so a reader can tell an unattended run from a supervised one.
- AC9: `buildAgentSystemInstruction` (`src/commands/agent.ts`) and the shell instruction (`src/commands/shell.ts`) advertise the same tool set, and that set equals the registered tools. A test asserts all three agree and fails if any drifts.
- AC10: The instruction "Prefer ONE correct shell_exec over many exploratory tool calls when the user asks to run a known keryx workflow" no longer routes the model to the shell for a question a registered tool answers. A test asserts the instruction text does not tell the model to prefer shell over a tool for those classes.
- AC11: Benchmark case A1, run scripted under the unattended flag against a project with a built graph, produces a correct transitive dependent list with `human_interventions: 0` and a tool path containing `graph_affected` and no `shell_exec` invoking `keryx gdgraph`.
- AC12: `bun run check` and `bun run check:doc-links` pass; no test is skipped or weakened for this work.
- AC13: No documentation claim is widened beyond what a test covers. `docs/docs/harness.md` and `docs/docs/cli-reference.md` describe the new flag, including what it does NOT do.
