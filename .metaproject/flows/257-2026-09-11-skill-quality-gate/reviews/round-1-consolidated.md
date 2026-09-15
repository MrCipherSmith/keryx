# Flow 257 review round 1 — consolidated

Scope: `origin/main..HEAD` on `skills/quality-gate`, HEAD `50d2dd0c`.
Three reviewers dispatched by the flow orchestrator, in parallel, each on a
disjoint slice: code (`src/gdskills/*.ts`, `src/commands/*.ts`), tests
(fixtures, corpus, mutation), content (skills, rules, docs).

**Provenance note, stated plainly:** the reviewers returned their reports to the
orchestrator in conversation and the orchestrator did not persist the three
verbatim reports as files before consolidating them. This document is the
orchestrator's consolidation, written from those reports at the time the fix
tasks (T19–T22) were created; each row below is traceable to the task that was
opened for it and to the commit that closed it. Round 2 (persisted verbatim in
`round-2-report.md`) re-checked every one of them by execution against the tree,
which is the stronger evidence and is what the dispositions cite.

Counts: 6 major, ~12 minor. No blocker.

## Major

| id | area | finding | closed by |
|---|---|---|---|
| R1-M1 | `src/gdskills/install.ts` | `removeStaleRuntimeBuilds` deleted through a symlinked parent — skills root, category or skill directory — so a symlink in an installed tree let the sweep remove files outside it | T20, `62cd9424` |
| R1-M2 | `src/gdskills/install.ts` | on a case-insensitive filesystem the sweep matched by normalised name and removed a user's differently-cased file | T20, `62cd9424` |
| R1-M3 | `src/gdskills/install.ts` | removals were silent — nothing told the user a file had been deleted | T20, `62cd9424` |
| R1-M4 | `bundled-eval.ts` + storage rule | the `anatomy:length` finding told the author to raise the ceiling, which the rule forbids — the message and the rule contradicted each other | T19 + T22, `ce8e43c9` / `580dc5c2` |
| R1-M5 | `routing-corpus.test.ts` | the record was a single ratio bounded by `> 0.5`, so a regression could pass and an improvement went unrecorded — not a ratchet | T21, `437a6f3e` |
| R1-M6 | AC11 | the rejected-change ledger had no test, and the rule's `docs/…` citation was unchecked | T19, `ce8e43c9` |

## Minor

Predicates and substance (T19, `ce8e43c9`): `not for` matched inside words for
lack of a word boundary; the bare-imperative list flagged nouns like `review`
and `check` used as nouns; one `anatomy` finding was reported per runtime build
rather than per skill; an empty `## Verification` body passed; a Red Flags table
of placeholder rows passed; two skills could ship the same Red Flags table
unnoticed (new `anatomy:red-flags-collision`).

Content (T22, `580dc5c2`): `context-collector`'s NOT-for clause named a skill
that does not exist; `reviewer-skill-creator` quoted output `keryx review
reviewers` does not produce; `agent-entrypoint-distiller` passed a flow id to
`keryx flow check`, which takes none; the storage rule did not say what makes a
runtime build "genuinely differ"; `export.ts` still carried `usedFallbackBuild`
after T5 removed the fallback concept.

## Instructed fixes the workers refused, with measurement

- **Add `docs` to `CHECKED_PATH_ROOTS`** (from R1-M6). Refused: `docs/skills/`
  is not in `package.json` `files`, so the check would fail for every installed
  user, and several `docs/…` paths named in shipped skills are a *user's* own
  output directory, not ours. A ledger contract test was added instead. Round 2
  upheld the refusal on the `package.json` measurement and found the tree-side
  measurement overstated — corrected in T23.
- **Re-home the review flags** (claim: `--frontend` and friends lost their
  routing owner). Refuted with measurement: `--frontend`, `--backend`,
  `--architecture`, `--performance`, `--style` score 205 for their own reviewer
  against 65 for the orchestrator; `--security` 75 against 65; the four global
  flags belong to the orchestrator itself. Recorded in the rejected-change
  ledger. Round 2 re-measured all ten and confirmed.

## Findings

