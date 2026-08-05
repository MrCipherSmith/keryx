# Flow 1 — the tool surface answers
Version: 2.0.0

> **Narrowed 2026-08-05.** This dispatch originally paired D1 with the unattended
> posture (D2). After three review rounds the unattended half was descoped —
> design, semantics and acceptance criteria moved intact to
> [keryx-unattended-posture](../../keryx-unattended-posture/specification.md),
> nothing discarded. What remains here is D1 plus the out-of-root read channel
> the work itself opened, which must be closed in this flow because this flow
> created it.

Covers D1 (all three layers) and the `search_code` read channel. It unblocks the
P3 re-measurement, which was the only thing genuinely waiting on P1.

## Flow setup

```bash
keryx flow init --title "The tool surface answers: parameter parity, one tool story, and an unapproved read channel closed"
```

Then paste the acceptance criteria below into the flow's
`acceptance-criteria.md` **before** freezing — `keryx flow freeze` checksums that
file and the criteria become immutable.

```bash
keryx flow task add <id> --title "T1 graph_affected accepts depth and ranked" --kind implement
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
- AC3: `buildAgentSystemInstruction` (`src/commands/agent.ts`) and the shell instruction (`src/commands/shell.ts`) advertise the same tool set, and that set equals the registered tools. A test asserts all three agree and fails if any drifts.
- AC4: The instruction "Prefer ONE correct shell_exec over many exploratory tool calls when the user asks to run a known keryx workflow" no longer routes the model to the shell for a question a registered tool answers. A test asserts the instruction text does not tell the model to prefer shell over a tool for those classes.
- AC5: `bun run check` and `bun run check:doc-links` pass; no test is skipped or weakened for this work.
- AC6: No documentation claim is widened beyond what a test covers. `docs/docs/harness.md` and `docs/docs/cli-reference.md` describe the new flag, including what it does NOT do.
- AC7: `search_code` cannot read outside the project root by any combination of `pattern`, `path` and `flags`. Asserted end-to-end against real ripgrep, including a `flags` value that changes traversal rather than arguments, and including an in-root symlink pointing out.
- AC8: The parity contract has teeth in both directions: a tool that silently refuses an option its verb accepts fails the scanner, and an option excepted from passthrough must be declared.
```

## Files

| Task | File | Change |
|---|---|---|
| T1 | `src/harness/tool/metaproject-operations.ts` (~416–435) | Add `depth`, `ranked` to `graph_affected`'s input schema and pass them to `port.graphAffected` |
| T1 | `src/harness/tool/metaproject-port.ts` | Widen the port input if it does not already carry depth/ranked |
| T1 | `src/harness/tool/builtin/metaproject-tools.ts` (~214) | Same parity for the builtin registration |
| T3, T4 | `src/commands/agent.ts` (237, 244), `src/commands/shell.ts` (175) | One tool list, derived from the registry rather than hand-written twice; drop the shell-first rule for tool-answerable classes |
| T5 | new test files beside each | See criteria |
| T6 | `docs/docs/harness.md`, `docs/docs/cli-reference.md` | The widened tools, and what `search_code` will not do |

## The trap, and where it went

The original trap — a blanket approve-everything flag — belongs to the descoped
half and is restated in the new package, whose design constraint now begins with
what three rounds cost to learn.

The trap that remains here is smaller and was demonstrated twice: **a tool that
is weaker than the CLI verb it wraps teaches the model to bypass it, and a fix
that confines one argument is not the same as confining the run.** `search_code`
was given a `flags` array and immediately leaked out-of-root reads twice — first
because the pattern was a positional operand a flag could redefine, then because
`--follow` changes traversal rather than arguments. Close the class, not the
instance.

## Definition of done

`keryx flow ac confirm` for every criterion with evidence, `flow implemented --pr <url>`,
review addressed, merged, `flow complete --merged <sha>`.