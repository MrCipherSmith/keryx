# Review round 2 (FIX round) — flow 353, PR #773

- Round ref (head under review): `e0be2cfd6640612e5b65f3f557fce9ab41e69f42`
- Range reviewed (scope A): `origin/main..e0be2cfd6640612e5b65f3f557fce9ab41e69f42` (35 files, 1432 changed lines per `keryx review scope --json`)
- Delta actually reviewed line-by-line (this round's fix commit): `9a2bbf622058f83a34345c5ff5726c3fa7ba42fd..e0be2cfd6640612e5b65f3f557fce9ab41e69f42` — 11 files, 492 insertions / 13 deletions: `CHANGELOG.md`, `docs/docs/cli-reference.md`, `docs/requirements/keryx-audit-remediation/findings.md`, `src/cli.test.ts`, `src/cli.ts`, `src/commands/agent-commands.test.ts`, `src/commands/doctor.test.ts`, `src/commands/doctor.ts`, `src/lib/group-subcommands.ts` (new), `src/lib/suggest.test.ts`, `src/standard/command-registry.test.ts`.
- `is_fix_round: true`; prior round: `.metaproject/flows/353-2026-09-27-p0-w5-first-hour-keryx-doctor-did-you-me/reviews/2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd/`
- verification_mode: `filter`

## Prior findings — disposition at this head

| id | severity | disposition | evidence |
|---|---|---|---|
| L1 | blocker | **closed** (see Regressions below) | Central "did you mean" guard (`src/cli.ts` + new `src/lib/group-subcommands.ts`, 40 groups) now fires for every previously-broken example in the original finding's evidence. Re-ran verbatim at `e0be2cfd`: `keryx health rn` → `Unknown command: rn. Did you mean: run? Run \`keryx health --help\` for the list.` (was: full usage dump). Same for `wiki serach`, `memory serach` (→search), `auth logn` (→login), `flow lst` (→list), `providers staus` (→status), `skills isntall` (→install). One stderr line, empty stdout, exit 1, in every case. CHANGELOG's `[0.3.17]` entry was also narrowed to name exactly which ~38 groups are covered and why the rest are excluded — closes the finding's option (b) as well as (a). |
| L2 | blocker | **closed** | `bun test src/commands/agent-commands.test.ts src/standard/command-registry.coverage.test.ts src/standard/command-registry.test.ts` at `e0be2cfd` → 59 pass, 0 fail (was 5 fail at `9a2bbf62`). The stale fixtures (`AGENT_SLASH_COMMANDS`, `commandsForMode`, `filterCommands`, `CORE_COMMANDS`) were updated to include `/doctor`/`doctor`. |
| T1 | blocker | **closed** | `src/commands/doctor.ts` gained `DoctorTestOverrides.bunFloor`, threaded into `checkBun` from `buildDoctorReport`/`doctorCommand`. `doctor.test.ts` now has `"a real failing check (bun below an injected floor) sets \`status: \"fail\"\` in --json AND exits 1"` and a human-readable-path sibling, driving `doctorCommand` end-to-end (not the extracted `doctorFailed` predicate). `bun test src/commands/doctor.test.ts` → 16 pass, 0 fail. |
| T2 | info | **closed** | `src/lib/suggest.test.ts` gained `"edit distance exactly at the ceiling (2) still suggests"` (`"bui"` vs `"build"`, expects `["build"]`) and `"edit distance one past the ceiling (3) suggests nothing"` (`"bu"` vs `"build"`, expects `[]`). `bun test src/lib/suggest.test.ts` → 10 pass, 0 fail. |

A1 and S1 are **not re-verified this round** (out of scope per the operator's round-2 instructions); their dispositions are recorded directly against the round-1 package (see below) rather than through re-verification: A1 `dismissed-wont-fix` (matches repo convention; no runtime trigger), S1 `dismissed-deprioritised` (now tracked as `docs/requirements/keryx-audit-remediation/findings.md` row `S-11`, confirmed present in this diff).

## Regressions the fixes introduced

**[L1] → new finding L3 (blocker).** L1's fix is a central pre-dispatch guard in `src/cli.ts` (`knownSubcommandsFor`/`GROUP_SUBCOMMANDS`) that refuses `keryx <group> <sub>` whenever `<sub>` is not in that group's hand-verified subcommand list. `src/lib/group-subcommands.ts` includes `"integrate"` in that table with the enum `["cursor","claude","opencode","vscode","generic","all"]`. But `keryx integrate`'s real first positional is not a single-subcommand token — `parseEditors()` (`src/commands/integrate.ts:51-58`) explicitly comma-splits it so `keryx integrate cursor,claude` addresses two editors in one token, a documented, working, pre-existing invocation shape. The new guard checks the whole raw token (`"cursor,claude"`) against the enum, finds no match, and refuses the command before `integrateCommand` ever runs — breaking real, working usage that the module's own doc comment says it deliberately avoids doing ("a group is listed here only when its first positional argument is unambiguously a closed, literal subcommand vocabulary... guessing wrong would break real usage, not just a typo"). `integrate` slipped past that stated bar because a *single* editor name does satisfy it; the comma-joined multi-value shorthand does not. See L3 below for full reproduction.

## New findings (round 2, scope A + regression check)

1. **L3 (blocker, review-logic).** `keryx integrate cursor,claude` (and any comma-joined multi-editor invocation) is wrongly refused by the new central dispatch guard, at `e0be2cfd`. Confirmed regressed against `main` (`f2ee4c88`), where the identical invocation works and writes both `.cursor/mcp.json` and `.mcp.json`. See finding body in the `keryx:findings` block for full evidence and suggested fix.
2. **T3 (minor, review-testing-practices).** The new `cli.test.ts` coverage for the central guard (`describe("keryx <group> <unknown subcommand> (review round 1, L1)")`) only proves the *negative* case for all 40 groups (a nonsense token is refused) plus exactly two *positive* real-subcommand samples (`health status`, `wiki ask --help`). No test exercises a real subcommand shaped differently from "one bare word" — e.g. a comma-joined value, a value carrying its own `-` (there are none currently, but nothing pins that), or any of the other 38 groups' real subcommands beyond the two sampled. This is exactly the gap L3 fell through: a broader per-group positive-usage sweep (or, more cheaply, one assertion per group iterating a REAL subcommand the same way the negative test iterates `groupsWithKnownSubcommands()`) would have caught it.

## Sample-checked dispatch code (this round, in addition to round 1's own per-group `--help` verification)

Read the actual top-level dispatch function and compared it line-for-line against its `group-subcommands.ts` entry for: `review` (29 subcommands, `src/commands/review.ts:536-686`), `skills` (21, `src/commands/skills.ts:102-213`), `flow` (20, `src/commands/flow.ts:316-377`), `security` (13, `src/commands/security.ts:82-136`), `mcp` (derived from the exported `MCP_CONSUMER_SUBCOMMANDS` constant rather than a second hand-written list, `src/commands/mcp.ts` / `src/commands/mcp-servers.ts:62`), `routing` (6, `src/commands/routing.ts:363-400`), `version` (1, `src/commands/version.ts:17-23`). All match exactly except `integrate`, which is structurally the wrong shape for this table (see L3) rather than a transcription error.

## Blast radius

`keryx review blast-radius --ref "origin/main..e0be2cfd6640612e5b65f3f557fce9ab41e69f42" --json` (depth 2, cap 40, graph 2323 nodes/7574 edges) does **not** place `src/commands/integrate.ts` in the computed set — the graph edge from `cli.ts`'s dynamic `CLI_ROUTES`/`knownSubcommandsFor` dispatch to `integrate.ts` is not one `gdgraph affected` resolves. L3 was found by reading the changed dispatch code directly and by direct execution (`bun run src/cli.ts integrate cursor,claude --dry-run` on both `e0be2cfd` and `main`), not via the blast-radius walk. Filed under scope A (the changed file itself, `src/lib/group-subcommands.ts`), not scope B, for exactly this reason — its `class_scope.sites` names the caller that breaks, but its own `file` is the changed line.

```json keryx:findings
[
  {
    "id": "L1",
    "reviewer": "review-logic",
    "severity": "blocker",
    "problem": "AC3 states, without qualification, that 'an unknown command or subcommand prints one line ... to stderr with exit 1, never the full usage'. The round-1 diff only wired formatUnknownCommandMessage/suggestClosest into cli.ts and keryx mcp <sub>; every other group's 'unknown subcommand' branch still dumped its full usage.",
    "impact": "Typing e.g. `keryx health rn` still dumped the group's entire usage block and gave no 'did you mean' hint.",
    "suggested_fix": "Route every remaining site through formatUnknownCommandMessage the same way cli.ts/mcp.ts do, or narrow AC3/the CHANGELOG to name exactly which commands were covered.",
    "evidence": "Round 1 finding, reproduced verbatim at 9a2bbf62.",
    "confidence": "high",
    "file": "src/commands/health.ts",
    "line": 50,
    "class_scope": {
      "sites": [
        "src/commands/agents-external.ts:297", "src/commands/agents.ts:57", "src/commands/agents.ts:154",
        "src/commands/auth.ts:40", "src/commands/bundle.ts:73", "src/commands/bus.ts:125", "src/commands/ctx.ts:160",
        "src/commands/dashboard.ts:36", "src/commands/external.ts:154", "src/commands/flow.ts:369",
        "src/commands/forgetting.ts:50", "src/commands/gdgraph.ts:219", "src/commands/governance.ts:94",
        "src/commands/health.ts:50", "src/commands/hooks.ts:1275", "src/commands/integrations.ts:57",
        "src/commands/job.ts:89", "src/commands/memory.ts:94", "src/commands/metrics.ts:190",
        "src/commands/projects.ts:66", "src/commands/providers.ts:1330", "src/commands/retention.ts:97",
        "src/commands/review.ts:680", "src/commands/routing.ts:358", "src/commands/routing.ts:397",
        "src/commands/rules.ts:50", "src/commands/sandbox.ts:182", "src/commands/security-impact-evidence.ts:68",
        "src/commands/security.ts:135", "src/commands/serve.ts:172", "src/commands/serve.ts:486",
        "src/commands/serve.ts:650", "src/commands/sessions.ts:160", "src/commands/skills-governance.ts:137",
        "src/commands/skills.ts:210", "src/commands/skills.ts:1537", "src/commands/stack.ts:23",
        "src/commands/standard.ts:52", "src/commands/wiki.ts:112", "src/commands/workspace.ts:294",
        "src/commands/schedule.ts:192", "src/commands/trigger.ts:131"
      ],
      "enumeration_method": "Round-1 enumeration, carried forward unchanged; round 2 re-verified a 7-site sample by direct execution at e0be2cfd (see verifications)."
    },
    "reviewer_note": "re-reported for round-2 re-verification; content unchanged from round 1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#L1"
  },
  {
    "id": "L2",
    "reviewer": "review-logic",
    "severity": "blocker",
    "problem": "The PR wires /doctor into the agent-command registry but does not update the pre-existing expected-command-list fixtures (agent-commands.test.ts) or fully fix command-registry.test.ts, leaving PR #773's own CI ('typecheck-and-tests') red at the round-1 head.",
    "impact": "AC8 ('typecheck, lint and every touched test file pass') failing on the PR's own CI at the head under round-1 review.",
    "suggested_fix": "Update the hardcoded expected command lists to include /doctor in its correct registry position and fix command-registry.test.ts's well-formed check.",
    "evidence": "Round 1 finding, reproduced verbatim at 9a2bbf62.",
    "confidence": "high",
    "file": "src/commands/agent-commands.test.ts",
    "line": null,
    "class_scope": {
      "sites": [
        "src/commands/agent-commands.test.ts (AGENT_SLASH_COMMANDS + commandsForMode('agent') + filterCommands('/') expectations)",
        "src/standard/command-registry.test.ts ('every descriptor is well-formed')"
      ],
      "enumeration_method": "Round-1 enumeration, carried forward unchanged; round 2 re-ran the exact test files at e0be2cfd (see verifications)."
    },
    "reviewer_note": "re-reported for round-2 re-verification; content unchanged from round 1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#L2"
  },
  {
    "id": "T1",
    "reviewer": "review-testing-practices",
    "severity": "blocker",
    "problem": "AC1 requires a test covering both the JSON shape and the exit codes (plural). doctor.test.ts's CLI describe block only ever produced an all-ok/warn report; the exit-1 path was only unit-tested against the extracted, synthetic-input doctorFailed(report) predicate, never through doctorCommand itself.",
    "impact": "A regression in doctorCommand's exit-code wiring, or in any single check's fail/warn condition, would not be caught by the suite as it stood.",
    "suggested_fix": "Add a doctor.test.ts case that forces a real fail through doctorCommand/buildDoctorReport and asserts process.exitCode === 1 and the failing check's status.",
    "evidence": "Round 1 finding, reproduced verbatim at 9a2bbf62.",
    "confidence": "high",
    "file": "src/commands/doctor.test.ts",
    "line": null,
    "class_scope": {
      "sites": [
        "src/commands/doctor.ts: doctorCommand (process.exitCode = 1 wiring, unreached at round 1)",
        "src/commands/doctor.ts: checkMcp/checkStandard/checkBun/checkProviders and every other check's non-ok branch (unreached at round 1)"
      ],
      "enumeration_method": "Round-1 enumeration, carried forward unchanged; round 2 confirmed the new DoctorTestOverrides.bunFloor seam now drives doctorCommand end-to-end (see verifications)."
    },
    "reviewer_note": "re-reported for round-2 re-verification; content unchanged from round 1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#T1"
  },
  {
    "id": "T2",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "problem": "AC3's edit-distance-2 cutoff is tested with a typo well beyond the boundary and one well within it, but no test pins the exact boundary (distance exactly 2 vs. exactly 3 from the same base word).",
    "impact": "A future off-by-one in MAX_EDIT_DISTANCE's comparison operator would not be caught by this suite.",
    "suggested_fix": "Add a boundary-pinning case: two candidates differing from the input by exactly 2 and exactly 3 edits.",
    "evidence": "Round 1 finding, reproduced verbatim at 9a2bbf62.",
    "confidence": "medium",
    "file": "src/lib/suggest.test.ts",
    "line": null,
    "reviewer_note": "re-reported for round-2 re-verification; content unchanged from round 1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#T2"
  },
  {
    "id": "L3",
    "reviewer": "review-logic",
    "severity": "blocker",
    "problem": "The round-1 fix for L1 adds a central pre-dispatch 'unknown subcommand' guard in src/cli.ts (main()), driven by src/lib/group-subcommands.ts's GROUP_SUBCOMMANDS map. That map includes the 'integrate' group with the closed enum [cursor, claude, opencode, vscode, generic, all] -- the individual editor names commands/integrate.ts's EDITOR_USAGE documents. But commands/integrate.ts's own parseEditors() (lines 51-58) explicitly treats the first positional as a comma-splittable LIST, not a single closed-vocabulary token: 'keryx integrate cursor,claude' is a documented, pre-existing, working invocation that addresses two editors in one call. The new cli.ts guard checks the raw token 'cursor,claude' against the per-editor enum, finds no exact match, and refuses the command with 'Unknown command: cursor,claude...' before integrateCommand ever runs -- breaking a real, currently-working invocation. This is exactly the failure mode group-subcommands.ts's own module doc warns against ('a group is listed here only when its first positional argument is unambiguously a closed, literal subcommand vocabulary... guessing wrong would break real usage, not just a typo') -- 'integrate' does not actually meet that bar for its multi-value form, even though a single editor name does.",
    "impact": "`keryx integrate cursor,claude`, `keryx integrate cursor,claude,vscode`, and any other comma-joined multi-editor invocation of `keryx integrate` now exits 1 with 'Unknown command: <the whole comma list>. Run `keryx integrate --help` for the list.' and writes NO client config, instead of installing the MCP client config for every named editor. Confirmed as a genuine regression: the identical invocation works correctly on `main` (f2ee4c88) before this fix commit, writing both `.cursor/mcp.json` and `.mcp.json` under `--dry-run`.",
    "suggested_fix": "Remove `integrate` from GROUP_SUBCOMMANDS in src/lib/group-subcommands.ts (its first positional is a data payload -- one or more editor names -- not a closed subcommand vocabulary, matching the module's own stated exclusion criteria alongside orient/sync/harness/commands/skill-verify-skill), OR make the cli.ts guard comma-aware for this one group before checking membership (split `sub` on ',' and require every part to be in `known`). The former is smaller and matches the module's documented design; the guard's 'unknown subcommand' message for a genuinely bad editor name (`keryx integrate bogus`) still needs to keep working through integrateCommand's OWN existing error path (commands/integrate.ts does not appear to have one currently for an unrecognized editor -- worth checking as part of the fix, but out of scope for this finding, which is about the wrong REFUSAL, not about what happens after a real fix removes it).",
    "evidence": "bun run src/cli.ts integrate cursor,claude --dry-run at e0be2cfd (worktree /home/altsay/keryx-w5) -> stdout empty, stderr 'Unknown command: cursor,claude. Run `keryx integrate --help` for the list.', exit 1. Identical invocation at main (f2ee4c88, /home/altsay/keryx) -> writes .cursor/mcp.json and .mcp.json dry-run previews, exit 0. src/commands/integrate.ts:51-58 (parseEditors) confirms the comma-split is intentional, documented behaviour, not an accident. src/lib/group-subcommands.ts:182 confirms 'integrate' -> [cursor, claude, opencode, vscode, generic, all]. src/cli.ts:314-320 confirms the guard's membership check (`!known.includes(sub)`) operates on the raw, unsplit token.",
    "confidence": "high",
    "file": "src/lib/group-subcommands.ts",
    "line": 182,
    "quote": "[\"integrate\", [\"cursor\", \"claude\", \"opencode\", \"vscode\", \"generic\", \"all\"]],",
    "class_scope": {
      "sites": [
        "src/commands/integrate.ts:51-58 (parseEditors, the caller whose comma-list contract breaks)",
        "src/cli.ts:314-320 (the guard that wrongly refuses it)"
      ],
      "enumeration_method": "Read commands/integrate.ts end to end after noticing group-subcommands.ts's 'integrate' entry looked structurally different from every other entry (a data value drawn from a closed set, joinable, vs. a single verb); confirmed by direct execution on both branches."
    }
  },
  {
    "id": "T3",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "cli.test.ts's new coverage for the central 'unknown subcommand' guard (describe block for review round 1 L1) proves the negative case (a nonsense token is refused) for all 40 groups via groupsWithKnownSubcommands(), but only two positive real-subcommand invocations are exercised ('keryx health status', 'keryx wiki ask --help'), and neither uses a value shaped any differently from a single bare word.",
    "impact": "A group whose real first-positional shape is not 'one bare word from the enum' -- as `integrate`'s comma-joined editor list turned out to be -- has no test proving the guard does not wrongly refuse it. This is the exact gap L3 fell through.",
    "suggested_fix": "Add, per group in GROUP_SUBCOMMANDS, at least one assertion that a REAL subcommand/positional (not just the two hand-picked samples) is not rejected as 'Unknown command' -- and specifically a case for `integrate` exercising its comma-joined form once the L3 fix lands.",
    "evidence": "Read src/cli.test.ts's full 'keryx <group> <unknown subcommand> (review round 1, L1)' describe block (lines ~286-330 at e0be2cfd): one test.each over all 40 groups for the negative case, and exactly one test naming two groups for the positive case.",
    "confidence": "high",
    "file": "src/cli.test.ts",
    "line": 322,
    "quote": "test(\"a real subcommand of a checked group is unaffected (`keryx health status`, `keryx wiki ask`)\", async () => {",
    "class_scope": {
      "sites": ["src/cli.test.ts:286-330"],
      "enumeration_method": "Full read of the describe block introduced by round 1's L1 fix."
    }
  }
]
```
