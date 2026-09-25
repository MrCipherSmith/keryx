# Review — flow 333, Jev reviewers for review hygiene (PR #727)

`review-jev-docs` and `review-jev-comments`: two additional CLI-engine Jev
reviewers (`src/review/jev-docs.ts`, `src/review/jev-comments.ts`,
`src/commands/review-jev-docs.ts`, `src/commands/review-jev-comments.ts`,
their `SKILL.md`s, tests and docs). `jev-docs` links doc sections to code a
diff changed and asks Jev whether the section is now stale; `jev-comments`
reads the existing PR comment ledger and asks Jev to classify each open
comment (read-only, no GitHub write).

**Round 1** ran against the branch's first commit,
`5fb9c326b503ded24e01098b5793864489904e78`, and found `jev-docs` useless on
this repository in practice: a live run linked 1,454-2,361 doc sections per
PR, almost all of them `.metaproject/skills/**`/`.metaproject/rules/**`
prose, selected alphabetically with no per-file cap — so the `--max-calls`
budget was filled entirely by skill/rule prose (`.metaproject` sorts before
`docs`) before any `docs/**` section was ever reached, and every run reported
"0 findings" that actually meant "nothing under `docs/**` was scored". A
separate issue in the same commit: `renderSectionFacts` sent a linked
section's full, unbounded text to Jev, and a dense, heading-sparse file
(`docs/docs/cli-reference.md`) produced a section that passed the module's
own 64k `estimateTokens` preflight (chars/4 estimate) but still exceeded the
vendor's real token ceiling, so the call failed at the vendor with a live
`400 max_tokens exceeded`-class error rather than being sent bounded like the
hunk text already was.

