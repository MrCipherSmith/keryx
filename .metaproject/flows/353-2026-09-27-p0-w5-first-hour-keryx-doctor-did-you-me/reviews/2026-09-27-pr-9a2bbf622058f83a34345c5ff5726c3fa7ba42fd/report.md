# Managed Review Round 1 — PR #773 (flow 353)

- Repo: MrCipherSmith/keryx
- Branch: `feat/p0-w5-first-hour` (worktree `~/keryx-w5`)
- Base: `origin/main` @ `f2ee4c8896dde3402c57a8c8544f75544289d0b2`
- Head reviewed: `9a2bbf622058f83a34345c5ff5726c3fa7ba42fd` (PR #773 head, confirmed via `gh pr view 773`)
- Flow: 353 (attached)
- Round: 1 (first review round for this PR; is_fix_round: false)
- Mode: diff, scope A (35 files, 1432 changed lines, 0 dropped by pre-filter) + scope B (blast-radius, depth ≤2, 40 files, first-round computation)
- External PR comments: collected, 0 found (`keryx review comments collect --pr 773 --sha 9a2bbf62...`)
- CI at time of review: `typecheck-and-tests` job RED (5 failing tests) — see finding L2

## Reviewers dispatched

| Reviewer | Wave | Status | blocker/major/minor/info |
|---|---|---|---|
| review-logic | A | DONE_WITH_CONCERNS | 2/0/0/0 |
| review-architecture | A | DONE | 0/0/0/1 |
| review-security-code | A | DONE | 0/0/0/1 |
| review-testing-practices | B | DONE_WITH_CONCERNS | 1/0/0/1 |
| review-regression (scope B) | B | DONE | 0/0/0/0 |
| review-verifier | C | (see verification section) | — |

Skipped: review-frontend / review-frontend-conventions / review-backend / code-mobx-store-review (stack scoping: no react/mobx/nestjs/prisma detected — `keryx review stack --json`); review-core-boundaries / review-flow-graph (path gate: no `src/core/**` file in scope A).

## Findings

### Blockers

**[L1]** `src/commands/health.ts` (+ ~38 other `src/commands/*.ts` sites) — AC3 ("an unknown command or subcommand ... never the full usage") is wired up at only 2 of the sites that need it: the top-level `cli.ts` dispatch and `keryx mcp <sub>`. Every other subcommand group still dumps its full usage block on an unknown subcommand with no "did you mean" suggestion, contradicting both AC3's general wording and the PR's own CHANGELOG claim ("An unknown command or subcommand no longer dumps the full usage block"). Full site list in the finding's `class_scope`. — *review-logic*

**[L2]** `src/commands/agent-commands.test.ts` / `src/standard/command-registry.coverage.test.ts` — Adding `/doctor` to the command registry broke 5 existing tests on PR #773's own CI (`typecheck-and-tests`, run 36346344627): the expected-command-list fixtures in `agent-commands.test.ts` (not touched by this diff) and `command-registry.coverage.test.ts` (touched, but still broken) were not updated. This is AC8 ("typecheck, lint and every touched test file pass") failing at the exact head SHA under review, contradicting the PR body's own claim. — *review-logic (Stage-1 spec-compliance gate)*

**[T1]** `src/commands/doctor.test.ts` — AC1 requires a test covering "the JSON shape and the exit codes" (plural). `doctor.test.ts` only unit-tests the extracted `doctorFailed` predicate against synthetic data; no fixture drives `doctorCommand` itself to a real `fail` status / `exitCode === 1`. A regression in the exit-code wiring or any check's fail/warn branch would not be caught. — *review-testing-practices*

### Info

**[A1]** `src/commands/doctor.ts` — imports two functions directly from sibling command files rather than through a shared facade; consistent with pervasive pre-existing convention in this codebase (`src/commands/*` is not a facade-governed zone). No action needed. — *review-architecture*

**[S1]** `src/mcp-servers/compat.ts` (pre-existing, out of diff) — `parseGrokToml` echoes raw, unredacted TOML value text (e.g. a bearer token in an inline-table `headers` field) into problem messages for unsupported TOML forms. This PR's new `mcp list --json` `warnings` block, `mcp doctor`, and the `/mcp` TUI panel all print this unfiltered. Not introduced by this PR, but newly given a permanent, documented, always-exit-0 identity that may get treated as inert noise. Recommend a follow-up ticket. — *review-security-code*

**[T2]** `src/lib/suggest.test.ts` — edit-distance-2 boundary is not pinned exactly (only "clearly within"/"clearly beyond" cases tested). — *review-testing-practices*

### Regressions the fixes introduced

N/A — this is round 1, not a fix round.

### Withdrawn findings

N/A — round 1, no prior findings exist.

## Verification (Wave C)

See `keryx:verifications` block and verifier summary appended after dispatch.

```json keryx:findings
[
  {
    "id": "L1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#L1",
    "severity": "blocker",
    "file": "src/commands/health.ts",
    "line": null,
    "quote": "console.error(`Unknown health command: ${command}`);\n  printHelp();\n  process.exitCode = 1;",
    "problem": "AC3 states, without qualification, that 'an unknown command or subcommand prints one line ... to stderr with exit 1, never the full usage', with suggestions 'over the known commands (and subcommands of the parent group)', and the PR's own CHANGELOG entry claims this generally: 'An unknown command or subcommand no longer dumps the full usage block.' The diff only wires formatUnknownCommandMessage/suggestClosest (src/lib/suggest.ts) into two call sites: the top-level cli.ts dispatch and keryx mcp <sub> (src/commands/mcp.ts). Every other CLI subcommand group's 'unknown subcommand' branch is untouched and still executes the pre-PR pattern: one error line followed immediately by that group's full print*Help() usage dump, then process.exitCode = 1 — i.e. still the literal defect AC3/backlog-item-4 describe, and with no 'did you mean' suggestions at all.",
    "impact": "Typing e.g. `keryx health rn`, `keryx wiki serach`, `keryx memory serach`, `keryx auth logn`, `keryx flow lst`, `keryx providers staus`, `keryx skills isntall`, etc. still dumps the group's entire usage block (often several KB) to the console on an error path and gives the operator no 'did you mean' hint — the same UX/noise defect this flow's own CHANGELOG says is fixed for 'an unknown command or subcommand' in general.",
    "suggested_fix": "Either (a) route every remaining site through formatUnknownCommandMessage(sub, <that group's known subcommands>, 'keryx <group> --help') the same way cli.ts/mcp.ts now do, and drop the trailing print*Help() call on that path; or (b) narrow AC3's wording and the CHANGELOG entry to say exactly which commands were covered, so the acceptance criterion and release notes stop asserting a CLI-wide fix that was not shipped.",
    "evidence": "git grep -n \"Unknown .*command\" -A2 -- src/commands/*.ts (excluding *.test.ts) in ~/keryx-w5 shows the unchanged console.error(...); print*Help(); process.exitCode = 1; pattern still present in at least 38 files (agents-external.ts, agents.ts x2, auth.ts, bundle.ts, bus.ts, ctx.ts, dashboard.ts, external.ts, flow.ts, forgetting.ts, gdgraph.ts, governance.ts, health.ts, hooks.ts, integrations.ts, job.ts, memory.ts, metrics.ts, projects.ts, providers.ts, retention.ts, review.ts, routing.ts x2, rules.ts, sandbox.ts, security-impact-evidence.ts, security.ts, serve.ts x3, sessions.ts, skills-governance.ts, skills.ts x2, stack.ts, standard.ts, wiki.ts, workspace.ts); only src/cli.ts and src/commands/mcp.ts import lib/suggest per the bounded diff.",
    "confidence": "high",
    "reviewer": "review-logic",
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
        "src/commands/schedule.ts:192 (narrower: no usage dump, but still no suggestion)",
        "src/commands/trigger.ts:131 (narrower: no usage dump, but still no suggestion)"
      ],
      "enumeration_method": "git grep -n \"Unknown .*command\" -A2 -- src/commands/*.ts (excluding *.test.ts) in ~/keryx-w5, manually inspected 2 lines after each match for a print*Help()/usage dump; cross-checked which files import lib/suggest against the bounded diff (only cli.ts, mcp.ts do)."
    }
  },
  {
    "id": "L2",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#L2",
    "severity": "blocker",
    "file": "src/commands/agent-commands.test.ts",
    "line": null,
    "quote": "expect(commandsForMode(\"agent\").map((c) => c.name)).toEqual([ ... ]) // expected array omits \"/doctor\"",
    "problem": "This PR wires a new '/doctor' slash command into the agent-command registry (src/commands/agent-commands.ts, src/standard/command-registry.ts, src/standard/help-groups.ts — all changed in this diff), but does not update the pre-existing expected-command-list fixtures in src/commands/agent-commands.test.ts (which was NOT touched by this diff) or fully fix src/standard/command-registry.coverage.test.ts (which WAS touched but still fails). PR #773's own CI (GitHub Actions run 36346344627, job 'typecheck-and-tests') is red as a direct result: 5 tests fail — 'AGENT_SLASH_COMMANDS lists the expected commands', 'commandsForMode: agent lists its commands in stable order', 'commandsForMode: chat gets its commands and none of the agent-only trio', 'filterCommands: `/` returns all of the mode's commands', and 'command-registry > every descriptor is well-formed'. The diff for the failing assertion shows the actual registry now yields '+ \"/doctor\"' where the test's hardcoded expected array does not include it.",
    "impact": "This is AC8 itself ('typecheck, lint and every touched test file pass') failing on the PR's own CI at the exact head commit (9a2bbf622058f83a34345c5ff5726c3fa7ba42fd) under review, directly contradicting the PR body's own claim ('Typecheck, lint and the touched test files pass ... my pass: 222 across the touched set incl. source-audits, cli and import-policy'). This is merge-blocking as-is: GitHub reports 'typecheck-and-tests' failed, and AC8 is an explicit, frozen acceptance criterion this PR claims to satisfy but does not, at the ref reviewed.",
    "suggested_fix": "Update the hardcoded expected command lists in src/commands/agent-commands.test.ts (AGENT_SLASH_COMMANDS constant and/or the commandsForMode('agent') expected array, and the filterCommands('/') expectation) to include '/doctor' in its correct registry position, and fix whatever makes 'command-registry > every descriptor is well-formed' still fail in src/standard/command-registry.coverage.test.ts despite that file already being touched. Re-run `bun test src/commands/agent-commands.test.ts src/standard/command-registry.coverage.test.ts` locally and confirm green before the next push.",
    "evidence": "`gh pr checks 773` (run at review time) shows 'typecheck-and-tests' as failed. `gh run view 36346344627 --job 108696139265 --log` shows: '5 tests failed: (fail) AGENT_SLASH_COMMANDS lists the expected commands [0.37ms]; (fail) commandsForMode: agent lists its commands in stable order [0.45ms]; (fail) commandsForMode: chat gets its commands and none of the agent-only trio [0.23ms]; (fail) filterCommands: `/` returns all of the mode's commands [0.34ms]; (fail) command-registry > every descriptor is well-formed [0.81ms]' followed by ' 18035 pass / 13 skip / 5 fail' and 'error: script \"test:core\" exited with code 1'. The failure diff for 'commandsForMode: agent lists its commands in stable order' shows the received array containing '+   \"/doctor\",' immediately after '/flows' where the expected array (hardcoded in the unmodified test file) does not have it. This is the Stage-1 spec-compliance gate comparison (AC8 vs. the diff and the PR's own CI), run by review-orchestrator per this skill's own rule that such a finding is filed under a domain reviewer's name, never review-orchestrator's.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        "src/commands/agent-commands.test.ts (AGENT_SLASH_COMMANDS + commandsForMode('agent') + filterCommands('/') expectations — file not touched by this diff, stale)",
        "src/standard/command-registry.test.ts ('every descriptor is well-formed' — sibling of the touched command-registry.coverage.test.ts, itself not touched by this diff, still fails; command-registry.coverage.test.ts itself passes 14/14 clean, confirmed by review-verifier execution)"
      ],
      "enumeration_method": "Fetched and read the full 'typecheck-and-tests' CI job log for PR #773 head 9a2bbf62 via `gh run view 36346344627 --job 108696139265 --log`; located every '(fail)' line and the assertion diff immediately preceding it; cross-referenced each failing test name to its source file via the file's own describe/test names."
    }
  },
  {
    "id": "T1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#T1",
    "severity": "blocker",
    "file": "src/commands/doctor.test.ts",
    "line": null,
    "quote": "if (doctorFailed(report)) {\n    process.exitCode = 1;\n  }",
    "problem": "AC1 (quoted verbatim in this test file's own header comment) requires 'a test covers the JSON shape and the exit codes' — plural, i.e. both 0 and 1. doctor.test.ts's describe(\"keryx doctor (CLI) — --json shape and exit codes\", ...) block only ever calls doctorCommand against process.cwd() (this real, already-healthy repository) or a bare empty tmp directory — both produce an all-ok/warn report, never a fail. The exit-1 path is only unit-tested against the extracted, synthetic-input doctorFailed(report) predicate, never through doctorCommand itself. None of the 11 check-building functions in doctor.ts (checkBun, checkRipgrep, checkSandbox, checkProviders's warn branch, checkMcp's fail/warn branches, checkIntegrations, checkStandard, checkGraphFreshness, checkWikiFreshness, checkWorktrees) has its non-'ok' branch driven by any constructed fixture in doctor.test.ts.",
    "impact": "If doctorCommand's `if (doctorFailed(report)) { process.exitCode = 1; }` wiring were deleted or inverted, or if any single check's fail/warn condition were silently broken (e.g. checkMcp's ownProblems.length > 0 flipped, or checkStandard's error/warning branches removed), doctor.test.ts would still pass in full — there is no fixture anywhere in the file that constructs a project state driving any check to fail, so the suite cannot currently catch a regression in the one behavior AC1 names as its exit-code contract.",
    "suggested_fix": "Add at least one doctor.test.ts case that forces a real fail: create a temp project root (mkdtemp), write a malformed native config at <root>/.keryx/mcp-servers.json (mirrors the existing pattern in src/commands/mcp-servers.test.ts's 'a config problem is reported and turns the exit code non-zero' test), call doctorCommand([], root) (and the --json form), and assert process.exitCode === 1 and that the mcp check's status is \"fail\" in the parsed report.",
    "evidence": "Full read of src/commands/doctor.test.ts (174 new lines) and src/commands/doctor.ts (378 new lines): the only process.exitCode assertions in doctor.test.ts are inside doctorFailed unit tests against hand-built DoctorReport objects; the describe(\"keryx doctor (CLI) ...\") block's three tests assert code equal to 0 in all cases (real repo, real repo again, and --help, which short-circuits before building any report).",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/commands/doctor.ts: doctorCommand (process.exitCode = 1 wiring, unreached)",
        "src/commands/doctor.ts: checkMcp (fail branch, unreached)",
        "src/commands/doctor.ts: checkStandard (fail/warn branches, unreached)",
        "src/commands/doctor.ts: checkBun (fail branch, unreached)",
        "src/commands/doctor.ts: checkProviders (warn branch, unreached)",
        "src/commands/doctor.ts: checkSandbox / checkRipgrep / checkIntegrations / checkGraphFreshness / checkWikiFreshness / checkWorktrees (warn branches, unreached)"
      ],
      "enumeration_method": "Read every function in the new doctor.ts end-to-end and cross-checked each against every test in doctor.test.ts for a fixture that would drive it past its 'ok' return; none exists outside the two predicate-level unit tests (meetsBunFloor, doctorFailed)."
    }
  },
  {
    "id": "A1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#A1",
    "severity": "info",
    "file": "src/commands/doctor.ts",
    "line": null,
    "quote": "import { buildSandboxReport } from \"./sandbox\";\nimport { configuredProviders } from \"./providers\";",
    "problem": "doctor.ts (the new single-aggregation-point command) imports two functions directly from sibling command files instead of through a shared lib/service, unlike its graph/wiki freshness checks which were routed through new core-zone facade re-exports for the same reuse purpose.",
    "impact": "No named runtime trigger or outcome — pervasive, pre-existing pattern in this codebase (commands/providers.ts is imported directly by src/tui/balance-panel.ts, src/lib/narrate.ts, src/harness/routing/provider-default.ts, etc.). The project's own src/lib/import-policy.ts zone table classifies all of src/commands/ as one adapter zone and only measures/enforces facade discipline for core-zone imports, not adapter-to-adapter.",
    "suggested_fix": "No action required under current convention. A repo-wide convention change (adding a src/commands/* facade rule to import-policy.ts) would be out of scope for this PR.",
    "evidence": "src/commands/doctor.ts lines 30-31; cross-checked with keryx ctx rg 'commands/providers'/'commands/sandbox' showing existing direct imports from src/tui, src/lib, src/harness, src/commands/agent.ts, src/commands/select.ts; src/lib/import-zones.ts classifies commands as one adapter segment with no internal facade rule.",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "S1",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#S1",
    "severity": "info",
    "file": "src/mcp-servers/compat.ts",
    "line": null,
    "quote": "problems.push({\n        file,\n        message: `line ${lineNo}: value for \"${pair[1] as string}\" is a TOML form this reader does not support (${pair[2] as string})`,\n      });",
    "problem": "parseGrokToml() (pre-existing, not touched by this diff) embeds the raw TOML value text verbatim into the problem message whenever a value's form is unsupported by this hand-rolled parser (inline tables, floats, dates, multi-line arrays, unquoted strings). A realistic MCP-server config for an HTTP/SSE server with auth commonly writes `headers = { Authorization = \"Bearer sk-...\" }` as an inline table — exactly a form this parser rejects and echoes back whole.",
    "impact": "The resulting McpConfigProblem is tagged foreign: true by this PR's new loadMcpServers loop and lands in foreignProblems, which src/commands/mcp-servers.ts's listCommand (this PR's new AC4 code) prints both to stderr and into `keryx mcp list --json`'s warnings array unmodified. The same unfiltered config.problems also reaches `keryx mcp doctor`'s report (no sanitisation at all) and the `keryx shell` /mcp TUI panel (sanitiseForDisplay only strips control characters, not secret text). Any of these three surfaces can put a real bearer token/API key from the operator's own Grok config verbatim into stdout, --json output, or a pasted bug report — the same class of bug this project's memory records for the earlier `keryx mcp list` credential leak. Not newly introduced by this PR (compat.ts is untouched and the same content already printed pre-PR), but this PR gives the leak path a permanent, documented, always-exit-0 'warnings' identity, making it more likely to be dismissed as inert noise.",
    "suggested_fix": "In compat.ts, redact rather than echo the raw value text in this message, or route every foreign-config problem message through a redaction pass that masks secret-shaped substrings (not just control characters). File as a follow-up rather than blocking this PR, since the vulnerable code is out of diff.",
    "evidence": "Traced McpConfigProblem.message from creation to every print site: (1) src/mcp-servers/compat.ts parseGrokToml — only site interpolating a field VALUE; (2) src/mcp-servers/config.ts loadMcpServers — tags it foreign: true, confirmed the diff's tagging loop touches only compatFiles() and never native problems; (3) src/commands/mcp-servers.ts listCommand — prints foreignProblems to stderr and --json warnings; (4) src/mcp-servers/doctor.ts — prints config.problems unfiltered; (5) src/mcp-servers/runtime.ts -> src/tui/mcp-consumer.ts — sanitiseForDisplay strips only control characters (confirmed by reading src/mcp-servers/tools.ts:114-117). Confirmed compat.ts is not among the changed files in the bounded diff.",
    "confidence": "medium",
    "reviewer": "review-security-code"
  },
  {
    "id": "T2",
    "global_id": "2026-09-27-pr-9a2bbf622058f83a34345c5ff5726c3fa7ba42fd#T2",
    "severity": "info",
    "file": "src/lib/suggest.test.ts",
    "line": null,
    "quote": "test(\"suggestClosest returns nothing beyond edit distance 2\", () => {\n  expect(suggestClosest(\"zzzqxvvv\", KNOWN)).toEqual([]);\n});",
    "problem": "AC3's edit-distance-2 cutoff is tested with a typo well beyond the boundary and one well within it, but no test pins the exact boundary — a candidate at distance exactly 2 (should be included) versus exactly 3 (should be excluded) from the same base word.",
    "impact": "A future off-by-one in MAX_EDIT_DISTANCE comparison (<= vs <) would not be caught by this suite, though the overall behavior (some suggestion vs. none) is otherwise well covered.",
    "suggested_fix": "Add one boundary-pinning case: two candidates differing from the input by exactly 2 and exactly 3 edits, asserting the first is included and the second is not.",
    "evidence": "Full read of src/lib/suggest.test.ts (40 lines) and src/lib/suggest.ts (77 lines); MAX_EDIT_DISTANCE = 2 compared with <=.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  }
]
```
