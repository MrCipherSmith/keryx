# Autonomous review run hardening: visible idle clamp, heartbeat, PR head in prompt

Status: approved by the operator (poll 173, 2026-10-14)
Source: investigation of a stalled autonomous review run (origin: agent-finding)

## Problem

An autonomous review run of a large pull request was killed by the shell's idle rail and then
recorded a review package against the wrong commit. Two causes:

1. `shell_exec` clamps a model-supplied `idle_timeout_ms` to 1000-1800000 without saying so. The
   model asked for an hour, got thirty minutes, and the command died silent with `killReason: idle`.
2. The autonomous prompt never named the pull request head. `keryx review start` and `ingest`
   then recorded the commit checked out in the directory, not the one reviewed, and the
   completion gate failed for the wrong reason.

A third gap made both hard to see: a run that goes quiet prints nothing, so a wrapper with its
own idle rail cannot tell a live review from a hung one.

## Expected Outcome

A clamped `idle_timeout_ms` is visible in the result and in the tool description. A review run
shows life on stderr without breaking `--json`. The child is told which commit to review and to
pass it as `--head`.

## Outcome criteria

- Запрос (дословно): «Да, оба пункта» (make the shell_exec clamp visible, add a review-run heartbeat on stderr) and «Да» (put the PR head in the autonomous prompt and require `--head <sha>`), operator poll 173, 2026-10-14
- Эффект (формализация агента): a model that asks for more idle time than allowed is told what it got and what to do instead; a quiet review run still emits a line when its progress changes; an autonomous child reviews and records exactly the pull request head
- Как наблюдать (предложение агента): the `shell_exec` result of a call with `idle_timeout_ms: 3600000` names 1800000; `keryx review run --autonomous --json 2>err` fills `err` with `heartbeat:` lines and leaves stdout parseable; the child's prompt contains `--head <sha>`

## Out of Scope

- A `--head` flag on `keryx review complete`.
- Raising the 30 minute idle ceiling.
- Changing how `resolveTargetHead` prefers the local HEAD.