Both were fixed on the branch before push — the section-text bound is
already present in `5fb9c326` itself (the earlier of the two fixing commits,
landed as part of finishing the same commit rather than as a separate one),
and the corpus/ranking/per-file-cap fix is a later, distinct commit,
`840e65505ddcc03e7cb1a2466354dedc02565139` ("fix(review): jev-docs checks
user-facing docs, ranked by link strength, capped per file"). A merge of
`origin/main` into the branch (merge commit
`0ba249102fffb85bd7ae29738929757566b74aba`, head of PR #727) followed and
was reviewed for conflict-resolution correctness only — no functional change
beyond the merge itself.

PR #727 squash-merged as `e5b45ac6f6aa3a99bf4146ec90c3e039c0d25504` into
`main`; CI is 19/19 green on the PR (`gh pr view 727 --json
statusCheckRollup`).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/commands/review-jev-docs.ts",
    "problem": "Before the fix, `discoverDocFiles` walked `.metaproject/skills/**`, `.metaproject/project-skills/**`, `.metaproject/rules/**` and `rules/**` by default, alongside `docs/**` and `README*` — the entire project-authoring corpus, not just user-facing documentation.",
    "impact": "A live run of the reviewer against keryx's own repository linked 1,454-2,361 doc sections per PR, almost all of them skill/rule prose, which sorts alphabetically ahead of `docs/**` (`.metaproject` < `docs`). Combined with F-002's alphabetical selection, the `--max-calls` budget was exhausted by skill/rule prose before any `docs/**` section was ever reached, so every run reported \"0 findings\" that actually meant \"nothing under docs/** was ever scored\" — the reviewer never did the job it was built for on this repository.",
    "suggested_fix": "Narrow the default corpus to user-facing documentation only (`docs/**`, the repo's own `README*`, gdwiki pages), and add a repeatable `--include <glob>` escape hatch back to the wider corpus for a project that genuinely wants it scored too.",
    "evidence": "Pre-fix `discoverDocFiles` (commit 5fb9c326) walked skills/rules directories unconditionally; the live run against PRs #712/#717/#710 linked thousands of sections dominated by `.metaproject/**` prose, with zero `docs/**` sections ever scored.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/review-jev-docs.ts discoverDocFiles — the sole entry point that builds the default doc corpus for review-jev-docs"
      ],
      "enumeration_method": "read every caller of discoverDocFiles and every directory it walked by default in review-jev-docs.ts; discoverDocFiles is the only corpus-selection site, so it is the class's only member"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/jev-docs.ts",
    "problem": "Before the fix, the linked-sections selection in `boundLinkedSections` filled the `--max-calls` budget by filesystem/alphabetical order, not by evidence strength — a section linked by an exact changed-file path mention had no priority over one linked by a weaker, more ambiguous match, and whichever file happened to sort first won the budget.",
    "impact": "Even with a narrowed corpus (F-001), a large or alphabetically-early doc file could still consume the whole run before a more strongly-evidenced section elsewhere was ever asked about, and there was no way to audit after the fact why a given selection was made.",
    "suggested_fix": "Rank linked sections by evidence strength before bounding: an exact changed-file path mention outranks a symbol mention, which outranks a keryx-verb mention; within the same kind, more distinct links to changed code outrank fewer; ties break by stable file/line order. Surface the ranking basis in `--json` so a run's choice is auditable.",
    "evidence": "Pre-fix selection sliced `linked` directly into `selected`/`dropped` with no ranking step; the live before/after comparison on PRs #712/#717/#710 recorded in the flow journal shows linked-section counts dropping from 2225/1847/2288 (alphabetical, broad corpus) to 1905/1497/1898 (ranked, narrowed corpus) with docs/** sections now actually reached and scored.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/jev-docs.ts boundLinkedSections (line 340) — the sole function that turns linked sections into the selected/dropped call budget",
        "src/review/jev-docs.ts compareByRank (line 326) — the comparator boundLinkedSections sorts by"
      ],
      "enumeration_method": "grepped every site in jev-docs.ts that produces JevDocsSelection.selected; boundLinkedSections is the only one, and compareByRank is its only ordering function"
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/review/jev-docs.ts",
    "problem": "Before the fix, `boundLinkedSections` had no per-doc-file cap: one large file (a long CLI reference, a sprawling README) could fill the entire `--max-calls` budget by itself, regardless of how many other doc files had linked sections.",
    "impact": "A single large, heavily-linked doc file could crowd out every other doc file in a run, even after F-001/F-002 narrowed and ranked the corpus.",
    "suggested_fix": "Add a per-doc-file cap (`DEFAULT_MAX_SECTIONS_PER_DOC_FILE = 8`) enforced alongside `--max-calls` in `boundLinkedSections`, with every drop still reported in `dropped` and the cap stated in `rankingBasis`.",
    "evidence": "Pre-fix `boundLinkedSections` bounded only by `maxCalls` with a single running counter and no per-file tracking; the fixed version tracks `perFile` per `item.section.file` and drops once `usedForFile >= maxPerFile`.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/review/jev-docs.ts",
    "problem": "Before the fix, `renderSectionFacts` sent a linked section's full, unbounded text to Jev with no per-section character cap — only the hunk text (`HUNK_TEXT_CHARS`) was bounded. `batchDocsSections`'s own `estimateTokens` preflight (chars/4) is an estimate, and a heading-sparse file can produce one very large, dense section that passes that 64k preflight while still exceeding the vendor's real token ceiling.",
    "impact": "A live run against this repository's own `docs/docs/cli-reference.md` hit the vendor's real token ceiling on an unbounded section (an HTTP-400-class `max_tokens exceeded` failure) despite passing the module's own preflight — the batch was estimated fine and still got rejected, failing the whole run rather than degrading gracefully.",
    "suggested_fix": "Bound per-section text the same way `HUNK_TEXT_CHARS` already bounds a hunk: cap at `SECTION_TEXT_CHARS` (4,000) characters, appending a `(truncated)` marker, as cheap insurance against a batch that estimates fine and still gets rejected.",
    "evidence": "Pre-fix `renderSectionFacts` (commit 5fb9c326, before its own section-cap fix) interpolated `redactSensitiveText(linked.section.text)` directly with no length bound; the fixed version (SECTION_TEXT_CHARS = 4_000, jev-docs.ts:394) truncates and appends \"… (truncated)\", mirroring the existing HUNK_TEXT_CHARS = 2_000 bound at jev-docs.ts:381.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/review/jev-docs.ts renderSectionFacts (line 410) — the sole site that renders a linked section's text into the Jev question state",
        "src/review/jev-docs.ts SECTION_TEXT_CHARS (line 394) — the bound renderSectionFacts enforces"
      ],
      "enumeration_method": "grepped every site in jev-docs.ts that interpolates LinkedSection.section.text or a hunk region's text into question state; renderSectionFacts is the only one, and it now bounds both the section text (SECTION_TEXT_CHARS) and each hunk's text (HUNK_TEXT_CHARS)"
    }
  }
]
```
