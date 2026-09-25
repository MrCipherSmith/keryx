# Flow 337 (W4 batch 5) — Consolidated adversarial review, PR #735

Reconstructed faithfully from the flow's own journal
(`.metaproject/flows/337-2026-09-25-wave-4-batch-5-stack-packs-for-php-larav/journal.md`,
lines 68-87) and `git log` on `flow/337-w4b5`. This is the SAME Opus
adversarial review round 1 (0 blocker, 2 major, 7 minor, 2 info) and round 2
narrow verification (mergeable, 0 blocker, 0 major, every round-1 item
confirmed fixed) already recorded in the journal at the time the PR was
merged (squash `5dccc2fd`, PR head `00248d4c`). It is ingested now, after the
merge, purely to satisfy the review-completion gate's requirement for a
managed review package — no new content review is being performed.

Only one of the two "info" items the round-1 summary line counts is
individually itemized anywhere in the journal (the c-cpp
`ownership-unique-vs-shared` scenario note); the second is not separately
described in the journal text available and is not fabricated here.

## Major

### [M1] "Cross-category fixes measurably worked" claim was wrong
- **Severity**: major
- The Phase B journal entry and W1-stack-catalog.md's Phase B section
  claimed the ten "Not for X" description clauses added after the first
  honest gate run "measurably worked" against specific trigger-accuracy
  misses (citing a `ruby-rails-implementation` "Django ORM" flip). A direct
  diff of `(truePositive, falsePositive)` between the two raw gate runs
  showed all 16 skills identical on both counts, with no exception; the
  cited "Django ORM flip" does not exist in the data (the skill's only
  trigger-negative miss in either run was the unchanged same-pack RSpec/
  `ruby-rails-testing` collision).
- **Impact**: a false claim of measured improvement in the flow's own
  record and in the requirements doc, contradicting the flow's own raw
  numbers a few lines above it.
- **Suggested fix**: rewrite both records to state the real mechanism
  (`stripExclusionClauses` removes an entry's own exclusion-clause sentence
  from its scored coverage tokens before either gate run, so a word
  appearing only inside a "Not for X" clause contributes zero coverage with
  or without it) and correct the ten clauses to a routing-weakness
  acceptance, not a verified fix.
- **Evidence**: direct diff of the two raw `governance/eval.json` gate runs;
  `src/gdskills/governance/scout.ts`'s `stripExclusionClauses`.
- **Confidence**: high

### [M2] ruby-rails XSS guidance never actually loaded for `.erb` templates
- **Severity**: major
- `ruby-rails/rules/security.mdc` and `patterns.mdc` carry `raw`/
  `html_safe` XSS guidance that only ever fires on `.erb` templates, but
  neither rule's `paths:` frontmatter glob included `**/*.erb`, and
  `STACK_EXTENSIONS["ruby-rails"]` did not include `erb` either — so the
  rule never actually loaded for the file type its own guidance is about.
- **Impact**: the pack's flagship XSS guidance was dead code for every
  `.erb` file in a Rails project.
- **Suggested fix**: add `"**/*.erb"` to both rules' `paths:` and `"erb"`
  to `STACK_EXTENSIONS["ruby-rails"]`, with a regression test.
- **Evidence**: read of `ruby-rails/rules/security.mdc`/`patterns.mdc`
  frontmatter against `STACK_EXTENSIONS`.
- **Confidence**: high

## Minor

### [minor-1] "Not for a Django/Python view/template" clauses named the specific failing prompt
- **Severity**: minor
- `ruby-rails-code-review`'s and `php-laravel-code-review`'s "Not for X"
  scope clauses named the one stack ("Django/Python") that happened to be
  the failing eval prompt's subject, rather than stating the boundary
  generally.
- **Impact**: reads as tuned to the specific failing prompt wording rather
  than as a freestanding scope statement, even though the Jaccard-overlap
  audit showed it wasn't a near-copy.
- **Suggested fix**: reword to a general statement of the real boundary
  ("Not for a change in another web framework's own MVC/view layer").
- **Evidence**: `ruby-rails-code-review`/`php-laravel-code-review`
  `SKILL.md` description text.
- **Confidence**: medium

### [minor-2] "Not for X" edits also swapped description wording to `raw`, undisclosed
- **Severity**: minor
- Alongside the "Not for an ORM's own migration file" additions,
  `sql-db-build-fix`'s "a migration fails to apply" became "a raw SQL
  migration fails to apply", `sql-db-code-review`'s "a migration or query
  diff" became "a raw .sql migration or query diff", and
  `sql-db-implementation`'s "writing SQL schema" became "writing raw SQL
  schema" — a second, undisclosed wording change riding alongside the
  disclosed one.
