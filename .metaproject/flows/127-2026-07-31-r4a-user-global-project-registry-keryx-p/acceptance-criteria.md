# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The registry is stored in the existing user-global config directory (the one holding `auth.json`), resolved cross-platform by the same logic, and is created with owner-only permissions.
- AC2: `keryx init` registers the project it initializes. Running it again on the same path updates the existing record and never creates a second entry for one path.
- AC3: A registry entry carries addressing only — opaque id, absolute path, display name, state, timestamps, and a reserved transport-binding list. A test asserts that a serialized registry contains no credential-shaped field.
- AC4: A registered project whose path no longer exists is reported with state `missing` rather than being deleted; nothing removes an entry except an explicit operator action.
- AC5: `keryx projects list` renders the registry for a human and `keryx projects list --json` emits deterministic machine-readable output, sorted so two runs on unchanged state are byte-identical.
- AC6: `keryx projects register <path>` adds a project explicitly and is idempotent; `keryx projects forget <id>` removes exactly one entry and leaves the rest untouched.
- AC7: Registering a path that is not an initialized keryx project is refused with a stated reason, so the registry cannot fill with directories that have no `.metaproject/`.
- AC8: A corrupt or unreadable registry file never breaks `keryx init` or any other command: it degrades to an empty registry with a warning, and a subsequent write repairs it rather than propagating the corruption.
- AC9: Concurrent registration from two processes does not lose an entry or leave a partially written file.
- AC10: The registry is added to the command descriptor registry with honest `read`/`model` flags, so the new commands are visible to the coverage guard rather than becoming its first exception.
- AC11: `bunx tsc --noEmit` is clean, `bun test` is green with no reduction from the pre-change baseline, both the touched files alone and the full suite exit 0, and `keryx health run` reports a passing gate.
- AC12: `keryx init` behaviour is otherwise unchanged: an init that cannot write the registry still initializes the project and reports the registry failure separately.
