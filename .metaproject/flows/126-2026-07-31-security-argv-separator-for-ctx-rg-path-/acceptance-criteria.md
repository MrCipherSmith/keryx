# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The ripgrep argv built by `ctx rg` places a literal `--` immediately before the caller-supplied pattern, so no caller value can be parsed as a ripgrep option. Asserted on the constructed argv, not only on observed behaviour.
- AC2: A pattern beginning with `-` is searched for literally. A pattern naming a ripgrep option that executes an external program does not execute it, and the run either returns matches for that literal string or fails without spawning the program.
- AC3: A regression test fails if the `--` separator is removed.
- AC4: `test suggest` and `security scan` refuse a path that resolves outside the project root, before the file is opened. Refusal is explicit and carries a stable reason distinguishable from a missing file, not a generic read error. `agents monitor` is deliberately excluded: its event stream is a harness artifact that legitimately lives outside the repository (temp dirs, CI artifacts), it transmits nothing, and it parses a strict typed format — so containment there would break a legitimate read while buying nothing. The exclusion and its reasoning are recorded in the flow plan.
- AC5: Containment is asserted against the resolved real path, so a traversal (`../elsewhere/secret`), an absolute path outside the root, a symlink inside the project pointing outside it, and a sibling directory sharing the root's name prefix are all refused.
- AC6: A path inside the project continues to work unchanged, including one reached through a symlink that stays inside the project, and the project root itself.
- AC7: A regression test fails if the real-path resolution is removed from the containment check — demonstrated, not asserted.
- AC8: A traversal to a path that does not exist is refused as an escape rather than reported as not-found, so the refusal cannot be used as an existence oracle for files outside the project.
- AC9: `bunx tsc --noEmit` is clean, `bun test` is green with no reduction from the pre-change baseline, both the file alone and the full suite exit 0, and `keryx health run` reports a passing gate.
- AC10: No unrelated behaviour changes. Legitimate searches and legitimate in-project paths behave exactly as before, evidenced by the pre-existing tests for those commands remaining green and unmodified.