- **Impact**: an undisclosed change is a process problem even when the
  content itself is true, because it means the round's own account of what
  changed is incomplete.
- **Suggested fix**: disclose the change explicitly and confirm it states
  the same real scope boundary the exclusion clause already claims (this
  pack covers only raw `.sql` artifacts, never an ORM's own schema/
  migration file in another language).
- **Evidence**: diff of commit `419a8a79`.
- **Confidence**: high

### [minor-3] "Weakest scenario" claim understated how many scenarios were below 1.0
- **Severity**: minor
- `agent-refs.json`'s ruby-rails note and the journal cited only one
  below-1.0 behavior scenario when the official gate run actually had
  three: `ruby-rails-build-fix#no-rubocop-disable-suppression` (0.4, below
  the pack floor on its own), `ruby-rails-testing#no-sleep-for-jobs` (0.8),
  `ruby-rails-testing#stub-external-boundary` (0.9).
- **Impact**: understates the pack's real behavior-scenario weakness.
- **Suggested fix**: name all three scenarios in `agent-refs.json`, the
  journal, and W1's doc.
- **Evidence**: the official `governance/eval.json` gate run's raw scores.
- **Confidence**: high

### [minor-4] `safe-not-null-backfill` rubric contradicted the pack's own documented Postgres/MySQL semantics
- **Severity**: minor
- `sql-db-implementation#safe-not-null-backfill`'s pass/fail criteria only
  accepted the nullable-then-backfill-then-NOT VALID/VALIDATE sequence,
  but Postgres 11+/MySQL 8.0+ apply `ADD COLUMN ... NOT NULL DEFAULT
  <constant>` as a metadata-only change (no full-table rewrite) when the
  default is a literal constant — a distinction `patterns.mdc` itself
  already documented correctly.
- **Impact**: the eval scenario would mark a genuinely correct,
  metadata-only answer as wrong.
- **Suggested fix**: accept either safe path; recalibrate `known_wrong`.
- **Evidence**: `patterns.mdc` lines 21-26 vs the scenario's own rubric.
- **Confidence**: high

### [minor-5] c-cpp `STACK_EXTENSIONS` missing common alternate header/module extensions
- **Severity**: minor
- `STACK_EXTENSIONS["c-cpp"]` was missing `hh`, `ipp`, `inl`, `tpp`,
  `cppm`, `ixx` (alternate C++ header extension, template-implementation
  includes, C++20 module interface units) — real extensions this
  ecosystem uses.
- **Impact**: files using these extensions would not get the c-cpp rules
  applied.
- **Suggested fix**: add them to `STACK_EXTENSIONS["c-cpp"]`.
- **Evidence**: general C/C++ ecosystem knowledge of alternate extensions.
- **Confidence**: medium

