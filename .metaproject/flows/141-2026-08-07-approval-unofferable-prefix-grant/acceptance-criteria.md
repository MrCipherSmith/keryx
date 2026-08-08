# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `suggestShellPatterns` returns `offerPrefix: false` for a command containing an unquoted shell metacharacter, with the C3 benchmark command as a test input.
- AC2: `offerPrefix` stays `true` for a clean command whose prefix is offerable — the fix narrows the predicate, it does not remove the feature.
- AC3: A test asserts the invariant directly: for any command, if an offer is made, then a stored grant of that pattern would cause `isShellCommandAllowed` to auto-approve that same command.
- AC4: Destructive and credential-touching commands still offer neither grant — no behaviour change there.
- AC5: The invariant comment at `src/tui/tui-shell.ts:438` is still true of the code below it after the change.
