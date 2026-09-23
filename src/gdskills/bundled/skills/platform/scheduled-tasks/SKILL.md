---
name: scheduled-tasks
description: "Use when the operator asks for something to happen repeatedly in the background on a cadence (every 4 hours check my PRs, each morning summarise new issues) and a keryx schedule should be proposed with schedule_create. NOT for: one-off work done now (just do it), or git-event triggers declared in triggers.json (see hookify)."
triggers:
  - "schedule a task"
  - "every 4 hours"
  - "run in the background"
  - "каждые 4 часа"
  - "по расписанию"
  - "check github regularly"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "platform"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Scheduled Tasks

Turn "do this regularly" into a keryx schedule the OPERATOR confirms. keryx runs no
daemon. After the operator's yes, it installs an OS timer (systemd --user, launchd or
cron) that runs one unattended agent turn on the prompt and writes a report the
operator reads in the shell's Schedules section.

## Workflow

### Step 1: Pin down the request
- **Cadence**: cron, or a phrase keryx translates itself — `every N hours`
  (a divisor of 24), `every N minutes` (5-30), `hourly`, `daily at HH:MM`,
  `weekdays at HH:MM`, `every monday at HH:MM`. Never invent cron from a vague
  "sometimes". Ask.
- **Prompt**: the task in the operator's words, written for an agent that runs
  alone and whose final message is the report.
- **Budget**: `rates` (USD per million input/output tokens for the model) and
  `ceilingUsd`. keryx has no price table. If you do not know the rates, ASK.
  Never guess them.

### Step 2: Grant only what the task needs
- `tools`: pick from the fixed catalogue: `gh.pr.list`, `gh.pr.view`,
  `gh.pr.checks`, `gh.issue.list`, `gh.issue.view`, `gh.run.list`. keryx
  runs them OUTSIDE the sandbox with the operator's credentials, and the
  scheduled agent sees only redacted output.
- `repos`: every repository those tools may touch (`owner/name`).
- `network`: leave it `off`. Checking GitHub needs no sandbox network, because the
  granted tools cover it. `full` hands the agent's shell the host's whole
  network; propose it only when the task truly needs it, and say why.
- `permissionMode`: `ask` (the default) is read-only, and granted tools still run.
  Propose `trust` only when the scheduled agent must run shell commands.

### Step 3: Propose with schedule_create
Call `schedule_create`. The operator then sees a confirmation card: cadence and
next runs, prompt, runner, budget, network, every granted tool with its binary
and account, and exactly what gets installed. You do not confirm it. Only the
operator can, and every permission mode asks, `auto` included.

### Step 4: Report back
After the operator's answer, say what was scheduled and when it next runs, or
that nothing was written. Point to `/schedules` for the list and the reports.

## Rules

- NEVER try to confirm, retry past a "no", or re-propose the same schedule unchanged after it was declined.
- NEVER create or install a schedule by any other route (editing
  `.metaproject/data/trigger/schedules.json`, `systemctl`, `crontab`,
  `launchctl`): the entry would carry no confirmed hash and would never run.
- NEVER run `loginctl enable-linger`. If linger is off, tell the operator the
  timer runs only while they are logged in and that the command is theirs to run.
- State the limits when they matter: the machine must be on; systemd and launchd
  catch up one missed run after sleep and cron none; the allowlist network mode
  does not exist yet.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The operator said 'every so often' — I'll pick hourly" | A cadence runs and spends unattended. Ask for it |
| "I'll grant every gh tool so the agent is not stuck" | Grants are the operator's credentials acting unattended. Grant what the prompt needs |
| "Network full is simpler than granted tools" | It gives the unattended shell the whole host network. Granted tools need none |
| "I know roughly what the model costs" | A wrong rate makes both spend ceilings wrong by the same factor. Ask |

## Verification

Do not report the schedule as created until all of the following hold:

- `schedule_create` returned "stored and installed", not "not confirmed" or an error
- `schedule_list` shows the entry, enabled, with the next run you told the operator
- The grants you proposed are the ones the card showed, with nothing added afterwards
