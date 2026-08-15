# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `openModal` with one tab paints a titled panel and backdrop; while it is open the slash menu does not open on `/`.
- AC2: `openModal` with tabs `[a,b]` and `initialTab: "b"` mounts only `b`'s body; switching to `a` unmounts `b` (cleanup from `renderTab` runs).
- AC3: Two sequential `openModal` calls with different `initialTab` values share one host implementation (no second overlay stack).
- AC4: Esc closes the modal, runs `onClose`, restores composer focus, and `overlayActive()` is false afterwards.
- AC5: Opening the host when OpenTUI is unavailable is a no-op or typed skip; readline slash handling is unchanged.
- AC6: Headless tests under `src/tui/` cover AC1–AC5 and do not require a user TTY.
- AC7: No top-level `@opentui/core` import is added. No `/session-info` slash command is added in this flow.
