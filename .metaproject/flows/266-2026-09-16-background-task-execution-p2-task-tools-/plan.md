# Implementation Plan

Status: formalized

## Approach

Extend what P0 and P1 built rather than introduce a second mechanism. The
registry already owns process groups, phases, the `observed` flag, `waitForExit`
and `onCompletion`; the task tools are a surface over it, not a new subsystem.
Three seams carry the whole phase:

1. **`invoke(input, ctx?)`** — the only change to the tool contract
   (`interactive-tools.ts`), with `executeCall` (`agent.ts`) passing the turn's
   signal. Everything abortable in this phase hangs off that one parameter, and
   every tool that ignores it is unaffected by construction. This lands FIRST,
   because both the wait and the yield depend on it.
2. **An explicit cursor** — `shell_task_output`'s `since` is what makes a second
   reader safe. The implicit cursor stays only inside the alias
   (`shell_job_output`), which is precisely why the alias is denied to side
   workers while the new tool is not.
3. **An `observer` parameter on the tool factory** — `"main"` marks a task
   observed when it returns a terminal status, `"side"` never does. This is one
   branch in one place; making it a property of the CALLER rather than of the
   task is what keeps exactly-once delivery (P1's AC1/AC2) true in the presence
   of a second reader.

Deliberately NOT done: a `TaskToolContext` object, a registry-side "who read
this" ledger, or per-reader cursors in the registry. Each would make the
registry model readers, and the phase only needs it to model one bit that
already exists.

## Steps

1. RED tests for AC1–AC12 across the registry, the tool surface, the agent loop
   and both shells, following P1's split: behaviour proven by execution where a
   seam exists, source audits only for the two REPL loops that have none.
2. `invoke(input, ctx?)` + `executeCall` passing the signal; existing suites must
   stay green untouched (AC6).
3. `shell_task_output` with the explicit cursor, and the `observer` split on the
   factory (AC1, AC10).
4. `shell_task_wait`: `any`/`all`, the [0, 300 000] clamp, abort via `ctx.signal`,
   never killing (AC2, AC3, AC7).
5. `shell_task_kill` + alias behaviour and id acceptance on both old names, with
   a deprecation note in each alias's description (AC4, AC5).
6. Operator demote as `/demote <task_id>` in BOTH shells, through the same
   release path as abort and without ending the turn; TUI list entry from the
   `phase` event (AC8).

   **Corrected before starting:** an earlier draft of this step said "one handler
   serves both shells". No such mechanism exists. `AGENT_SLASH_COMMANDS` carries
   METADATA only (`name`, `description`, `modes`) and `findAgentCommand` merely
   resolves a line to an entry; each shell then dispatches in its own branch
   (`shell.ts`'s if/else chain, `tui-shell.ts:4441` and `:4656`). The established
   shape for an argument-carrying command is `/delegate`: a PURE parser exported
   from the registry module (`parseDelegateCommand` + `DELEGATE_USAGE`, returning
   `{ok:true,…} | {ok:false,reason}`), with the effect left to each shell — and
   note that `/delegate` is called from the TUI only, so "the registry has a
   parser" does not by itself put a command in both shells.

   So P2 adds a pure `parseDemoteCommand` beside it and ONE effect helper that
   turns a parsed id into `registry.promote(id)` with its stated errors; both
   shells call the pair from their own dispatch. The executable proof is the
   parser plus that helper (unknown id, already-background task, running task),
   which is what AC8 asks for — not a shared dispatcher, and not a source audit.
7. Side-worker denial over the real roster, plus `REPEATABLE_TOOL_NAMES`
   (AC9, AC11).
8. Verify: typecheck, the named suites, the full suite, a live smoke on real
   processes for the abort-does-not-kill path, and `keryx health run` (AC12).
9. Review round ingested against the head that will merge — not before the
   phase's own bookkeeping commits, which is the trap flow 265 hit.
10. Journal deviations; mark P2 in the requirements package (README, spec status,
    metrics M7, M13, M15, PRD S4).

## Risks

- **Exactly-once delivery is now defended by a second actor's discipline.** P1
  guaranteed it with one flag; P2 adds a reader that must not touch it. If the
  `observer` split is wrong in either direction the failure is silent: either a
  notification vanishes (side worker marked it) or a task is announced after the
  model already read it. The test that matters asserts the MAIN session's
  notification survives a side-worker read, not that the flag has a value.
- **An abortable wait is a new way to leak a process.** The rule is that abort
  releases the caller and never kills; the risk is the mirror image — a released
  wait whose task is then orphaned because nobody drains it. The completion path
  from P1 is what prevents that, so the abort tests must assert delivery AFTER
  the abort, not just the prompt return.
- **`timeout_ms` is model-supplied.** Clamping is a rail, not a suggestion; the
  test asserts the clamp against values above and below the range rather than
  trusting the schema.
- **Alias drift.** Two names for two tools, each accepting two id shapes, is four
  combinations; a test pins all four rather than one representative.
