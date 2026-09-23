// Flow 295: descriptors for `keryx schedule`, kept in their own file so this
// flow's addition to the registry is one spread line in `./command-registry.ts`.
//
// Only the read-only `schedule list` is described. Creating, pausing,
// resuming and removing a schedule each need the operator's confirmation (they
// write a per-machine store and install or remove an OS timer). They are
// deliberately not advertised to agents or remote consumers, which treat this
// registry as the set of callable operations. An agent proposes a schedule
// with the `schedule_create` tool, and the operator confirms it in the shell.

import type { CommandDescriptor } from "./command-registry";

export const SCHEDULE_DESCRIPTORS: CommandDescriptor[] = [
  {
    module: "schedule",
    command: "schedule list",
    summary:
      "List scheduled agent tasks: cadence, enabled or paused, installed timer, next run, last outcome with cost, and the last report path.",
    intent: ["list schedules", "scheduled tasks", "какие задачи по расписанию", "покажи расписание", "schedule list"],
    args: [],
    json: false,
    read: true,
  },
];
