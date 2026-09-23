# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every agent-facing command descriptor for a command that flows 287 to 293 changed — `trigger` (run, list, status, schedule, install, uninstall, resolve), `flow` (init, owner set, ac confirm, ac update, ac reseal, complete, status), `acp`, `serve-mcp`, `agents external`, and `governance` — describes that command as 0.2.155 actually behaves; in particular `trigger run` no longer says open-flow and flow-next refuse, and no descriptor names the old `.metaproject/data/trigger/.run.lock` path.
- AC2: Commands added by those flows that an agent should be able to discover have a descriptor or a reasoned exclusion (for example `trigger resolve`, `flow owner set`), and the command-registry coverage test stays green.
- AC3: A test pins the corrected `trigger run` description against the behaviour the trigger help states, so the two cannot drift apart again unnoticed.
- AC4: CI is green on the PR and `keryx health run` gate is pass.
- AC5: Top-level `--help` for a command group whose handler has its own help — at least `flow`, `trigger`, `serve-mcp`, `governance` and `agents external` — lists every subcommand that group has, instead of a shorter stale usage block; a test compares each intercepted help against the handler's own help so a new subcommand cannot be missing from it.
