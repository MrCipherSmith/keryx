# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `validateShellPattern("keryx *")` is refused, with a reason that names `keryx ctx run --` as the arbitrary-execution path rather than reusing the generic interpreter wording.
- AC2: With a permission file written by an older keryx containing `keryx *`, `isShellCommandAllowed("keryx ctx run -- rm -rf /")` is false after load, and the load audit reports the pattern with a non-empty reason.
- AC3: Every word added to `PREFIX_BANNED` is refused as a bare prefix grant, asserted per word, and the list of added words covers `keryx` plus the wrappers found in review round 3: timeout, setsid, stdbuf, flock, unshare, strace, ltrace, busybox, parallel, command, chroot, expect, pwsh, powershell, sshpass, runuser, setpriv.
- AC4: For at least `keryx` and `timeout`, a NARROWING pattern is still offerable, asserted by a test, so the fix does not remove the capability the existing entries deliberately keep.
- AC5: The two frozen assertions at `src/lib/shell-permissions-hardening.test.ts:185` and `:233` are inverted, each carrying a comment stating what it asserted before and why that was wrong.
- AC6: Reverting the `PREFIX_BANNED` addition fails at least one named test for `keryx` and at least one for a wrapper; the report names them.
- AC7: `PREFIX_BANNED_READERS` and `PREFIX_BANNED_MUTATORS` are reviewed against the same corpus, and the report states either the additions made or that none are implied.
- AC8: No documentation or comment introduced by this flow claims the prefix list is a boundary; the existing "EXPEDIENT, not a boundary" framing survives, and the docs that describe saved permissions name the added words.
- AC9: `bun run check` and `bun run check:doc-links` pass, with no test skipped or weakened.
