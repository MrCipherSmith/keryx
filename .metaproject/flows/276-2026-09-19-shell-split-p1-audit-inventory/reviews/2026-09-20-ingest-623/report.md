# Managed Review — Flow 276 (shell god-file split, P1)

PR #623, merged as `5a04f2068c4b9cda0486c7eeffad2ae4c586eaf5`.

## Scope reviewed

- Full commit diff (`git show --stat 5a04f206` plus every changed file): docs
  under `docs/requirements/keryx-shell-split/` and `docs/requirements/backlog.md`
  / `docs/requirements/roadmap.md`, the flow's own package, and the two
  non-doc, non-metaproject files: `package.json` (one `test:core` line) and the
  new guard test `src/shell-source-audits.test.ts` (169 lines).
- Read `src/shell-source-audits.test.ts` in full, including the scan helper
  `pathsNamedOn` (:70-83) and `scanSourceTextAudits` (:95-115), and checked it
  against the two forms the flow's own inventory names as tricky: a bare
  helper call (`source("commands/shell.ts")`) and a multi-segment
  `path.join(import.meta.dir, "..", "tui", "tui-shell.ts")` call. Both are
  handled correctly: the helper form resolves against `HERE` (`src/`) as a
  second base (:80), and the joined form is reconstructed by
  `literals.slice(0, fileSegment + 1).join("/")` (:76) before being resolved
  against the test file's own directory.
- Did NOT re-verify every line-number claim inside the prose tables of
  `audits-commands.md`, `audits-cross-cutting.md`, `audits-tui-other.md` and
  `audits-tui-shell.md` against the current tree. The guard test's own header
  comment (`src/shell-source-audits.test.ts:121-124`) states line numbers in
  those tables are documentation and assert nothing, and the flow is P1
  (inventory only, no conversion), so a stale line number there does not
  change any test's pass/fail outcome. Treated as out of scope for the same
  reason the guard itself gives.
- Did not re-run the test suite; CI is recorded green on the PR (flow
  journal, AC9).

## Findings

### Info

- [F-001] info: the comment filter in `pathsNamedOn` (`src/shell-source-audits.test.ts:70-72`)
  only recognises a comment when the TRIMMED line itself starts with `//`,
  `*` or `/*`. It does not filter a trailing comment on an otherwise-code
  line (`const x = 1; // "commands/shell.ts"` would count as a site — a
  false positive, safe direction), and it cannot see a path literal split
  across two lines by string concatenation (`"commands/" +` on one line,
  `"shell.ts"` on the next — a false negative, the unsafe direction: a real
  text-dependency on the god-files could exist and never appear in the
  manifest, so a later split could break it silently without the guard
  noticing). I did not find an actual instance of the split-literal form in
  the current test suite — this is a latent gap in the scanner, not a
  demonstrated miss today, which is why it is `info` rather than `minor`.
  - severity: info
  - impact: No behavioural risk today. If a future audit reads one of the
    two god-files' paths built from string concatenation across lines
    (none currently do, based on reading every file the scanner already
    flags plus a manual check of the other test files), it would silently
    miss the manifest, and P2/P3 could then remove or move that audit's
    covered code without the guard catching the drop.
  - suggested_fix: Either collapse each test file's source to a single
    string with newlines preserved before matching (so a literal spanning
    two physical lines is still one logical unit for the regex), or add a
    boundary test asserting a synthetic fixture with a concatenated literal
    is still caught. Not blocking for P1, which is a documentation flow.
  - evidence: src/shell-source-audits.test.ts:70-72 (the `code.startsWith`
    filter); :42 (`LITERAL` regex, anchored to `[^\n]`, i.e. cannot span a
    newline).
  - confidence: medium
  - reviewer: sonnet-5-review-p2b

## What I did not find

No blocker, major or minor findings. The two audits this flow's inventory
calls "wrong today" (the `runAgentRepl` window bug and the `process.once`
file-list ban) are documentation claims about EXISTING test fragility that
this flow correctly describes and defers to P2/P3 — flow 276 itself touches
no production code and does not claim to fix either. I checked both claims
against the current tree and found them accurate: `runAgentRepl` does close
well before the audited window's end, and `mcp-servers/invariants.test.ts`'s
process.once ban does name `../commands/shell.ts` by a hardcoded path.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-5-review-p2b",
    "severity": "info",
    "problem": "The comment filter in `pathsNamedOn` (src/shell-source-audits.test.ts:70-72) only recognises a comment when the trimmed line itself starts with `//`, `*` or `/*`. It does not filter a trailing same-line comment (false positive, safe direction) and cannot see a path literal split across two lines by string concatenation (false negative, the unsafe direction for a guard whose entire purpose is to prevent silently missing a text-dependency on the two god-files).",
    "impact": "No behavioural risk today: reading every file the scanner already flags plus the other test files in src/, none builds a god-file path via cross-line string concatenation. If one ever did, it would silently miss the manifest, and a later phase (P2/P3) could remove or move that audit's covered code without this guard noticing the drop.",
    "suggested_fix": "Either collapse each test file's source to a single string with newlines preserved before matching so a literal spanning two physical lines is still one logical match, or add a boundary test asserting a synthetic fixture with a concatenated literal is still caught. Not blocking for P1, which is a documentation-only flow.",
    "evidence": "src/shell-source-audits.test.ts:70-72 (`function pathsNamedOn`, the comment-prefix filter); src/shell-source-audits.test.ts:42 (`const LITERAL = /[\"'`]([^\"'`\\n]+)[\"'`]/g`, anchored to `[^\\n]` so it cannot match across a line break).",
    "confidence": "medium"
  }
]
```
