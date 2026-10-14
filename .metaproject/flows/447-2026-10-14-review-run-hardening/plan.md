# Implementation Plan

Status: implemented

## Approach

Three small changes, each at the place the fault was found, each with a test that fails without it.

1. `shell-exec-tool.ts`: build a clamp note from `clampTaskIdleTimeoutMs` and append it to every
   result path; put the range and the detach advice in the tool description.
2. `review-run.ts`: a `createHeartbeat` that turns `onProgress` into rate-limited stderr lines,
   passed to the runner. Stdout is untouched, so `--json` stays parseable.
3. `autonomous-profile.ts`: `buildAutonomousPrompt` takes the resolved head; `autonomous-run.ts`
   passes it. A null head leaves the prompt as it was.

## Steps

1. Clamp note and description, with tests.
2. Heartbeat, with tests including `--json`.
3. Head in the prompt, with tests for both a known and a null head.
4. Docs and changelog.

## Risks

- `review complete` has no `--head`, so a package already recorded against another commit still
  fails the gate there; this flow only prevents new ones.
- The heartbeat is rate limited to one line a minute; a wrapper with a shorter idle rail still
  needs the command detached.
