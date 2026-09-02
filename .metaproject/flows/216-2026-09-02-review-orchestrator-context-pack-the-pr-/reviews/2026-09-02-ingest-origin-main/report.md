# Review — PR #431, round 1

Target: pull request MrCipherSmith/keryx#431
Head at review: 868eae95a283d7bdde3789876189e08377252e4c
Base: origin/main (09e8555c)
Reviewers: review-logic, review-architecture, review-security-code,
review-testing-practices, review-clean-code, review-regression

## Verdict: REQUEST_CHANGES

## Summary

Six reviewers over a 48-file, 4705-line diff spanning three flows. The schemas
(flow 216) came back clean. Every major is in the routing and guard work, and
almost all findings share one shape: a claim with nothing checking it, which is
the defect the change itself was written to remove.

Both majors are about the test suite rather than the code: the routing corpus
asserts a test-local helper instead of the shipped surface, and 27 of 33 new
synonym prefixes are unexercised — including the one the change names as the
root cause of the reported incident.

## Review Scope

- mode: diff
- files: 48 (19 src, 28 .metaproject, 1 .claude)
- changed lines 4705, blocks 115, dropped 0
- blast radius: gdgraph 984 nodes / 2987 edges; 40 changed files absent from the
  graph, recorded as unresolved rather than empty
- memory: searched, accepted only. Two entries intersected and were handed to
  every reviewer: allowlist-not-a-boundary, stale-installed-keryx-binary

## Stats

blockers 0, majors 2, minors 14, info 0

## Stage counts

- dropped by pre-filter: 0
- refuted by the verifier: 0. No separate Wave C ran: every major was reproduced
  by the orchestrator directly, which is a stronger check than re-reading.
- retained: 16

## Checked and cleared

- The native-tool refusal cannot be misread via payload shaping, and its message
  cannot carry attacker-controlled content into the model's context: the only
  interpolated value is provably from the declared allowlist.
- Failing open on unknown tools is correct here, and was argued rather than assumed.
- Uninstall keys on the managed sentinel, not the matcher, so an install written
  by an older build is still found and removed.
