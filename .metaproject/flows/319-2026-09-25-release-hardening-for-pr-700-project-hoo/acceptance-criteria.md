# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: An untrusted project `.metaproject/hooks.json` executes none of its command hooks (sandboxed or unsandboxed) in `keryx shell`, ACP, serve, trigger dispatch or child agents; a regression test reproducing the review probe (SessionStart hook touching a file) fails on the pre-fix code and passes after the fix.
- AC2: Project hook trust is recorded outside the repository, keyed to the project path and a content digest of the hooks file; any change to the executable content revokes trust (test), and a corrupt or missing trust store grants nothing (test).
- AC3: `keryx shell` names untrusted project hooks at session start and points to `keryx hooks trust`; `keryx hooks trust` shows every command (flagging unsandboxed ones) before recording trust, `keryx hooks untrust` withdraws it, and `keryx hooks list` shows the trust state; non-interactive surfaces never auto-trust or prompt.
- AC4: Built-in hooks and user-scope hooks keep working with no trust step (test).
- AC5: A project-scope attempt to disable or weaken a built-in security gate is ignored with a warning shown at session start, while the rest of the config loads; user scope can disable a built-in gate only with an explicit acknowledgement, and a disabled gate is announced at session start (tests).
- AC6: The learning observer and impact-evidence state write through contained helpers that refuse symlink escapes; the review's symlink probe writes nothing outside the project (tests); the observer's default-on decision is recorded in the journal and documented in docs/docs/learning.md.
- AC7: `hooks enable/disable` write through contained helpers, `hooks disable` is no longer an agent-callable registry command, and every writer listed in R700-04 is either covered by the contained-write ratchet or named in its exemption list with a reason.
- AC8: `keryx update` run twice on an unchanged repo leaves no diff (install-state timestamps stable), and stocktake reports/cache are gitignored by the managed block (tests).
- AC9: `keryx skills --help`, `keryx memory --help` and `keryx security --help` list all subcommands; usage lines include `--allow-hooks`, `--surface`, `--force`; the `agents` summary covers the catalog; the `integrations` vs `/integrations` naming is resolved or cross-referenced; a coverage test guards the subcommand listing.
- AC10: No internal program labels (flow numbers, W-numbers, AC codes) appear in user-facing seeded files, the managed `.gitignore` block or help/messages touched by this flow; `update` replaces the old managed block without duplicating it (test).
- AC11: Imported learned patterns reset TTL, reset or cap confidence and record import provenance (test); team-scope local-only behaviour is documented and its git sharing deferred with a reason.
- AC12: The stale `keryx mcp serve` message reads `keryx serve-mcp --harness <id>` and `containFromMetaprojectPath` uses the last `.metaproject` segment (test).
- AC13: The review's 12-step manual test plan is re-run in a scratch repo with the flow's CLI, step 12 (blocker probe) passes, and the results are recorded in the journal.
