# Module src/trigger

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/trigger` owns the model for trigger and scheduled-agent entries: it validates and loads them, confirms and installs OS timers for scheduled agent tasks, and records every fired run. `src/trigger` groups 30 file(s). Depends on `src/lib`, `src/review`. Exposes 20 public symbol(s).

## Overview

`src/trigger` is the operator-owned side of unattended work. It defines which repository events or cron schedules a trigger can fire on, and what each trigger does: a reconcile or rebuild, opening or advancing a flow, or a free-form `agent-task`. Its entries come from two places: the hand-edited, committed `.metaproject/triggers.json`, and a per-machine schedule store that keryx writes only after an operator confirms. The module also owns the append-only record of every fired run, so `keryx trigger status` reads history rather than re-deriving it.

## How it works

The module is layered around one vocabulary and a few services that depend on it.

- `config.ts` holds the types (`TriggerEntry`, `TriggerFire`, `TriggerAction`, `AgentTaskAction`, `TriggerDispatch`, `AgentTaskGrants`) and the validation. `triggerEntryProblems` returns a list of reasons, and empty means valid, following the convention of `src/bus/schema.ts`. `loadTriggersConfig` never throws. It returns the valid entries plus a `rejected` list that records why each bad entry was refused, so one malformed entry does not drop its neighbours.
- `store.ts` is the only writer of the schedule store (`.metaproject/data/trigger/schedules.json`). It writes atomically under a lock, and it signs each entry with `confirmedHash`, an HMAC from `schedule-key.ts` rather than a plain hash.
- `schedules.ts` is the service behind every way a schedule is created or changed. `draftSchedule` builds the entry and the confirmation card and writes nothing. `confirmSchedule` stores the entry and then calls `installSchedule`, and it removes the stored entry again if the install fails, so a schedule is either fully present or absent.
- `install.ts` plans and carries out the OS timer. It targets systemd `--user`, launchd or cron. Every file it writes starts with a `keryx-managed` header, and uninstall deletes a file only when that header matches this project. Under `bun test` the module refuses to touch the real scheduler unless a test injects a fake host.
- `granted-tools.ts` is a fixed, read-only catalogue of `gh` tools that an agent-task may be granted. The model chooses a tool and supplies checked parameters. `buildGrantedArgv` enforces the grant's repository list and rejects any value starting with `-`. `ghReadOnlyProblem` keeps every catalogue entry on a read-only verb allowlist.
- `record.ts` owns the append-only `runs.jsonl`. `appendTriggerRunRecord` writes one line per fired run. `readTriggerRuns` returns `absent`, `present` or `unreadable`, and it never reports a partly damaged history as complete. `openReservations` finds spend reservations that no later record has closed.

The design keeps unattended runs away from anything an agent could edit. Per-machine schedules are never committed, a committed `triggers.json` may not carry an `agent-task`, and a name held by a local schedule wins over a committed trigger of the same name.

## Key concepts

- **Trigger entry** (`TriggerEntry`): a named unit with a `fire` (`TriggerFire`, either an event from `TRIGGER_EVENT_NAMES` or a `schedule` with a cron string), an `action` (`TriggerAction`), an `enabled` flag, and a `source` of `config` or `store`. The name is the argument to `keryx trigger run <name>`, so it must be unique.
- **Action kinds** (`TRIGGER_ACTION_KINDS`): `reconcile`, `rebuild`, `open-flow`, `flow-next` and `agent-task`. Only `flow-next` and `agent-task` carry a `dispatch` block.
- **Agent task** (`AgentTaskAction`): a free-form scheduled agent. It has a prompt of at most 4000 characters, a `dispatch` block, `grants`, and optional `digest` or `review` blocks. It is loaded only from the schedule store.
- **Dispatch** (`TriggerDispatch`): the provider, model, permission mode, token rates and spend ceiling. Rates must be positive, and `ceilingUsd` is required, so a run whose cost cannot be priced is refused at load time. `permissionMode` is `ask` or `trust`. `auto` is refused, because nobody is present to see what it approves.
- **Grants** (`AgentTaskGrants`): the network mode (`off`, `full` or `allowlist`), the domains and ports for that allowlist, the granted tool ids, the repositories those tools may touch, and the resolved binaries with their digests.
- **Confirmed runner** (`ConfirmedRunner`): the keryx invocation and pinned environment the operator saw on the card. The installed timer reuses this exact invocation on every install and resume.
- **Run record** (`TriggerRunRecord`): one fired run, with an `outcome` (`ok`, `no-op`, `lock-refused`, `failed`, `budget-refused`, `dispatch-refused`, `reserved` or `reservation-resolved`), a `cost` that records whether a figure is known, and optional `dispatch` or `agentTask` detail.
- **Granted tool** (`GrantedToolSpec`): a catalogue entry such as `gh.pr.list`. Its program and argv are fixed in code, and its parameters are typed.

These objects connect in one direction. A validated `TriggerEntry` is what the install step turns into a timer. The run record is what a later fire writes against that entry's name.

## Main flows

1. **Loading.** `loadTriggersConfig` reads `triggers.json` and then the schedule store. Each entry goes through `triggerEntryProblems`. Two rules are applied on top of that check: an `agent-task` found in the committed file is refused, and a later entry that reuses a name is refused. A store that is tracked by git is refused as a whole, and the rest of the file still loads.

2. **Creating a schedule.** `draftSchedule` checks that the provider reports token usage and has a usable credential, and it pins each granted binary. It builds the entry and renders the card, and it writes nothing. After the operator confirms, `confirmSchedule` calls `addConfirmedSchedule`, which signs the entry and writes it under the schedules lock. It then calls `installSchedule`. If that install throws, the stored entry is removed again. A digest is the exception: it has no OS timer, and `confirmSchedule` returns the `serve` backend instead.

3. **Recording a run.** A fired run ends with `appendTriggerRunRecord`, which appends one JSON line to `runs.jsonl`. A `reserved` record is written before a dispatch makes its first model call. A later record with the same `dispatch.runId` closes it. `openReservations` and `readTriggerRuns` read the file back, and `readTriggerRuns` refuses a file with damaged lines rather than reporting a partial history as complete.

---

<!-- keryx:reference:begin v=1 hash=ccb4fc6b3ae583ba430d655267efd117b8d272015be34fc76e47cb307fe38702 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `TRIGGER_EVENT_NAMES`
- `TriggerEventName`
- `TRIGGER_ACTION_KINDS`
- `TriggerActionKind`
- `TriggerFire`
- `TriggerAction`
- `AgentTaskAction`
- `AGENT_TASK_NETWORK_MODES`
- `AgentTaskNetworkMode`
- `agentTaskDomainProblem`
- `AgentTaskGrants`
- `DEFAULT_AGENT_TASK_MAX_SECONDS`
- `DEFAULT_AGENT_TASK_REPORT_KEEP`
- `TriggerDispatch`
- `UNATTENDED_PERMISSION_MODES`
- `UnattendedPermissionMode`
- `DEFAULT_DISPATCH_MAX_SECONDS`
- `DEFAULT_DISPATCH_MAX_ATTEMPTS`
- `TriggerEntry`
- `ConfirmedRunner`

### Key files

- `src/trigger/config.ts` - imported by 40, imports 6
- `src/trigger/record.ts` - imported by 44, imports 2
- `src/trigger/schedules.ts` - imported by 13, imports 13
- `src/trigger/install.ts` - imported by 18, imports 5
- `src/trigger/granted-tools.ts` - imported by 17, imports 1
- `src/trigger/store.ts` - imported by 13, imports 5

### Depends on

- `src/lib` - 19 import(s)
- `src/review` - 1 import(s)

### Depended on by

- `src/commands` - 33 import(s)
- `src/tui` - 24 import(s)
- `src/scheduler` - 22 import(s)
- `src/intake` - 5 import(s)
- `src/governance` - 3 import(s)

### Dependency basis

- Production imports only: 80 import(s) from test file(s) (e.g. `src/commands/maintenance-lock.e2e.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 30
- Cross-module imports: 20
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/review](src-review.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/scheduler](src-scheduler.md)
- [Module src/intake](src-intake.md)
- [Module src/governance](src-governance.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
