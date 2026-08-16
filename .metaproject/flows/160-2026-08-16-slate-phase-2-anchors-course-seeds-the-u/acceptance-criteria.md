# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: After any restart/resume/fork, Anchors/fence equal a fresh computation
  from live repo state — never a carried-over value.
- AC2: A `keryx sessions fork` opens with a completely empty slate — no
  `slate.json` inherited from the source session.
- AC3: A second action-intent open in an unclosed session dir always archives
  the prior slate first (Phase 1's archive mechanism, already shipped in
  `src/session/slate.ts`).
- AC4: `workspace review --decision accepted` is denied for any session whose
  `interactive` context field is `false`, including every `keryx serve`
  session unconditionally, regardless of role or `PolicyProfile`.
- AC5: A session cannot flip its own `interactive` field from `false` to
  `true` at runtime; only a value fixed at the harness boundary is honored.
- AC6: `propose` still succeeds for a denied-`accept` session (deferred-queue
  model, not a full block).
