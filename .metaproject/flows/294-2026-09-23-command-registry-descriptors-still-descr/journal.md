# Flow Journal

- 2026-09-23T05:19:01.189Z - flow created
- 2026-09-23T05:19:12.390Z - frozen: 4 criteria; checksum recorded
- 2026-09-23T05:19:12.638Z - started
- 2026-09-23T05:19:12.888Z - task-added: T5: Audit and correct the command registry descriptors for flows 287-293
- 2026-09-23T05:19:13.125Z - task-added: T6: Verification: CI green, keryx health run
- 2026-09-23T05:19:13.368Z - task-attempt: T5: started (attempt 1)
- T5 (subagent report): audited every command-registry.ts descriptor for trigger (run, list, status,
  schedule, install, uninstall, resolve), flow (init, owner set, ac confirm, ac update, ac reseal,
  complete, status), acp, serve-mcp, agents external (list, probe, run), and governance (report, show)
  against `bun run src/cli.ts <verb> --help` / bare-verb help output and docs/docs/cli-reference.md.
  Fixed `trigger run`'s stale summary/sideEffects (dropped the false "open-flow/flow-next refuse
  cleanly" claim and the retired `.metaproject/data/trigger/.run.lock` path; now describes reconcile/
  rebuild/open-flow/flow-next incl. unattended dispatch, and the current `.metaproject/data/.locks/`
  shared maintenance lock). Added descriptors for commands flows 286-293 added with none: trigger list,
  trigger status, trigger schedule, trigger install, trigger uninstall, trigger resolve, flow init,
  flow status, flow owner set, flow ac confirm, flow ac update, flow ac reseal, flow complete, agents
  external list, agents external probe. Recorded a reasoned exclusion comment for `agents external run`
  (spends operator quota, same reasoning as the `harness` exclusion) directly above the `agents
  external list`/`probe` entries in command-registry.ts. Left `acp` and `serve-mcp` excluded as-is
  (EXCLUSIONS reasons still hold) and confirmed `governance report`/`show` descriptors already match
  current behaviour, no change needed. Added an AC3 test in command-registry.coverage.test.ts that
  captures `triggerCommand(["--help"])`'s real output and pins the `trigger run` descriptor against it
  (no refusal claim, no stale lock path, mentions dispatch), so the two cannot drift apart again
  unnoticed. Verified: command-registry.coverage.test.ts, command-registry.test.ts,
  cli-reference-coverage.test.ts, intent-matching.test.ts, sandbox/providers.cross-family/version/
  gdskills/config-dir/wiki-freshness-op tests referencing the registry — all green; `bun run typecheck`
  clean; `bunx eslint` clean on both changed files; `keryx health run` PASS (score 94).
- 2026-09-23T05:28:50.611Z - ac-updated: AC5: "(new)" -> "Top-level `--help` for a command group whose handler has its own help — at least `flow`, `trigger`, `serve-mcp`, `governance` and `agents external` — lists every subcommand that group has, instead of a shorter stale usage block; a test compares each intercepted help against the handler's own help so a new subcommand cannot be missing from it." (Found while fixing the registry: keryx trigger --help printed only 'run', hiding list, status, schedule, install, uninstall and resolve, because src/cli.ts intercepts --help with a stale USAGE_BODY block. Same class of drift as AC1.)
- T5b (subagent report, AC5 + small extra): confirmed `src/cli.ts`'s `USAGE_BODY` is the single
  constant behind BOTH the top-level bare `keryx --help` banner and `groupUsage()`'s per-group
  interception slice — the same stale copy fed both surfaces. For `flow`/`trigger`/`serve-mcp`/
  `governance`, exported each handler's own help function (`printFlowHelp` in commands/flow.ts,
  `printTriggerHelp` in commands/trigger.ts, `printGovernanceHelp` in commands/governance.ts;
  `printServeMcpHelp` in commands/serve-mcp.ts was already exported) and added a `RICH_GROUP_HELP`
  map in cli.ts: when `--help`/`-h` is requested for one of these groups, main() still fully
  intercepts (no mutating subcommand handler ever sees the flag — verified `trigger install --help`
  does NOT install) but now calls the real handler's help function instead of `groupUsage`'s stale
  slice. Did NOT add these groups to `DEEP_HELP_GROUPS` (the other existing mechanism): that would
  let `--help` reach the subcommand handler unintercepted, and most of `trigger`'s and `flow`'s
  subcommand functions (e.g. `trigger install/uninstall/list/status/resolve`) have no `--help` guard
  of their own, so `trigger install --help` would have actually run the install — confirmed this
  would regress by testing it before choosing the map approach instead. `agents external` needed no
  code change (`agents` was already a DEEP_HELP_GROUPS entry and every one of its subcommands guards
  `--help` itself), only a test. Checked the top-level bare `keryx --help` banner: it is intentionally
  one example line per verb (every other verb in USAGE_BODY follows the same one-liner convention,
  and the existing cli-reference-coverage.test.ts only asserts each verb NAME appears, never every
  subcommand) — concluded that part is not "stale" in the AC5 sense and left it as-is; the actual bug
  was `groupUsage()` standing in for a group's OWN help. Added AC5 tests to src/cli.test.ts
  (describe block "AC5: a group's top-level --help lists every subcommand its handler dispatches"):
  derives the expected subcommand set from each handler's real dispatch table (`switch`/`case` and
  `=== "x"` comparisons, brace-matched to the specific dispatch switch/function so unrelated inner
  switches like `resume.kind`/`resolution.kind` are excluded, and nested dispatch like `flow owner
  set`/`flow ac confirm`/`flow task done` expanded to the two-word phrase rather than a bare token —
  a bare "set" or "add" passed even with the whole nested line deleted, since those words already
  occur in unrelated prose; caught and fixed this false negative by deliberately deleting the `owner
  set` help line, confirming the new test failed, then restoring it and confirming green again) and
  spawns the real CLI to assert every one appears in the group's `--help` output; plus a regression
  test that `trigger install --help` still does not install. Small extra: `flow ac update <id>
  --criterion ACn --text …` printed "ACn rewritten" even when ACn was the next-unused criterion and
  the call APPENDED a new line rather than replacing one. Fixed in commands/flow.ts's `runAc` "update"
  branch: reads the known-criteria list via the already-exported `readAcCriteria`/`resolveFlowDir`
  (src/flow/store.ts) BEFORE calling `acUpdate`, to learn whether `--criterion` was already known, and
  prints "appended" instead of "rewritten" when it was not — done without widening `FlowService.acUpdate`'s
  `Promise<FlowState>` return type, which several existing tests (service.test.ts, signatures.test.ts)
  depend on staying exactly that shape. Added two tests to src/flow/ac-strict-args.test.ts asserting
  the printed word for both cases (rewrite an existing AC1, append a new AC2). Verified: `bun test
  src/cli.test.ts src/cli-reference-coverage.test.ts src/standard/command-registry.coverage.test.ts
  src/standard/command-registry.test.ts src/flow/ac-strict-args.test.ts src/flow/owner-status-cli.test.ts
  src/flow/renumber-reviews.e2e.test.ts src/flow/depends-and-attempts.test.ts
  src/flow/review-gate.e2e.test.ts src/commands/trigger.test.ts` — 106 pass / 0 fail; `bun test
  src/flow/` (whole module) — 297 pass / 0 fail; `bun run typecheck` clean; `bunx eslint` clean on
  every changed file; `keryx health run` PASS (score 94).
- 2026-09-23T05:40:19.015Z - task-done: T5: Audit and correct the command registry descriptors for flows 287-293
