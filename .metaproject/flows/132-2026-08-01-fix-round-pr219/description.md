# Fix round — PR #219 (flow 130)

## Problem

The consolidated review of PR #219 and PR #220
(`.metaproject/reviews/2026-08-01-ingest-feat-r4c-turn-submission/report.md`)
returned REQUEST_CHANGES for both branches. Three of its findings belong to
`fix/216-round4-findings` and must land before PR #220 can be rebased onto it —
`readTranscriptFile`, which this branch introduces, is the helper PR #220 needs
in order to fix its own blocker.

The three:

- **F-014 (major)** — a behavioural regression in session resume.
  `loadArchive` reads `archive.jsonl` before its fallback, so a
  `TranscriptUnreadableError` on the archive aborts a resume whose
  `context.jsonl` is perfectly readable. `archive.jsonl` is the file most likely
  to exceed the 64 MiB bound. All three catch sites respond by starting a brand
  new session, so a resumable conversation is dropped rather than resumed
  without its archive. Two callers of the newly-throwing readers are unguarded:
  `src/commands/sessions.ts:70` and `src/tui/tui-shell.ts:1563`.
- **F-013 (major)** — flow 130's AC8 covers a subset of its own class. AC8
  claims every operator instruction printed by `keryx serve` is executed
  verbatim; the extractor at `src/commands/serve.recovery.test.ts:487` matches
  only `keryx serve config …`. Fifteen printed instructions exist; the
  `token issue` / `token rotate` and bare
  `keryx serve --acknowledge-non-loopback` forms are `toContain`-asserted only.
- **F-015 (major)** — the ingest parser still creates phantom findings from
  prose. `9d4d3b84` required a finding identifier to OPEN the line; ordinary
  text wrapping routinely puts a reference at line start, and an opening
  parenthesis before it is not an accepted marker. Ingesting the review report
  produced eight phantoms from its own "Recommended order" section, and the
  rewrite of that section reproduced the defect a second time.

Plus one minor from the same report: flow 130's journal claims the readers guard
reported both reads, while the scanner emits one offence per (file, call) pair
and the recorded output shows one entry. The claim overstates its evidence.

## Expected Outcome

`fix/216-round4-findings` merges. Each of the three findings is fixed at the
level of its class rather than its named site, `bun test` is green, and the
journal claim matches the evidence it cites.

## Out of Scope

- Every finding scoped to `feat/r4c-turn-submission` (F-001 … F-012). Those are
  the next flow, after this branch lands and #220 is rebased onto it.
- The `readdirSync` per-call exemption PR #220 needs (F-012) — it is added
  during the rebase, on #220, because the offending file does not exist here.
- The minor/info set of the review that is not listed above.
</content>
