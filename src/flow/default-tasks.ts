import type { TaskKind } from "./types";

/**
 * The four tasks `flow init` writes into every new package — and the single
 * source of truth for them, read by `service.init()` (which writes them into
 * `flow.json`) and by `templates.renderTasksDoc()` (which documents them in
 * `tasks.md`). Before this module the two lists were typed out twice and had
 * already drifted: `flow.json` said `T4 Self-review and prepare draft PR`
 * while `tasks.md` said `T4 Review, fix findings, and prepare PR`, so the
 * package documented a task it did not contain.
 *
 * ## Why these still exist (flow 211, AC8)
 *
 * They were up for removal. The case against them was that they are a guess at
 * a plan written before anyone knows the plan, and that they produced 30 of the
 * 59 unfinished tasks the historical debt cleanup had to dispose of. The
 * measurement over all 206 flow packages on disk (at `55e1bd83^`, before that
 * cleanup rewrote the dispositions) does not support the premise:
 *
 * - **No flow has ever replaced them.** Zero of 206 packages have a task list
 *   without these four rows. Flows *extend* the scaffold; they do not supersede
 *   it. "Most flows ignore it" was not measured, it was assumed.
 * - **They get done.** 754 of 824 scaffold rows (91.5%) reached `done`. Of the
 *   70 that did not, 40 sit in flows that are still `blocked` or `in-progress`
 *   — unfinished flows, not unfinished bookkeeping.
 * - **For 43% of flows they ARE the plan.** 89 of 206 packages recorded no task
 *   beyond these four; of the 79 of those that completed, 78 marked all four
 *   done. Deleting the scaffold deletes the entire task list of nearly half the
 *   flows ever created here.
 * - **Even flows that write their own keep working these.** Of the 117 packages
 *   that added tasks, 94 still completed all four scaffold rows. The 23 that did
 *   not are concentrated in one same-day batch (`064`-`082`, 2026-07-20), 20 of
 *   which left exactly one row open. That is one operator's habit on one
 *   afternoon, not a systemic behaviour a generator change should be aimed at.
 *
 * And the alternative is measurably weaker rather than merely different:
 *
 * - `evaluateTaskGate([])` returns `passed: true` — a flow with no tasks passes
 *   the task gate vacuously, reporting `0 task(s) terminal`. Stopping generation
 *   turns the gate off for exactly the flows nobody wrote tasks for, which is
 *   the population it was added to catch.
 * - `/goal --auto` has no other source of tasks. `autoProvisionFlow`
 *   (`src/commands/goal-command.ts`) calls `init` and nothing else, because
 *   `keryx flow plan` is advisory console output that writes no state. With an
 *   empty scaffold every auto-provisioned flow would carry an empty task list,
 *   and the continuation round's steering message would degrade to
 *   "(no open tasks recorded)" for its whole run.
 *
 * So: kept, deliberately. The friction — four rows every flow must dispose of
 * once the task gate blocks completion over open ones — is the accepted price of
 * a default checklist that is demonstrably worked 9 times out of 10 and is the
 * only plan half these flows ever get. A flow that writes its own task list is
 * not required to keep them: closing a scaffold row with
 * `flow task done <id> <Tn> --disposition skipped --reason "<why>"` passes the
 * gate, and that reason is the record of the judgement.
 *
 * ## Why there is no TTL on them
 *
 * The follow-up ask was to have these "cleaned up somehow — maybe a TTL". There
 * is not one, and there should not be: a row that closes itself because N days
 * elapsed records a judgement nobody made. `disposition: "skipped"` means a
 * person or an agent looked at the work and decided it was not needed;
 * "skipped, expired after 7 days" means nobody looked. That is absence
 * presented as evidence — the same defect the review gate refuses and the same
 * one the task gate was added to close. A timer that satisfies the gate on the
 * flow's behalf is not cleanup, it is the leak with a schedule.
 *
 * Closing them automatically at `flow complete` fails for a narrower reason:
 * the task gate is the only thing standing between a flow and silent debt, and
 * a gate that disposes of the rows it is meant to refuse passes itself. For the
 * 43% of flows whose only tasks ARE the scaffold, that would check nothing at
 * all — the vacuous-gate outcome removal was rejected for, reached by a longer
 * route.
 *
 * What is here instead is the honest half of the ask: `origin: "scaffold"` on
 * every generated row, so a scaffold task is a recorded fact rather than a
 * title match, and a gate failure that names the untouched ones separately from
 * the operator's own work and hands over the exact command to close them. The
 * debt is made visible and cheap to clear; the judgement stays with whoever is
 * accountable for it. No threshold, no clock, no default disposition.
 *
 * Pinned by `src/flow/default-tasks.test.ts`. If a future change removes the
 * scaffold or adds an expiry, that test's premise is what has to be argued down
 * first.
 */
export const DEFAULT_TASKS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly kind: TaskKind;
  readonly origin: "scaffold";
}> = [
  { id: "T1", title: "Collect remaining context", kind: "context", origin: "scaffold" },
  { id: "T2", title: "Implement per plan", kind: "implement", origin: "scaffold" },
  { id: "T3", title: "Add/adjust tests and make them pass", kind: "test", origin: "scaffold" },
  { id: "T4", title: "Self-review and prepare draft PR", kind: "review", origin: "scaffold" },
];
