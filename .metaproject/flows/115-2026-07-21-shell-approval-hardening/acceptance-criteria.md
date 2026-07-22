# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A command carrying an unquoted shell metacharacter is never auto-approved from the allowlist and can never be stored as a pattern, while a quoted metacharacter (`git commit -m "fix: a; b"`) is unaffected.
- AC2: A destructive command is never auto-approved however exactly a stored pattern matches it, including an exact stored `rm -rf /`, and "always" is never offered for one.
- AC3: A bare `<interpreter> *` pattern is refused at save and dropped at load with a stated reason; a narrower pattern that constrains arguments is still accepted.
- AC4: Loading reports refused patterns instead of deleting them, and the TUI surfaces them once per session before the first auto-approve.
- AC5: A command touching the agent's own permission/credential files always prompts and can never be remembered, and the session warns when that file changes underneath it.
- AC6: The `destructive` risk class is reachable end-to-end: a tool declaring it is gated by approval rather than rejected, and a destructive command escalates its prompt while default-deny is preserved.
- AC7: A subagent cannot execute shell in any mode, cannot spawn a further subagent, falls back to the restricted mode on an absent/unknown mode, and its summary is bounded before entering the parent's history.
- AC8: An approval is bound to the action it approves: the approver receives the action fingerprint, and an answer carrying a different fingerprint does not authorise the call.
- AC9: `bun test`, `tsc --noEmit`, and `keryx health run` are green with no health regression after every commit.
- AC10: The stress harness asserts each new barrier, and the checks it previously failed for these findings (P2b, M3) pass on the fixed code.
