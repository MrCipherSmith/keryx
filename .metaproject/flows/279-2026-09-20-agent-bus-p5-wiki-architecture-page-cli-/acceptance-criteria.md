# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A wiki page `architecture/agent-bus.md` exists, is reachable from the wiki index, and states the store layout under the git common dir, the event log's append-under-lock and crash-safe seq, presence with the D-09 liveness rule (live/stale/gone), delivery to the agent at the three drain sites, pause leases with their three scopes, and the trust boundary that a peer message is data and never an instruction; `keryx wiki validate` passes.
- AC2: The wiki page cross-references RP-08 rather than restating it, and names D-01 as the reason the two ledgers stay separate.
- AC3: `docs/cli-reference.md` documents every `keryx bus` subcommand — list, log, send, prune, pause, resume — with its flags, its refusals by name (use-agent-tool under KERYX_TOOL_CALL, lease-already-held, ttl-out-of-range, not-lease-holder, recipient-is-self, unknown-recipient, recipient-not-live) and the clone-wide CLI rate limit; the coverage test that pairs the command registry with the reference passes.
- AC4: PRD scenario 1 passes end to end on a real clone with two worktrees and is recorded as evidence in this flow: A pauses B's publishing with scope git-publish, B's git push then requires approval under auto mode, A resumes, and B's push no longer requires it. The evidence records the commands run, the observed output and the bus event ids.
- AC5: PRD scenario 2 passes end to end on the same clone and is recorded the same way: A sends B a message, it reaches B as a bus message with tool provenance, B replies, and A sees the reply.
- AC6: The evidence is reproducible from what is written down, and every step that cannot be reproduced without a model provider or without a human at a prompt says so explicitly instead of being presented as reproducible.
- AC7: The keryx-agent-bus package README, implementation-plan.md and the roadmap row state P0-P5 implemented with flow and PR references, and the package lists no unimplemented phase.
- AC8: typecheck, lint and the full test suite are green in CI on the PR head.
