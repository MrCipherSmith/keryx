# Flow 258 review round 1 — consolidated

Scope: `origin/main..HEAD` on `skills/skill-gaps`, head `680368e3`, the head of
PR #545. Three reviewers dispatched in parallel on disjoint slices: code
(`src/review/floor.ts`, `src/commands/review.ts`, the contract schema), skill
content (the four new skills and the four edited ones), and rules plus
attribution.

Provenance: the three reviewers returned their reports to the orchestrator in
conversation; this document is the orchestrator's consolidation, written when
the fix tasks were opened. Round 2 re-checked every finding by execution
against the tree, and those checks are what the verifier claims record.

Counts: 4 major, 15 at or above minor, plus info items. No blocker.

## Major

| id | area | finding | closed by |
|---|---|---|---|
| R1-M1 | `src/commands/review.ts` | `review floor` exits 1 for "cannot tell" — a bad ref, an unreadable diff and a real finding are indistinguishable — against the CLI rule this same branch introduced, which reserves 2. Under `--json` the failure is prose on stderr with nothing on stdout, so `scanned` is absent on every error path and the "0 findings versus 0 input" distinction collapses. | `9c9583d1` |
| R1-M2 | `src/review/floor.ts` | The capacity carve-out reads the whole line, so the module's own headline example goes silent: `--max-warnings 0` becoming `50` is suppressed when the same command says `--max-size`, and a trailing comment turns the detector off in one word. | `9c9583d1` |
| R1-M3 | `cli-interface-design.mdc` | Both `keryx review` citations are dead at HEAD — the floor work moved that file about 63 lines. | `b3fe5f4f` |
| R1-M4 | `cli-interface-design.mdc` | "None of the eleven carries a version" is false: three print a versioned type. For a rule whose headline example is versioning, the overstatement costs it authority. | `b3fe5f4f` |

## Minor

Code (`9c9583d1`): the disabled-test detector fires on prose about skipped
tests while its docstring denies it; chained and conditional forms
(`test.concurrent.skip`, `describe.skipIf`) are missed and undeclared; a shallow
clone is told to pass a ref that shares history when the histories do share and
the clone is truncated — the default in CI, where this runs; a suppression that
merely moved within a region is reported as added.

Skills (`c601a6b0`): `revert` is written as a severity beside `minor` and no
such severity exists, so a reviewer taking it literally emits a payload that
fails validation; `deprecation-path` restates the clause the CLI rule owns,
including duplicated line pins; `api-truth` claims the repo provides tooling it
does not and leaves rank 2 undefined without it; `task-implementer` points at the
phase that reads module neighbours for story patterns read by the phase before
it; `deprecation-path`'s Verification is stricter than the shipped example it
cites.

Rules (`b3fe5f4f`): the done rule's prose says "four rules and three skills"
above a table listing six and two; flow 257's adapted techniques carry no credit
anywhere and the plan does not say so.

## Info

The `--ref` description in `cli-reference.md` contradicted the help text; two
measured byte counts had drifted; a `modules.ts` citation named a range one line
short of its quote; the program plan named one branch for a program now on
three.

## Findings

