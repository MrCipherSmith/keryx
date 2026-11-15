# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Section 6 of `docs/requirements/keryx-desktop-app/specification.md` names only fields that exist in `src/hub/work` or are marked "derived projection, new"; it states that the work module stores no stage and no finding, and names the document-import handler. [verify: judged]
- AC2: The mode table defines exactly five modes (quick, bug, task, epic, refactor), each with a default review depth that maps to an existing review profile and a criteria template; the tests fail if a mode is missing or a depth names an unknown profile. [verify: exec `bun test src/hub/work/quick-modes.test.ts`]
- AC3: Every mode has a non-empty list of template clarifying questions, each answerable or skippable, and the request records skipped questions as `skipped: true` with no answer text. [verify: exec `bun test src/hub/work/clarify.test.ts`]
- AC4: A quick-start request with a one-line description creates a Flow with no pre-imported specification, one intent and criteria frozen from the template plus the operator's own, in a single transaction. [verify: exec `bun test src/hub/work/quick-start.test.ts`]
- AC5: Replaying the same quick-start request with the same operation id creates no second Flow and returns the stored receipt; the same id with a different body returns 409 `idempotency-conflict`. [verify: exec `bun test src/hub/work/quick-start.test.ts`]
- AC6: A quick start whose clarifying form was skipped records the skip on the Flow, and the record is readable from the Flow after creation. [verify: exec `bun test src/hub/work/quick-start.test.ts`]
- AC7: If any of the three composed commands fails, no Flow, intent or partial criteria remain. [verify: exec `bun test src/hub/work/quick-start.test.ts`]
- AC8: The quick-start route acts as the signed-in operator and refuses a request without a human session; no agent credential can freeze criteria through it. [verify: exec `bun test src/hub/work/quick-start.test.ts`]
- AC9: The web "New task" dialog covers every row of the plan's state and event matrix (open, mode, questions, submit, replay, rejection, network loss, Escape, skip), is operable by keyboard alone, and has both RU and EN strings with no missing key. [verify: exec `bun run --cwd apps/hub-web test -- quick-start`]
- AC10: The embedded production web assets match the sources after the change. [verify: exec `bun scripts/build-hub-web.ts --check`]
- AC11: The TUI has a `/task` command and a menu entry that open a modal covering every row of the plan's state and event matrix, operable by keyboard alone, and sending the same request shape as the web. [verify: exec `bun test src/tui/quick-start-modal.test.ts`]
- AC12: The parity test fails when a quick-start request field is present on one surface (web or TUI) and absent on the other. [verify: exec `bun test src/hub/work/surface-parity.test.ts`]
- AC13: Typecheck passes for the root project and for the web app. [verify: exec `bun run typecheck && bun run --cwd apps/hub-web typecheck`]
- AC14: A smoke run against a real Hub started from this branch creates a Flow through the web dialog and one through `/task`, and both Flows show frozen criteria in the work view. [verify: judged]
- AC15: No desktop binary, Rust code or Tauri configuration is added by this Flow. [verify: invariant `test -z "$(git diff --name-only main...HEAD -- apps/desktop ':(glob,icase)**/*tauri*')"`]
