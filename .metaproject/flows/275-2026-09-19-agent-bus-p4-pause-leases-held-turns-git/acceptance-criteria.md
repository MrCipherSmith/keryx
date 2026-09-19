# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: createPauseLease writes the lease file and its pause-request event under one append.lock hold, with targets never including the holder (@all stored as ["*"]), a default TTL of 30 minutes and a maximum of 4 hours (ttl-out-of-range beyond), one active lease per holder (lease-already-held) and at most one active CLI-origin lease per clone; proven by tests.
- AC2: A lease ends on resume by its holder or by an operator outside a tool call (resume event written, file deleted; anyone else is refused not-lease-holder), on expiry, or when its holder is gone, in which case exactly one lease-expired event is written even with several observers; a stale holder keeps its lease; proven by tests.
- AC3: /bus override <leaseId> by a targeted instance writes an override event and releases only that instance, leaving the lease active for other targets; proven by tests.
- AC4: While a turns lease applies to it (not overridden), a TUI instance starts no new main-agent turn from an operator line, /queue force, a task-notification wake or a bus wake, dispatches no side worker for busy lines, keeps the operator lines queued, allows /bus, and shows a banner with holder, reason and remaining TTL; when the lease ends the held lines run; proven by tests.
- AC5: While a turns lease applies, readline prints a held notice for an operator line and does not start a turn, and runs the held line once the lease ends; proven by tests.
- AC6: isPublishCommand matches git push, git tag with push, gh release, gh pr merge, npm publish and bun publish; while a git-publish lease applies, such a shell_exec command resolves to ask in ask, trust and auto modes (the publishLease floor sits after the readOnly deny and never denies on its own), a saved or session allowlist pattern does not auto-approve it, and the prompt names the lease and offers no always-allow; without the lease behaviour is unchanged; proven by tests.
- AC7: bus_pause (risk write) creates and resumes leases, prompts in ask mode, runs without a prompt in trust and auto, is denied in /plan, refuses lease-already-held, ttl-out-of-range and not-lease-holder by name, and is never offered to subagents, external children or side workers; the executeCall write branch applies classifyPatchRisk only to apply_patch; proven by tests.
- AC8: `keryx bus pause` and `keryx bus resume` work from a terminal, refuse use-agent-tool when KERYX_TOOL_CALL=1, respect the clone-wide CLI lease limit, and are registered in the command registry, help and cli-reference; proven by tests including the coverage tests.
- AC9: On a clean exit the bus client resumes every lease its instance holds (resume events written, files removed); proven by tests.
- AC10: The agent-protocol §2 conduct text (what to do under turns, git-publish and advisory leases, and on resume) is in the system prompt only when the bus is joined; proven by tests.
- AC11: A subprocess test shows: shell A's /bus pause @all with scope turns holds shell B's next operator line until A's /bus resume, B's /bus override releases B early, SIGKILL of A yields exactly one lease-expired, and a git-publish lease from A makes git push in B require approval under auto mode.
- AC12: typecheck, lint and the full test suite are green in CI on the PR head.
- AC13: The keryx-agent-bus package README, implementation-plan.md and the roadmap row state P0–P4 implemented with flow and PR references and P5 not implemented.