```json keryx:findings
[
  {"id":"R1-M1","reviewer":"round-1-code","severity":"major","file":"src/commands/review.ts","line":400,"problem":"review floor exits 1 for every cannot-tell case, so a caller cannot distinguish an unresolvable ref from a lowered bar, and under --json the failure puts nothing on stdout.","impact":"A gate consuming this command reads an infrastructure failure as a finding, and `scanned` — the field that separates zero findings from zero input — is absent exactly on the paths where it matters.","suggested_fix":"Exit 2 for cannot-tell with a cannot-scan payload on stdout; keep 1 for a malformed invocation.","evidence":"Measured: --ref does-not-exist-ref --json exits 1 with 0 bytes on stdout; --diff /nope/missing.diff --json the same; a real finding also exits 1. cli-interface-design.mdc:25-58, added on this branch, reserves 2 for cannot-tell.","confidence":"high","class_scope":{"sites":["src/commands/review.ts runFloor","src/commands/review.ts shared catch"],"enumeration_method":"The floor command is the only new exit-code surface on this branch; its two exit paths were read and executed."}},
  {"id":"R1-M2","reviewer":"round-1-code","severity":"major","file":"src/review/floor.ts","line":303,"problem":"The capacity carve-out tokenises the whole line, so an unrelated word or a trailing comment suppresses a real weakening.","impact":"The module's own headline example is silent, and the guard can be evaded by appending a comment — a guard whose whole purpose is to be hard to slip past.","suggested_fix":"Read only the identifier adjacent to the number that moved, and strip trailing comments before tokenising.","evidence":"Three fixtures returning nothing: --max-warnings 0->50 beside --max-size; minCoverage 80->70 with a trailing comment; minItems 3->0.","confidence":"high","class_scope":{"sites":["src/review/floor.ts thresholdDirection","src/review/floor.ts CAPACITY_WORDS"],"enumeration_method":"The carve-out has one call site; both it and the tokeniser it feeds were executed against fixtures."}},
  {"id":"R1-M3","reviewer":"round-1-rules","severity":"major","file":"src/gdskills/bundled/rules/core/cli-interface-design.mdc","line":51,"problem":"Both keryx review citations point at prose and a mid-comment; the functions moved about 63 lines when the floor work landed.","impact":"A reader following a citation to the wrong line stops trusting the rest, and this rule is entirely built on citations.","suggested_fix":"Cite the symbols, which are unique in the file and do not move.","evidence":"reportCrossFamilyReviewProblems is at review.ts:1983 and reportFilterStatsProblems at :1994; the rule says :1920 and :1931.","confidence":"high","class_scope":{"sites":["cli-interface-design.mdc:51-53"],"enumeration_method":"Every citation in both new rules was opened and compared; these two were the only dead ones."}},
  {"id":"R1-M4","reviewer":"round-1-rules","severity":"major","file":"src/gdskills/bundled/rules/core/cli-interface-design.mdc","line":127,"problem":"The rule states that none of the eleven JSON.stringify sites carries a version; three print a versioned type.","impact":"The rule's headline example of getting versioning wrong overstates, which costs it the authority it is lending.","suggested_fix":"State the eleven/three/eight split and make the sharper point: the envelopes are unversioned and verify --all is a bare array.","evidence":"skills verify --all --json emits [{\"schemaVersion\":1,…}]; LearningProposal and ProjectSkillVerificationReport declare their versions.","confidence":"high","class_scope":{"sites":["cli-interface-design.mdc:127-136"],"enumeration_method":"All eleven serialisation sites were opened and their printed types traced to their declarations."}},
  {"id":"R1-m1","reviewer":"round-1-code","severity":"minor","file":"src/review/floor.ts","line":415,"problem":"The disabled-test detector fires on prose about skipped tests, and its docstring claims it does not.","impact":"This branch ships thousands of lines of prose about skipped tests; the guard would fire on documentation.","suggested_fix":"Require a call after the token and delete the overstated sentence.","evidence":"'We ban this; it.skip is the usual culprit.' in a .md path fires.","confidence":"high"},
  {"id":"R1-m2","reviewer":"round-1-code","severity":"minor","file":"src/review/floor.ts","line":421,"problem":"Mainstream disable forms are missed and undeclared: test.concurrent.skip and describe.skipIf.","impact":"A disabled test in the common spelling passes the guard.","suggested_fix":"Permit a chained modifier segment and add skipIf/runIf.","evidence":"Both forms return nothing; both are jest/vitest API.","confidence":"high"},
  {"id":"R1-m3","reviewer":"round-1-code","severity":"minor","file":"src/commands/review.ts","line":1878,"problem":"A shallow clone is refused with advice that does not apply — the histories do share, the clone is truncated.","impact":"actions/checkout defaults to depth 1, which is exactly where this gate runs, and the message sends the operator the wrong way.","suggested_fix":"Detect a shallow repository and prescribe fetch --unshallow or fetch-depth: 0.","evidence":"A --depth 1 clone makes merge-base return rc=1 and the command prints the generic no-common-ancestor advice.","confidence":"high"},
  {"id":"R1-m4","reviewer":"round-1-code","severity":"minor","file":"src/review/floor.ts","line":602,"problem":"A suppression that merely moved within a region is reported as added.","impact":"A reindent produces a finding the diff cannot answer, which trains the reader to ignore the kind.","suggested_fix":"Skip an added marker whose trimmed text matches a removed line in the same region.","evidence":"Removing an eslint-disable-next-line and re-adding it two lines down yields suppression-added.","confidence":"high"},
  {"id":"R1-m5","reviewer":"round-1-skills","severity":"minor","file":"src/gdskills/bundled/skills/review/review-performance/SKILL.md","line":240,"problem":"`revert` is written in backticks beside `minor`, so it reads as a severity; the enum is blocker|major|minor|info.","impact":"A reviewer taking it literally emits a payload that fails schema validation; one that notices has no severity for the finding the law exists to create.","suggested_fix":"Name a real severity and make the revert the suggested fix.","evidence":"reviewer-finding.schema.json:57-60 enumerates four values and revert is not among them.","confidence":"high"},
  {"id":"R1-m6","reviewer":"round-1-skills","severity":"minor","file":"src/gdskills/bundled/skills/quality/deprecation-path/SKILL.md","line":60,"problem":"Six passages restate the clause cli-interface-design.mdc owns, including the same quotes and the same file:line pins.","impact":"Two copies of the same line numbers drift apart on the next refactor, and three citations on this branch already went stale.","suggested_fix":"Keep the skill's own material and replace the restatements with a pointer.","evidence":"The skill names the rule as owner at :47-49 and then repeats rule :165-197 verbatim.","confidence":"high"},
  {"id":"R1-m7","reviewer":"round-1-skills","severity":"minor","file":"src/gdskills/bundled/skills/quality/api-truth/SKILL.md","line":115,"problem":"The skill claims the repo already provides the tooling and then prescribes a CLI that appears here only as a fixture string.","impact":"The file ships into every project; an agent without that tool is told rank 2 exists and given no way to reach it.","suggested_fix":"Make rank 2 a checked list ending in the documentation shipped inside the installed artefact, and say when rank 2 is unavailable.","evidence":"ctx7 appears only in src/mcp-servers/compat.table.test.ts; it is not a dependency and keryx init does not install it.","confidence":"high"},
  {"id":"R1-m8","reviewer":"round-1-skills","severity":"minor","file":"src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md","line":293,"problem":"Cites Phase 2.3 for story patterns; 2.3 reads module neighbours and stories are read in 2.2, which after an earlier cut no longer says to extract them.","impact":"A later phase cites something that no longer exists.","suggested_fix":"Point at 2.2 and restore the extraction instruction there.","evidence":"The sibling line at :290 says 2.2; 2.2's bullets mention only test patterns.","confidence":"high"},
  {"id":"R1-m9","reviewer":"round-1-skills","severity":"minor","file":"src/gdskills/bundled/skills/quality/deprecation-path/SKILL.md","line":249,"problem":"Verification requires the notice to state when the old spelling stops, while the shipped example it cites prints no end date.","impact":"The first agent applying the skill invents a version to satisfy it.","suggested_fix":"Allow 'no removal is scheduled' as an explicit answer.","evidence":"announceRename at src/commands/mcp.ts:92 prints deprecation without a date.","confidence":"high"},
  {"id":"R1-m10","reviewer":"round-1-rules","severity":"minor","file":"src/gdskills/bundled/rules/core/definition-of-done.mdc","line":11,"problem":"The prose says four rules and three skills; the table below lists six rules and two skills.","impact":"A rule that miscounts its own table invites doubt about the rest.","suggested_fix":"Count the table.","evidence":"Eight rows: six rules, two skills.","confidence":"high"},
  {"id":"R1-m11","reviewer":"round-1-rules","severity":"minor","file":"docs/plans/skills-quality-program.md","line":33,"problem":"Flow 257's adapted techniques carry no credit anywhere, and the plan reads as though attribution is complete.","impact":"AC11's standard is applied to this flow and silently not to the previous one.","suggested_fix":"Record which of 257's files are owed a credit and which took nothing.","evidence":"addyosmani appears in no file that flow 257 touched.","confidence":"high"}
]
```
