# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: auto-provisioned by `/goal --auto` (SLATE-27, flow 186) — the
goal text itself is the spec; no separate description/plan pair exists.

## Criteria

- AC1: The stated goal — "Скажи одним словом: сколько будет 2+2" — is achieved, judged by the
  verifier subagent this session's continuation loop runs before
  stopping (flow 186 T10).
