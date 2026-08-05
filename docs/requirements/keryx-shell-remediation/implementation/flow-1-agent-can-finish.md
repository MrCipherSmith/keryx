# Flow 1 — the agent can finish a task
Version: 1.0.0

Covers D1 (all three layers) and D2. This is the flow that unblocks everything
else: until it lands, no keryx run completes without a human, so no other change
can be verified end to end.

## Flow setup

```bash
keryx flow init --title "The agent can finish a task: parameter parity, unattended posture, one tool story"
```

Then paste the acceptance criteria below into the flow's
`acceptance-criteria.md` **before** freezing — `keryx flow freeze` checksums that
file and the criteria become immutable.

```bash
keryx flow task add <id> --title "T1 graph_affected accepts depth and ranked" --kind implement
keryx flow task add <id> --title "T2 unattended posture flag and policy wiring" --kind implement
keryx flow task add <id> --title "T3 reconcile both system instructions with the registry" --kind implement
keryx flow task add <id> --title "T4 remove the shell-first instruction" --kind implement
keryx flow task add <id> --title "T5 tests: capability, refusal, drift" --kind test
keryx flow task add <id> --title "T6 docs: harness page and CLI reference" --kind docs
keryx flow task add <id> --title "T7 full gate and draft PR" --kind review
keryx flow freeze <id> && keryx flow start <id>
```

## Acceptance criteria — paste verbatim

```
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
```

## Files

| Task | File | Change |
|---|---|---|
| T1 | `src/harness/tool/metaproject-operations.ts` (~416–435) | Add `depth`, `ranked` to `graph_affected`'s input schema and pass them to `port.graphAffected` |
| T1 | `src/harness/tool/metaproject-port.ts` | Widen the port input if it does not already carry depth/ranked |
| T1 | `src/harness/tool/builtin/metaproject-tools.ts` (~214) | Same parity for the builtin registration |
| T2 | `src/commands/shell.ts` | Parse the flag; thread the posture into the agent loop |
| T2 | `src/harness/policy/` | Resolve the posture. **Do not** add a path that reaches a `deny` |
| T3, T4 | `src/commands/agent.ts` (237, 244), `src/commands/shell.ts` (175) | One tool list, derived from the registry rather than hand-written twice; drop the shell-first rule for tool-answerable classes |
| T5 | new test files beside each | See criteria |
| T6 | `docs/docs/harness.md`, `docs/docs/cli-reference.md` | The flag, its limits, and the widened tool |

## The trap

The cheap way to pass AC3 and AC11 is a blanket `--yes`. That trades away the one
property the benchmark actually demonstrated: on C1, keryx and opencode ran the
**same model** and only keryx stopped before deleting the graph index.

AC4, AC5, AC6 and AC7 exist to fail this flow if that happens. If a reviewer can
construct a destructive action that succeeds under the new flag, the flow is not
done regardless of what else passes.

## Definition of done

`keryx flow ac confirm` for AC1–AC13 with evidence, `flow implemented --pr <url>`,
review addressed, merged, `flow complete --merged <sha>`.
