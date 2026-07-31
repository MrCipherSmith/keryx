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
- AC4: Every command accepting a caller-supplied path (`test suggest`, `security scan`, `agents monitor`) refuses a path that resolves outside the project root, before the file is opened. Refusal is explicit and carries a stable reason, not a generic read error.
- AC5: Containment is asserted against the resolved real path, so a traversal (`../../etc/passwd`), an absolute path, and a symlink pointing outside the project are all refused.
- AC6: A path inside the project continues to work unchanged, including one reached through a symlink that stays inside the project.
- AC7: A regression test fails if the containment check is removed.
- AC8: No credential file, and no file outside the project, is read or transmitted by any of the three commands under the fixtures in AC4–AC5.
- AC9: `bunx tsc --noEmit` is clean, `bun test` is green with no reduction from the pre-change baseline, both the file alone and the full suite exit 0, and `keryx health run` reports a passing gate.
- AC10: No unrelated behaviour changes. Legitimate searches and legitimate in-project paths behave exactly as before, evidenced by the pre-existing tests for those commands remaining green and unmodified.
