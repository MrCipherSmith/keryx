# Start a flow from a repository event or a schedule

## Why now

JetBrains' Air announcement (2026-09-22) states the direction plainly: more work will be
triggered by repository events, schedules and delivery processes than by a developer
opening an editor and typing a prompt. keryx already has the unit such work should be
expressed in — a flow with frozen acceptance criteria, tasks, a review package and
completion gates — but every flow today starts because a person asked for one.

## What exists already

- `keryx sync install-hooks` installs `post-merge` and `post-checkout`, so a pull or a
  branch switch already reconciles the graph, wiki and memory.
- A `post-commit` hook rebuilds the graph after a graph-relevant commit.
- Background tasks and `keryx serve` exist, and the agent bus carries child work.

What is missing is the step from "an event happened" to "a flow was started and someone
was told": no schedule, no repository-event entry point, and no record that a triggered
run happened.

## What this flow builds

1. A declarative trigger file in the project (`.metaproject/triggers.json` or the module
   config — the flow decides), naming what starts what: an event (`post-merge`,
   `post-commit`, a CI hook calling keryx) or a schedule, and the action (reconcile,
   rebuild, open a flow from a template, run a named flow's next task).
2. `keryx trigger run <name>` — the single entry point a hook, a cron line or a CI job
   calls. It does one pass, is safe to run concurrently with another keryx process, and
   exits non-zero only when the work itself failed.
3. `keryx trigger install` / `list` / `status`, extending the existing hook installer
   rather than replacing it, plus a record of every fired trigger (what fired, when, what
   it did, what it cost) that `status` reads.
4. Scheduling is delegated, not invented: keryx emits the cron line or the systemd timer
   unit and the operator installs it. keryx does not run a daemon for this.

## Out of scope

- Any hosted or multi-machine scheduler.
- Reacting to GitHub webhooks directly; a CI job calling `keryx trigger run` covers that
  path without keryx holding a public endpoint.
- Autonomous merging: a triggered run may open a flow and do work, but completion stays
  gated exactly as it is today.

## Risks

- A triggered run that opens a flow on every event turns the flow list into noise: the
  trigger must be able to say "only if nothing is already open for this".
- Two triggers firing at once on the same project must not corrupt the graph or the
  session store; the run must take the same locks the interactive commands take.
- A schedule that runs an agent turn costs money; the record must carry the cost, and a
  budget refusal must be a first-class outcome rather than a failure.
