# Flow 308 — keryx review conform — review record

Two review rounds ran against this flow's implementation, both fixed within
PR #711 (squash `8a8452b3954456506aa1e90af2b30837c782998e`) before merge. No
finding below quotes or paraphrases any text from the operator's private
reference document; every description is a class of defect, not a document
excerpt.

## Round 1

Four blockers: clause text reaching a model call or a log line unredacted;
the reference document's own file path being handed to the `--explain` pass
instead of only its (redacted) basename; the tag-cache file living outside
`.gitignore` and without restrictive file permissions; and journal entries
carrying private, heading-derived clause-id wording instead of anonymized
labels. Two majors: a stale-run race in the `/conform` TUI inspector, and the
PR-reading port shelling out to `gh` with no timeout.

## Round 2

One major: even fully invented, the committed fixtures' domain and structure
still read as correlated with the private document's own shape, so they were
rewritten into an unrelated domain. One minor: a field name and its
criterion wording were renamed to a neutral term ("anchor kind") after the
same privacy pass, so no committed wording leans on the private document's
own vocabulary.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "blocker",
    "problem": "A reference document's clause text could reach a Jev question or a log/journal line without passing through redactSensitiveText first.",
    "impact": "Sensitive or private reference-document text could leave the machine unredacted, or be written unredacted into a local log.",
    "suggested_fix": "Route every clause-text interpolation (the tag-choice question, the conform question, any printed/logged excerpt) through redactSensitiveText before it is used.",
    "evidence": "src/review/conform-clauses.ts and src/review/conform-jev.ts: clause text was interpolated into model-bound strings without redaction.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/conform-clauses.ts", "src/review/conform-jev.ts"],
      "enumeration_method": "grep for redactSensitiveText and for clause.text interpolation across every file touching a reference-document clause"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "blocker",
    "problem": "The reference document's own filesystem path (not just its content) reached the --explain pass and its output, rather than only a redacted basename.",
    "impact": "The path to a private reference document could leak into advisory output, a log, or an explanation prompt.",
    "suggested_fix": "Pass only redactSensitiveText(path.basename(refPath)) into anything --explain touches; never the full path.",
    "evidence": "src/commands/review.ts: the reference-document path was used directly instead of a redacted basename.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/review.ts"],
      "enumeration_method": "grep for refPath usage in review.ts's conform/--explain code paths"
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "blocker",
    "problem": "The clause-tag cache file (naming reference documents and their per-clause tags) was neither gitignored nor written with restrictive file permissions.",
    "impact": "A cache file naming a private reference document and its tags could be committed by accident, or read by another local user.",
    "suggested_fix": "Gitignore the cache directory and write the cache file with 0o600.",
    "evidence": "src/review/conform-tag-cache.ts and .gitignore: the cache file had no mode restriction and no gitignore entry.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/conform-tag-cache.ts", ".gitignore"],
      "enumeration_method": "grep for the cache file's write call and for its directory in .gitignore"
    }
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "blocker",
    "problem": "Flow journal entries recorded a live check's per-clause results using the reference document's own heading-derived clause ids, rather than anonymized labels.",
    "impact": "A durable, committed-adjacent record (the flow journal) could carry wording derived from a private document's own headings.",
    "suggested_fix": "Anonymize clause ids in any journal entry describing a live run against a private document: group by heading, then relabel with neutral, order-assigned labels, dropping any heading-derived wording.",
    "evidence": "flow journal for this flow: the live-check entry now groups clause ids under neutral relabelled sections (e.g. sectionA-1) with a note stating no heading-derived wording is retained.",
    "confidence": "high",
    "class_scope": {
      "sites": [".metaproject/flows/308-2026-09-25-keryx-review-conform-check-a-pr-a-review/journal.md"],
      "enumeration_method": "read every journal entry describing a live run against the private document; one entry does this (AC11 live check)"
    }
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The /conform TUI inspector's abort of an in-flight run could still let that run's promise settle after a newer run had already written its own result, overwriting the newer result with stale data.",
    "impact": "A user who re-runs conform quickly could see a stale verdict silently replace a fresh one.",
    "suggested_fix": "Compare a run's identity/generation against the current one before writing its result, discarding a late-arriving stale settlement.",
    "evidence": "src/tui/conform-inspector.ts: options.run's promise could settle after AbortController.abort() with no generation check before writing.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/conform-inspector.ts"],
      "enumeration_method": "grep for AbortController/abort in conform-inspector.ts; one run-dispatch site"
    }
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The PR-reading port (gh pr view / gh pr diff) had no timeout, so a hung gh process could block a conform run indefinitely.",
    "impact": "A single stalled gh call hangs `review conform --pr` with no bound.",
    "suggested_fix": "Add a spawn timeout and output cap to the port's gh calls, mirroring the CI-triage port's existing pattern.",
    "evidence": "src/review/conform-pr-port.ts: defaultConformSpawn now carries CONFORM_SPAWN_TIMEOUT_MS and a byte output cap, killing a hung child rather than waiting forever.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/conform-pr-port.ts"],
      "enumeration_method": "grep for Bun.spawn in conform-pr-port.ts; one spawn helper, shared by every gh call"
    }
  },
  {
    "id": "F-007",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The committed conform fixtures, though entirely invented, were structured and phrased closely enough to the operator's real private reference document that their shape and wording still read as correlated with it.",
    "impact": "A committed fixture that mirrors a private document's structure and phrasing risks leaking information about that document's shape even without copying its text.",
    "suggested_fix": "Rewrite the fixtures into an unrelated domain and structure, keeping only the mechanical shape a parser needs (numbered/bulleted items under headings) and none of the private document's own organization.",
    "evidence": "src/review/fixtures/conform/invented-doctrine.md and src/commands/fixtures/conform/invented-ref.md: rewritten into a data-pipeline contribution policy (an unrelated domain), independently structured from the operator's example.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/fixtures/conform/invented-doctrine.md", "src/commands/fixtures/conform/invented-ref.md"],
      "enumeration_method": "read every committed conform fixture; both were rewritten in the same pass"
    }
  },
  {
    "id": "F-008",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "problem": "A finding field name and its AC criterion wording described report-kind facts in terms that, combined with the fixture-correlation gap above, leaned on vocabulary closer to the private document's own domain than necessary.",
    "impact": "Committed wording (docs and the acceptance criterion text) carried a naming choice more specific than the neutral concept it describes.",
    "suggested_fix": "Rename the field to a neutral term and reword the criterion to describe the general concept (which fields a finding records, such as a file anchor) rather than a domain-specific one.",
    "evidence": "src/review/conform-state.ts / conform-state.test.ts: the finding-location field was renamed to an anchor-kind concept (classifyFindingAnchor), and this flow's AC4 was reworded to match (flow journal, ac-updated entry).",
    "confidence": "medium"
  }
]
```
