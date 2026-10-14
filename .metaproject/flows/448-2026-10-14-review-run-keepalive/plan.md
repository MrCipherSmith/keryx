# Implementation Plan

Status: implemented

## Approach

1. `review-run.ts`: `createHeartbeat` gains an optional keep-alive period and a `stop()`. A timer
   re-armed after every line repeats the latest known state (`phase starting` before the first
   report), is `unref`ed, and is stopped in the command's `finally`. It only writes: the runner's
   stall detection watches the child's events file, which the timer never touches, so a stalled
   child is still terminated and the timer ends with the run.
2. `review.ts`, `managed.ts`: `review complete` accepts `--head <sha>` (SHA of 7-40 hex characters,
   pull request packages only). `completeManagedReview` builds an effective manifest with that
   head and hands it to `completeHeadGate`, which is unchanged, so a head that is not the PR's
   head still needs the report's first line to name it and say the PR moved. The closed manifest
   records the head, and a replaced recorded head is a warning.
3. `autonomous-profile.ts`: the head instruction also names `keryx review complete`.
4. Docs, help text and changelog.

## Steps

1. Keep-alive with unit tests and a stalled-child integration test.
2. `--head` on complete with positive, negative and argument-validation tests at the library and
   CLI levels.
3. Prompt text and its test.
4. Docs.

## Risks

- `complete --head` rewrites `manifest.target.head`. It is the caller's claim, as it is for
  `start`; the warning on a replaced head and the unchanged gate bound what it can hide.
- The keep-alive is one line a minute; a wrapper with a shorter idle rail still needs the command
  detached.
