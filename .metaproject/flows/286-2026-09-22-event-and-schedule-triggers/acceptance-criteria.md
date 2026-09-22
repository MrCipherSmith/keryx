# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A project declares triggers in a validated config: each entry names what fires it (a repository event or a schedule) and what it does; an entry that is malformed is refused on load with the reason, and the other entries still work.
- AC2: `keryx trigger run <name>` performs exactly one pass of that entry's action and exits non-zero only when the action itself failed; a run with nothing to do exits zero and says so.
- AC3: A second `keryx trigger run` for the same project, started while the first is still running, does not corrupt the graph, wiki or session store: it either waits for the same lock the interactive commands take, or refuses with a clear reason, and a test drives both concurrently.
- AC4: Every fired trigger is recorded — what fired it, when, what it did, and what it cost when a model was used — and `keryx trigger status` reads that record rather than re-deriving it.
- AC5: `keryx trigger install` extends the existing hook installation instead of replacing it: after install, `keryx sync install-hooks`'s behaviour on `post-merge` and `post-checkout` still happens, and a project that had hooks keeps them.
- AC6: For a schedule, keryx prints the cron line or the systemd timer unit to install and does not run a daemon of its own; the printed line is exercised by a test that runs it as the scheduler would.
- AC7: A trigger whose action opens a flow can be declared not to open a second one while an equivalent flow is already open, and a test proves the second firing is a no-op with a stated reason.
- AC8: A triggered run that would exceed the configured spend ceiling stops with a budget refusal recorded as its outcome, not as a crash.
- AC9: README and the CLI reference document the trigger config, the commands, and the fact that scheduling is delegated to the operator's own scheduler.
- AC10: CI is green on the PR and `keryx health run` gate is pass.