### [minor-6] "At-least-once (guarantee/by design)" queue wording overstated
- **Severity**: minor
- Both `php-laravel` and `ruby-rails` SKILL.md bodies, `rules/patterns.mdc`,
  `rules/security.mdc`, and `pack.json` `auditFocus` claimed queue delivery
  is at-least-once "by design"/"guarantee" — but the guarantee is a
  property of the configured queue backend (Laravel's `sync` driver,
  Rails' inline/test adapters have none), not the framework itself.
- **Impact**: guidance overstates a delivery guarantee that depends on
  configuration the reader may not have.
- **Suggested fix**: soften to "most production queue connections/adapters
  are at-least-once" / "depends on the configured connection".
- **Evidence**: Laravel/Rails queue-adapter documentation (general
  knowledge); the packs' own already-correct framing elsewhere.
- **Confidence**: medium

### [minor-7] `ruby-rails-code-review`'s generalized scope clause needed a fresh scout re-run
- **Severity**: minor
- After minor-1's reword, `ruby-rails-code-review`'s new, more general
  "Not for a change in another web framework's own MVC/view layer" clause
  had not been re-scored against `php-laravel-code-review` for overlap.
- **Impact**: an un-rescored clause leaves the scout decision
  (`use`/`fork`) stale for the new wording.
- **Suggested fix**: re-run `keryx skills scout` for the new description
  and record the decision.
- **Evidence**: `keryx skills scout` overlap scoring methodology.
- **Confidence**: medium

## Info

- `c-cpp-implementation#ownership-unique-vs-shared`: the scenario accepted
  only `std::unique_ptr`; a plain by-value `std::ofstream` member (already
  move-only RAII, no pointer needed for a single owner) is an equally
  correct answer. Not a defect requiring a fix by itself, but worth
  recalibrating the rubric to accept either.

```json keryx:findings
{
  "status": "consolidated",
  "reviewer": "review-orchestrator",
  "summary": "Reconstructed from the flow 337 journal's round-1 Opus adversarial review (0 blocker, 2 major, 7 minor, 2 info; only one info item is individually itemized in the journal text) and round-2 narrow verification (mergeable, 0 blocker, 0 major, every round-1 item confirmed fixed) of PR #735, ingested after the merge to satisfy the review-completion gate. No new content review performed.",
  "findings": [
    {
      "id": "M1",
      "reviewer": "review-orchestrator",
      "severity": "major",
      "file": "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md",
      "problem": "the journal and W1 doc claimed the ten post-gate \"Not for X\" description clauses \"measurably worked\" against specific trigger-accuracy misses, citing a ruby-rails-implementation \"Django ORM flip\" that does not exist in the raw gate data",
      "impact": "a false claim of measured improvement stood in the flow's own record, contradicting its own raw (truePositive, falsePositive) numbers a few lines above it",
      "suggested_fix": "rewrite to state the real mechanism (stripExclusionClauses zeroes an exclusion clause's own coverage contribution before either gate run) and reclassify the ten clauses as a routing-weakness acceptance, not a verified fix",
      "evidence": "direct diff of the two raw governance/eval.json gate runs showed all 16 skills identical on (truePositive, falsePositive); src/gdskills/governance/scout.ts stripExclusionClauses",
      "confidence": "high",
      "class_scope": {
        "sites": [
          "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md",
          ".metaproject/flows/337-2026-09-25-wave-4-batch-5-stack-packs-for-php-larav/journal.md"
        ],
        "enumeration_method": "both records repeated the same erroneous \"measurably worked\" claim; grep for that phrase across the flow's own journal and requirements doc found exactly these two sites"
      }
    },
    {
      "id": "M2",
      "reviewer": "review-orchestrator",
      "severity": "major",
      "file": "src/gdskills/bundled/stacks/ruby-rails/rules/security.mdc",
      "problem": "ruby-rails's raw/html_safe XSS guidance in security.mdc/patterns.mdc only ever fires on .erb templates, but neither rule's paths: frontmatter included **/*.erb and STACK_EXTENSIONS[\"ruby-rails\"] did not include erb",
      "impact": "the pack's XSS guidance was dead code for every .erb file in a Rails project",
      "suggested_fix": "add **/*.erb to both rules' paths: and erb to STACK_EXTENSIONS[\"ruby-rails\"], with a regression test",
      "evidence": "read of ruby-rails/rules/security.mdc and patterns.mdc frontmatter against STACK_EXTENSIONS in src/gdskills/governance/authoring-lint.ts",
      "confidence": "high",
      "class_scope": {
        "sites": [
          "src/gdskills/bundled/stacks/ruby-rails/rules/security.mdc",
          "src/gdskills/bundled/stacks/ruby-rails/rules/patterns.mdc",
          "src/gdskills/governance/authoring-lint.ts"
        ],
        "enumeration_method": "grep for raw/html_safe XSS guidance across ruby-rails rules and cross-checked each rule's paths: glob and STACK_EXTENSIONS for .erb coverage"
      }
    },
    {
      "id": "minor-1",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/ruby-rails/skills/ruby-rails-code-review/SKILL.md",
      "problem": "the \"Not for a Django/Python view/template\" scope clauses in ruby-rails-code-review and php-laravel-code-review named the specific stack that happened to be the failing eval prompt's subject",
      "impact": "reads as tuned to the specific failing prompt rather than a freestanding scope statement",
      "suggested_fix": "reword to a general statement of the real boundary (\"Not for a change in another web framework's own MVC/view layer\")",
      "evidence": "ruby-rails-code-review and php-laravel-code-review SKILL.md description text",
      "confidence": "medium"
    },
    {
      "id": "minor-2",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/sql-db/skills/sql-db-build-fix/SKILL.md",
      "problem": "the \"Not for X\" edits also swapped description wording to `raw` (e.g. \"a migration fails to apply\" -> \"a raw SQL migration fails to apply\") alongside the disclosed exclusion-clause additions, without being called out as a separate change",
      "impact": "an undisclosed second change alongside a disclosed one leaves the round's own account of what changed incomplete",
      "suggested_fix": "disclose the change explicitly and confirm it restates the same real scope boundary (this pack covers only raw .sql artifacts, never an ORM's own schema/migration file)",
      "evidence": "diff of commit 419a8a79",
      "confidence": "high"
    },
    {
      "id": "minor-3",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/ruby-rails/agent-refs.json",
      "problem": "agent-refs.json's ruby-rails note and the journal cited only one below-1.0 behavior scenario when the official gate run had three (no-rubocop-disable-suppression 0.4, no-sleep-for-jobs 0.8, stub-external-boundary 0.9)",
      "impact": "understates the pack's real behavior-scenario weakness",
      "suggested_fix": "name all three scenarios in agent-refs.json, the journal, and W1's doc",
      "evidence": "the official governance/eval.json gate run's raw per-scenario scores",
      "confidence": "high"
    },
    {
      "id": "minor-4",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/sql-db/skills/sql-db-implementation/evals.json",
      "problem": "safe-not-null-backfill's pass/fail criteria only accepted the nullable-then-backfill-then-NOT VALID/VALIDATE sequence, contradicting patterns.mdc's own documentation that Postgres 11+/MySQL 8.0+ apply a constant-default ADD COLUMN NOT NULL as metadata-only",
      "impact": "the eval scenario would mark a genuinely correct, metadata-only answer as wrong",
      "suggested_fix": "accept either safe path; recalibrate known_wrong to a case that genuinely doesn't get the fast path",
      "evidence": "src/gdskills/bundled/stacks/sql-db/rules/patterns.mdc lines 21-26 vs the scenario's own rubric",
      "confidence": "high"
    },
    {
      "id": "minor-5",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/governance/authoring-lint.ts",
      "problem": "STACK_EXTENSIONS[\"c-cpp\"] was missing hh, ipp, inl, tpp, cppm, ixx -- real alternate C++ header/module extensions this ecosystem uses",
      "impact": "files using these extensions would not get the c-cpp rules applied",
      "suggested_fix": "add them to STACK_EXTENSIONS[\"c-cpp\"]",
      "evidence": "general C/C++ ecosystem knowledge of alternate header and C++20 module-interface extensions",
      "confidence": "medium"
    },
    {
      "id": "minor-6",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/php-laravel/rules/patterns.mdc",
      "problem": "php-laravel and ruby-rails SKILL.md bodies, rules/patterns.mdc, rules/security.mdc, and pack.json auditFocus claimed queue delivery is at-least-once \"by design\"/\"guarantee\", which depends on the configured queue backend (Laravel's sync driver, Rails inline/test adapters have none), not the framework itself",
      "impact": "guidance overstates a delivery guarantee that depends on configuration the reader may not have",
      "suggested_fix": "soften to \"most production queue connections/adapters are at-least-once\" / \"depends on the configured connection\"",
      "evidence": "Laravel/Rails queue-adapter documentation (general knowledge); the packs' own already-correct framing elsewhere",
      "confidence": "medium"
    },
    {
      "id": "minor-7",
      "reviewer": "review-orchestrator",
      "severity": "minor",
      "file": "src/gdskills/bundled/stacks/ruby-rails/governance/scout.json",
      "problem": "after minor-1's reword, ruby-rails-code-review's new, more general scope clause had not been re-scored against php-laravel-code-review for overlap",
      "impact": "an un-rescored clause leaves the scout use/fork decision stale for the new wording",
      "suggested_fix": "re-run keryx skills scout for the new description and record the decision",
      "evidence": "keryx skills scout overlap scoring methodology",
      "confidence": "medium"
    },
    {
      "id": "info-1",
      "reviewer": "review-orchestrator",
      "severity": "info",
      "file": "src/gdskills/bundled/stacks/c-cpp/skills/c-cpp-implementation/evals.json",
      "problem": "ownership-unique-vs-shared scenario accepted only std::unique_ptr; a plain by-value std::ofstream member (already move-only RAII) is an equally correct answer for a single owner",
      "impact": "a genuinely correct alternative answer would be marked wrong",
      "suggested_fix": "accept either answer in the rubric/pass-criteria/known_right",
      "evidence": "general C++ RAII/move-semantics knowledge",
      "confidence": "medium"
    }
  ],
  "stats": { "blocker": 0, "major": 2, "minor": 7, "info": 1 }
}
```
