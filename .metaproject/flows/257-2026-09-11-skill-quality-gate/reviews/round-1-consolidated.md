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