- keryx skills route output for project-skill queries is byte-identical to base.
- The repo duplication across two finding schemas is deliberate and load-bearing
  (the registered contract is additionalProperties false), and is enforced by
  driving real instances through both shipped files.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/ctx/hook-classify.ts",
    "line": 74,
    "problem": "firstStages keeps only the first pipeline stage on the premise that everything downstream of a | reads stdin. The premise is false: grep -rn P DIR, cat FILE, head FILE, find and sed -n ... FILE take operands and never read stdin, so any prefix launders the exact commands the guard names.",
    "impact": "The guard is disabled for its own target set by a one-token prefix, and the run is recorded as compliant (ctx_used) when no routing occurred. No confidentiality/integrity/availability impact: the # keryx:raw escape already grants the same thing openly.",
    "suggested_fix": "Classify non-first stages too, deciding by a stdin-vs-tree test rather than position: a later grep/rg stage is a tree search when it carries -r/-R or a non-flag path operand.",
    "evidence": "Old-vs-new verdicts from git show 09e8555c: `echo hi | grep -rn foo src/` BLOCK -> pass; `true | git log -p` BLOCK -> pass; `: | find . -name '*.ts'` BLOCK -> pass. Confirmed the laundered search really runs and prints file matches.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/ctx/hook-classify.ts:74 firstStages",
        "src/ctx/hook-classify.ts:107 the single consuming loop"
      ],
      "enumeration_method": "Read every match arm inside the classify loop; all inherit the hole (rg|grep|egrep|fgrep|ripgrep; cat|head|tail; sed/awk; find; ls -R; git diff|log|show). No other caller of firstStages/statements."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/ctx/runtimes.ts",
    "line": 166,
    "problem": "validate reports a managed hook group as clean when it cannot execute: an absent matcher, a non-string matcher, and a hook entry of type 'prompt' (which no harness executes) all return [].",
    "impact": "False assurance from the check whose stated purpose is that a stale install looks identical from the outside. Not a privilege gain: anyone who can write settings.json can also delete the group, which IS detected.",
    "suggested_fix": "Require the matched hook entry to be type === 'command', and treat an absent or non-string matcher as needing reinstall rather than clean.",
    "evidence": "Drove CLAUDE_RUNTIME.validate over thirteen settings shapes; matcher missing -> [], matcher 123 -> [], matcher null -> [], type 'prompt' with the right command -> [].",
    "confidence": "medium",
    "blocking_merge": false
  },
  {
    "id": "CC-001",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/ctx/hook.ts",
    "line": 7,
    "problem": "The file header states the fail-open contract as 'an unknown runtime, a non-shell tool, or an unparseable payload always allows the command'. The change makes that false: a non-shell tool call is now the one case that can refuse.",
    "impact": "The header is where the guard's safety property is stated and it now asserts the opposite of what the code does for exactly the case this change added.",
    "suggested_fix": "Amend the header to name the exception.",
    "evidence": "src/ctx/hook.ts:7-9 vs :46-53; runtimes.ts nativeSearchTools ['Grep']; refusalAction default branch returns exitCode 2.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "CC-002",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/ctx/hook-classify.ts",
    "line": 67,
    "problem": "The load-bearing docblock sentence reads 'Only the first stage is dropped from consideration downstream, never the first' — it contradicts itself and the half that parses states the inverse of the code.",
    "impact": "A reader taking it literally concludes the first stage is skipped and that `grep -rn foo | head` passes, which is the precise misunderstanding the paragraph exists to prevent.",
    "suggested_fix": "'Only the stages AFTER the first are dropped from consideration, never the first.'",
    "evidence": "src/ctx/hook-classify.ts:67-69 against the implementation at :74-78.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "CC-003",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/ctx/orient-routing.ts",
    "line": 11,
    "problem": "ROUTING_FLOOR = 55 is a bare literal whose meaning is TRIGGER_BASE + TRIGGER_PER_TOKEN in another file, and its docblock claims the floor 'requires a real trigger match', which it does not.",
    "impact": "The routing block can confidently name a skill on vocabulary overlap alone, the exact failure mode the same comment says the floor prevents.",
    "suggested_fix": "Derive the constant and either correct the prose or filter on reasons.includes('trigger').",
    "evidence": "Executed the scorer: skill `pr` scores 70 on 'look at the branch and the commits and the diff summary...' with reasons ['tokens:branch+commits+diff+summary'] and no trigger, clearing the floor.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "CC-004",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/ctx/runtimes.ts",
    "line": 166,
    "problem": "hasStaleMatcher re-implements the whole of hasManagedInArray to add one predicate; the flat-vs-nested ownership test is duplicated and the copy dropped the comment explaining it. Its `key` parameter promises generality the body does not have.",
    "impact": "Two copies of the piece most likely to change: when a fourth settings shape arrives, one gets updated and the other keeps reporting the install clean.",
    "suggested_fix": "Extract managedGroupsFor(settings, key, command) and build both checks on it; drop the misleading key parameter.",
    "evidence": "runtimes.ts:167-168 identical to :181-182; ownership predicate at :170-175 identical in effect to :184-190; sole call site passes the literal 'PreToolUse'.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "A-001",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/ctx/orient-routing.ts",
    "line": 2,
    "problem": "src/ctx/orient-routing.ts imports scoreBundledSkillRoute from ../commands/skills. This is the only src/ctx -> src/commands edge in the repo and reverses the established direction (src/commands imports src/ctx in 8 places across 4 files), producing a module-level cycle.",
    "impact": "Anything wanting to route an intent must depend on the CLI command layer; src/gdskills, which owns the catalog, cannot use the scorer without an upward import.",
    "suggested_fix": "Move the scorer to src/gdskills/route.ts beside catalog.ts and have both callers depend inward.",
    "evidence": "keryx ctx rg over src/ctx for '../commands': 1 hit. Over src/commands for '../ctx': 8 hits in 4 files. gdgraph_cycles reports no file-level cycle involving these files. Counter-evidence weighed: X -> src/commands has precedent (src/lib, src/tui, src/wiki).",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "A-002",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/ctx/orient-routing.ts",
    "line": 22,
    "problem": "Two independent rankers over the same catalog: routeProjectSkills merges catalog and project-skills; routePrompt re-implements the pipeline with a different floor, a different tie-break and no project-skills at all.",
    "impact": "The per-prompt router can never name a project-defined skill or reviewer, while the project's routing rule says to prefer them; the exclusion is recorded as a decision nowhere.",
    "suggested_fix": "Extract the ranking, not just the scoring, and have both callers use it.",
    "evidence": "src/commands/skills.ts:322-356 vs src/ctx/orient-routing.ts:22-25; skills.ts:337 reads the registry, orient-routing has no equivalent. Flow 217 plan and ACs never mention project-skills.",
    "confidence": "medium",
    "blocking_merge": false
  },
  {
    "id": "A-003",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/ctx/runtimes.ts",
    "line": 344,
    "problem": "Which native tools the guard covers is declared twice with nothing deriving one from the other: PRE_TOOL_USE_MATCHER (module-level, global) decides which calls start the hook, nativeSearchTools (per-runtime) decides which are refused.",
    "impact": "Adding a tool to the list without editing the matcher means the refusal never runs and validate still reports clean. Also: CODEX_RUNTIME declares nativeSearchTools ['Grep'] with nothing in the repo evidencing that codex names its search tool Grep, while the runtime is marked confidence 'verified'.",
    "suggested_fix": "Derive the matcher from the runtime's own tool list.",
    "evidence": "runtimes.ts:344 constant, :375 and :388 per-runtime lists, :176 compares the global constant. Lockstep asserted only by two hardcoded test assertions.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "T-001",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/skills-route-corpus.test.ts",
    "line": 24,
    "problem": "The 45-pair corpus asserts a test-local helper filtering score > 0, but the shipped surface is routePrompt filtering score >= ROUTING_FLOOR. Three pairs assert green while producing no routing block at all.",
    "impact": "The suite's largest asset does not protect what keryx orient actually prints; any change to the scoring constants can silence the hook for a whole class of prompts with the corpus fully green.",
    "suggested_fix": "Add a second parametrised loop asserting routePrompt, and either raise the three below-floor pairs or move them to an explicit BELOW_FLOOR list.",
    "evidence": "MUTATION (survived): TRIGGER_BASE 40 -> 25 leaves 63 pass / 0 fail. Probe of all 45 pairs through routePrompt: silent=3 (открой пулл реквест, open a PR, найди узкие места), mismatch=0. `open PR` is one of the two collapses the file header says the change fixed.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/skills-route-corpus.test.ts RU_CORPUS",
        "src/commands/skills-route-corpus.test.ts EN_CORPUS",
        "src/commands/skills-route.test.ts topBundled"
      ],
      "enumeration_method": "Ran every corpus pair through routePrompt at HEAD and diffed against the topSkill helper; the pre-existing skills-route.test.ts carries a byte-identical helper."
    }
  },
  {
    "id": "T-002",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/skills.ts",
    "line": 613,
    "problem": "33 Russian synonym prefixes are added; deleting all 33 turns only 6 corpus tests red, so 27 are unexercised. Deleting the stated root cause ['полн', ['full','complete']] leaves the suite entirely green.",
    "impact": "82% of the new routing data has no test; a wrong prefix ships silently and is discovered only by another live session filing the same report.",
    "suggested_fix": "Drive routeTokens/expandQueryTokens directly in a table test, one row per prefix family.",
    "evidence": "MUTATION: all 33 removed -> 57 pass / 6 fail. Only ['полн'] removed -> 63 pass / 0 fail. The new 'ревью' catalog trigger removed -> 53 pass / 0 fail. Both together -> 0 fail. The literal 'полное ревью' catalog trigger masks the prefix.",
    "confidence": "high",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/skills.ts RU_SYNONYM_PREFIXES"
      ],
      "enumeration_method": "Deleted the whole added block and bisected which entries any test observes."
    }
  },
  {
    "id": "T-003",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/gdskills/review-context-pr-cross-repo.test.ts",
    "line": 250,
    "problem": "Seven of the 22 tests assert literal substrings of SKILL.md prose. These are spell-checks on wording, not behaviour tests.",
    "impact": "False failures on innocent copy-editing, training the next author to edit the test rather than think about the rule.",
    "suggested_fix": "Keep the two that are contract-shaped ('Exactly four shapes' and the absence of 'Exactly five shapes', which five other skills cite) and relax the rest to identifier matches.",
    "evidence": "MUTATION: rewrote `merge_order: producer_first` as 'merge order of `producer_first`' with the meaning unchanged -> 20 pass / 2 fail.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "T-004",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/ctx/hook-native-search.test.ts",
    "line": 34,
    "problem": "nativeSearchTools is added to both CLAUDE_RUNTIME and CODEX_RUNTIME, but every assertion names CLAUDE_RUNTIME only.",
    "impact": "Codex is marked confidence 'verified'; its guard can be dropped in a refactor and the routing audit keeps reporting a clean run for codex sessions.",
    "suggested_fix": "Parametrise the runtime-level assertions over both runtimes.",
    "evidence": "MUTATION (survived): removed nativeSearchTools from CODEX_RUNTIME -> 93 pass / 0 fail across 8 files. The same mutation on CLAUDE_RUNTIME -> 8 pass / 3 fail.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "T-005",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/orient.ts",
    "line": 61,
    "problem": "Both fail-safes on a hook that runs on every prompt are untested: nothing makes the router throw, and the process.stdin.isTTY early return has no test.",
    "impact": "A refactor can delete either guard with the suite green. Without the isTTY guard an interactive keryx orient awaits stdin on a terminal.",
    "suggested_fix": "Test routingBlockForStdin in-process with a stubbed router that throws; unit-test the tty branch.",
    "evidence": "MUTATION (survived): removed the try/catch -> 4 pass / 0 fail. Removed the isTTY guard -> 4 pass / 0 fail.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "T-006",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/orient-stdin.test.ts",
    "line": 37,
    "problem": "The header states the no-prompt path must keep 'exactly the output it got before the prompt was ever read', but the test only asserts the eight no-prompt forms agree with each other.",
    "impact": "A change altering the body or the body/routing concatenation for all inputs at once passes; the invariant the test is named for is the one it does not check.",
    "suggested_fix": "Assert the no-prompt output equals the runtime-formatted orientation computed in-process.",
    "evidence": "MUTATION (survived): changed the write to `${body}\\n\\n${routing}\\n` -> 4 pass / 0 fail.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "T-008",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/skills-route-corpus.test.ts",
    "line": 24,
    "problem": "topSkill() is a verbatim duplicate of topBundled() in the pre-existing skills-route.test.ts. There are three copies of the ranking logic in the repo and they do not agree.",
    "impact": "A change to the tiebreak or the filter has to be made in three places; the two test copies silently diverging from routePrompt is what produced T-001.",
    "suggested_fix": "Delete both helpers and call routePrompt.",
    "evidence": "Both files read; helper bodies identical apart from the name. gdgraph affected --symbol scoreBundledSkillRoute lists skills-route.test.ts as an existing dependent.",
    "confidence": "high",
    "blocking_merge": false
  }
]
```