```json keryx:findings
[
  {"id":"R1-M1","reviewer":"round-1-code","severity":"major","file":"src/gdskills/install.ts","symbol":"removeStaleRuntimeBuilds","problem":"The sweep resolved the skills root, category and skill directory by path construction, so a symlinked component let it unlink files outside the installed tree.","impact":"An installed tree whose skills root, category or skill directory is a symlink (a shared checkout, a relocated tree) loses files in the link's target.","suggested_fix":"Walk each path component with lstat, stop at a symlink or non-directory with a recorded outcome, and confirm containment with realpath.","evidence":"Raised in round 1 against 50d2dd0c; round 2 reproduced all three cases in tmp trees and confirmed the fix (reviews/round-2-report.md).","confidence":"high","class_scope":{"sites":["src/gdskills/install.ts removeStaleRuntimeBuilds","src/gdskills/install.ts removeUnmodifiedRetiredRules"],"enumeration_method":"keryx ctx rg for unlink/rm over src/gdskills/install.ts, export.ts and src/commands/update.ts, init.ts, skills.ts: unlink appears only in install.ts, in these two helpers. removeUnmodifiedRetiredRules was already lstat-first from flow 256 (#533); this one was not."}},
  {"id":"R1-M2","reviewer":"round-1-code","severity":"major","file":"src/gdskills/install.ts","symbol":"removeStaleRuntimeBuilds","problem":"Candidates were matched on a normalised name, so on a case-insensitive filesystem a user's differently-cased file satisfied the match and was removed.","impact":"A user file named skill.zed.md is deleted on macOS while SKILL.zed.md is what the sweep meant.","suggested_fix":"Take candidates from readdir and match the on-disk name exactly.","evidence":"Raised in round 1; round 2 executed it on the case-insensitive tmp filesystem here — the sweep returns an empty list and the file survives.","confidence":"high","class_scope":{"sites":["src/gdskills/install.ts removeStaleRuntimeBuilds"],"enumeration_method":"The only name-matched deletion in the install path; removeUnmodifiedRetiredRules compares content hashes, not names."}},
  {"id":"R1-M3","reviewer":"round-1-code","severity":"major","file":"src/gdskills/install.ts","symbol":"removeStaleRuntimeBuilds","problem":"Removals were silent: nothing told the operator that a file had been deleted from their tree.","impact":"Roughly 88 files disappear from an installed tree on upgrade with no record.","suggested_fix":"Return an outcome per candidate and report removals.","evidence":"Raised in round 1; round 2 confirmed a printed notice per removal. Round 2 then found the reporting landed under the wrong heading (NEW-2).","confidence":"high","class_scope":{"sites":["src/gdskills/install.ts removeStaleRuntimeBuilds"],"enumeration_method":"The one new deleting helper in this branch; the retired-rule sweep already reported its kept outcomes since flow 256."}},
  {"id":"R1-M4","reviewer":"round-1-content","severity":"major","file":"src/gdskills/bundled-eval.ts","problem":"The anatomy:length finding told the author to raise the ceiling, while skills-storage-workflow.mdc forbids raising it. The tool and the rule instructed opposite actions.","impact":"An author following the message violates the rule; an author following the rule cannot clear the finding.","suggested_fix":"Rewrite the message to say split the skill, state that a ceiling only moves down, and have the rule quote it.","evidence":"Raised in round 1; round 2 read both files and confirmed the message and the rule's blockquote now agree.","confidence":"high","class_scope":{"sites":["src/gdskills/bundled-eval.ts anatomy:length message","src/gdskills/bundled/rules/core/skills-storage-workflow.mdc Length Ceilings",".metaproject/rules/core/skills-storage-workflow.mdc Length Ceilings"],"enumeration_method":"The ceiling rule is stated in exactly two places — the finding message and the storage rule, plus its byte-identical install mirror; all were read."}},
  {"id":"R1-M5","reviewer":"round-1-tests","severity":"major","file":"src/commands/routing-corpus.test.ts","problem":"The routing record was a single ratio asserted as greater than 0.5, so a large regression still passed and an improvement was never recorded.","impact":"The corpus could not detect the regressions it exists to detect.","suggested_fix":"Record rank-1 first-place and total as integers and compare them for equality against a live recount.","evidence":"Raised in round 1; round 2 confirmed toBe on both integers and that the denominator is the corpus's own counted positives.","confidence":"high","class_scope":{"sites":["src/commands/routing-corpus.test.ts rank-1 assertion","src/commands/skills.ts ROUTING_BASELINE"],"enumeration_method":"Both routing baselines in the branch were read: ROUTING_BASELINE pins exact scores per entry and was already exact; the corpus ratio was the loose one."}},
  {"id":"R1-M6","reviewer":"round-1-tests","severity":"major","file":"docs/skills/rejected-skill-changes.md","problem":"AC11's ledger had no test, and the citation of it in skills-storage-workflow.mdc was not covered by the xref sweep, so either could rot unnoticed.","impact":"The criterion could be satisfied by a file that is later deleted or renamed with nothing failing.","suggested_fix":"Add a contract test pinning the ledger's existence, header and append-only statement, and the rule's citation of it.","evidence":"Raised in round 1; round 2 confirmed three tests at bundled-eval.test.ts:2035-2077 and judged them sufficient for AC11.","confidence":"high","class_scope":{"sites":["docs/skills/rejected-skill-changes.md","src/gdskills/bundled/rules/core/skills-storage-workflow.mdc citation","src/gdskills/bundled-eval.ts CHECKED_PATH_ROOTS"],"enumeration_method":"The ledger is referenced from exactly one rule and checked by one sweep; all three sites were read."}},
  {"id":"R1-m1","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"The NOT-for clause was matched without a word boundary, so 'not formatted', 'not forced' and 'not fortunate' satisfied it.","impact":"A skill with no NOT-for clause passes anatomy:sections.","suggested_fix":"Require a word boundary after 'not for'.","evidence":"Round 2 confirmed all three strings are now rejected by fixture.","confidence":"high"},
  {"id":"R1-m2","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"The bare-imperative list flagged nouns used as nouns — 'review', 'check' — producing false description findings.","impact":"A correct description is reported as a bare imperative.","suggested_fix":"Gate the noun-ambiguous verbs behind a determiner test.","evidence":"Round 2 confirmed the gate and found no false positives across the 67 shipped skills.","confidence":"high"},
  {"id":"R1-m3","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"An anatomy finding was reported once per runtime build rather than once per skill.","impact":"A skill with a Codex build reports the same missing section twice.","suggested_fix":"Attribute anatomy findings to the skill.","evidence":"Round 2 confirmed with a fixture carrying a Codex build: one finding, not two.","confidence":"high"},
  {"id":"R1-m4","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"An empty Verification body satisfied anatomy:sections.","impact":"A heading with nothing under it counts as an exit criterion.","suggested_fix":"Require a non-empty body.","evidence":"Round 2 confirmed the fixture is rejected.","confidence":"high"},
  {"id":"R1-m5","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"A Red Flags table of placeholder rows satisfied anatomy:sections.","impact":"A table copied without content counts as a Red Flags table.","suggested_fix":"Add a substance floor for rows.","evidence":"Round 2 confirmed placeholder rows are rejected.","confidence":"high"},
  {"id":"R1-m6","reviewer":"round-1-code","severity":"minor","file":"src/gdskills/bundled-eval.ts","problem":"Two skills could ship the same Red Flags table with nothing noticing.","impact":"A backfill that copies one skill's table into another passes every check.","suggested_fix":"Add an anatomy:red-flags-collision check.","evidence":"Round 2 confirmed the check exists, is attributed to the later key, and the shipped tree is clean.","confidence":"high"},
  {"id":"R1-m7","reviewer":"round-1-content","severity":"minor","file":"src/gdskills/bundled/skills/quality/context-collector/SKILL.md","problem":"The NOT-for clause named a skill that does not exist in the catalog.","impact":"The clause routes a reader to nothing.","suggested_fix":"Name the skill that owns the excluded case.","evidence":"Round 2 confirmed interview and interviewer both exist, so the clause resolves.","confidence":"high"},
  {"id":"R1-m8","reviewer":"round-1-content","severity":"minor","file":"src/gdskills/bundled/skills/quality/reviewer-skill-creator/SKILL.md","problem":"The skill quoted output that keryx review reviewers does not produce.","impact":"An agent following the skill compares against a format that never appears.","suggested_fix":"Quote the real row, including the no-recorded-origin case.","evidence":"Round 2 matched the quoted row against src/review/reviewers.ts:200-205 exactly.","confidence":"high"},
  {"id":"R1-m9","reviewer":"round-1-content","severity":"minor","file":"src/gdskills/bundled/skills/platform/agent-entrypoint-distiller/SKILL.md","problem":"The skill passed a flow id to keryx flow check, which takes none.","impact":"The documented command is wrong.","suggested_fix":"Drop the argument.","evidence":"Round 2 ran keryx flow check and confirmed it takes no id.","confidence":"high"},
  {"id":"R1-m10","reviewer":"round-1-content","severity":"minor","file":"src/gdskills/bundled/rules/core/skills-storage-workflow.mdc","problem":"The rule did not say what makes a runtime build genuinely differ, so the criterion for keeping one was unstated.","impact":"A future author cannot tell whether a per-runtime copy is justified.","suggested_fix":"Enumerate the two cases and name the skills that qualify.","evidence":"Round 2 confirmed both cases are enumerated and the seven gproject skills named.","confidence":"high"},
  {"id":"R1-m11","reviewer":"round-1-tests","severity":"minor","file":"src/gdskills/export.ts","problem":"The export manifest still carried usedFallbackBuild after T5 removed the fallback concept.","impact":"A consumer reads a field that no longer means anything.","suggested_fix":"Remove it and bump schemaVersion, with a test tying the two.","evidence":"Round 2 confirmed schemaVersion 2 with a pinning assertion and no usedFallbackBuild in shipped code.","confidence":"high"},
  {"id":"R1-m12","reviewer":"round-1-tests","severity":"minor","file":"src/commands/routing-corpus.ts","problem":"Several skills carried only one paraphrase, so a single wording change could move the record without a real routing regression.","impact":"The corpus measures wording rather than routing for those skills.","suggested_fix":"Require at least two paraphrases per skill.","evidence":"Round 2 scored all 48 added paraphrases: 48 of 48 rank their own skill first and none quotes its own triggers.","confidence":"high"}
]
```
