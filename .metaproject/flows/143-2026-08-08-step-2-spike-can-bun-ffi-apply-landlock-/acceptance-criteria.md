# Acceptance Criteria

- AC1: The Landlock ABI version is queried successfully from a Bun process through
`bun:ffi` (`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`),
returning the ABI already measured on this host by other means (4).

- AC2: From `bun:ffi`, a ruleset is created with filesystem access types handled,
allow-rules are added for specific path hierarchies via `landlock_add_rule`,
`prctl(PR_SET_NO_NEW_PRIVS, 1)` is set, and `landlock_restrict_self` succeeds.

- AC3: The restriction is enforced in a real exec'd command: a read and a write
inside an allowed hierarchy succeed, and a read and a write outside it are
denied with EACCES. The allowed and denied directories are comparable (same
owner, same mode, same parent) so that DAC cannot explain the difference.

- AC4: The restriction is inherited by a grandchild process — the contained
command spawns another process, which is still restricted.

- AC5: Per-command overhead is measured by ADR-0010's method (wall clock over N
runs of `/bin/echo`, mean per command) on the same host, alongside the baseline
and bubblewrap figures in the same run so they are comparable.

- AC6: Whether the ABI-4 TCP restriction (`LANDLOCK_ACCESS_NET_BIND_TCP` /
`LANDLOCK_ACCESS_NET_CONNECT_TCP`) is reachable by the same mechanism is
reported, with a negative control proving the test measures the restriction and
not an unrelated failure. The finding does not contradict specification §4.3:
this is TCP-only and is not equivalent to network-off.

- AC7: A written finding is committed stating plainly: does `bun:ffi` carry it
yes or no; the measured overhead; what surprised us; and what Step 3's
implementer must know. If the answer is no, the compiled-helper alternative is
costed (per-architecture binaries, build step, distribution).

- AC8: The proof-of-concept is self-contained under
`docs/requirements/keryx-linux-containment/spike/` and is NOT wired into
`src/harness/process/sandbox/`. The repository typecheck and the existing test
suite are unaffected.
