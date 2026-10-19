# Module src/decisions

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/decisions` is the recommendation journal: an append-only record of each question put to the operator, the arm (A to D) it was shown in, and whether the answer followed the recommendation. It groups 34 file(s), depends on `src/lib`, `src/flow` and `src/security`, and exposes 20 public symbol(s) through `service.ts`.

## Overview

`src/decisions` owns the record of decisions the agent puts to a human: the question, the options, the recommendation, and the human's answer and optional reason. Its purpose is to measure how often people follow a recommendation, and whether showing it, hiding it, or reordering the options changes that. The module is written so the command layer, the TUI and the chat shells reach it only through `service.ts`. Asking the human and talking to a model stay outside it.

## How it works

Three layers sit behind one facade. `service.ts` is the only door: it re-exports the operations from `journal.ts`, the arm logic from `arms.ts`, and the report from `report.ts`, and adds the read-side helpers (`loadReport`, `reportText`, `reportLine`, the counts). Callers never import the files behind it.

Storage is `store.ts` and `types.ts`. `types.ts` defines three record kinds, all folded by id: an `open` record (written before the question is shown, so the recommendation cannot be edited afterwards), `answer` records (`seq` 1 for the first, higher for a changed answer), and at most one `reason` record, where the latest wins. `store.ts` keeps them as JSONL in `.metaproject/data/decisions/journal.jsonl`, under the main checkout so linked worktrees share one journal. `readJournal` drops lines that are not JSON or not a well-formed record, and counts them so the report can show the number. `withJournalLock` serialises a read-then-append, which only the import and the open path need.

Assignment is `arms.ts`. Four arms are defined by three factors (order, mark, preselect). `chooseArm` is a pure function of a repository salt and the journal position `seq`, so a repeated run gives the same arm. The salt is kept outside the repository, in the user config directory, and the journal stores only a 32-bit `seed` derived from it. An irreversible question is always arm A with `forced: true`.

The operations are in `journal.ts`. `openDecision` and `answerDecision` are the write path, and `recordReason` adds the optional "why". `report.ts` is the read path: `buildReport` is pure arithmetic over the records, with no clock and no randomness, and `renderReport` and `renderReportLine` turn it into text. The report counts the first answer for match shares. A later change is counted on its own line.

## Key concepts

- **Decision**: one `open` record, identified by `id` (`d-<time>-<random>`). It carries the question, the options in the order the agent gave them, an optional `recommendation` (an option id plus a reason), the `flow` it belongs to, and the `channel` and `source` it was asked on.
- **Answer and reason**: an answer is a choice that must match an option id, unless it is the human's own text (`other: true`). The answer is redacted, stored in one line, and kept in full in `text`. A reason is a separate record, and the report treats the latest one as current.
- **Arm A, B, C, D**: A is the ordinary question with the mark shown and the recommended option preselected. B keeps the mark but does not preselect. C shuffles the order and keeps the mark. D shuffles, hides the mark, and does not preselect (the blind question). `mode` is derived from the arm: A is `ordinary`, D is `blind`, and B and C are `partial`.
- **Forced versus free A**: an A that comes from the draw is "free". An A forced by an irreversible flag, an `action` tag, or a `blind.ts` match is "forced", and it is not randomized (`eligible: false`). A question with no recommendation is always A and is also not compared.
- **Reason subsample**: a deterministic hash of `seed` and `seq` puts about one third of eligible questions into a `reasonRequested` group. Those are asked for a reason whatever the answer. A deviation is always asked, on any surface that can take free text. `KERYX_DECISIONS_REASON_SUBSAMPLE=off` turns the subsample off.
- **Legacy and backfilled records**: a record from before the arms has no `arm` and is read through `effectiveArm`, where ordinary means A and blind means D. A backfilled record is one imported after the fact (`backfilled: true`). It is never blind, its time to answer is unknown, and it is reported in a block of its own.
- **Settings**: `.metaproject/decisions.config.json` may set the arm `weights` (default 0.4, 0.2, 0.2, 0.2) and the `perArmThreshold` (default 150). Anything unusable is named and falls back to its default.

## Main flows

1. **Open a question** (`openDecision`, `openLocked`). The call takes the journal lock. It looks for an unanswered open record for the same question in the same session, less than an hour old, and returns that arm again if it finds one. Otherwise it loads the salt and sets `seq` to the number of open records plus one. It calls `chooseArm`, shuffles the options for arms C and D, and sets `showMark` and `preselected` from `ARM_FACTORS`. It appends the `open` record before any question is shown, and returns the arm, order and flags for the surface to display.

2. **Answer** (`answerDecision`). The function finds the open record by id and refuses backfilled ones. It checks the choice against the options, or stores the own text when `other` is set, and appends an `answer` record with `seq` equal to the prior answers plus one. `matched` is true when the choice equals the recommendation and false on a deviation. `journalToFlow` then appends one line to the flow's `journal.md`, unless the flow was only inferred. The result's `askReason` is true for a deviation or a `reasonRequested` decision that has no reason yet and has not already been offered one. `recordReason` writes the reason, and a reason is also added to the flow journal.

3. **Report** (`loadReport`, then `renderReport`). The function reads the journal with `readJournal`, then the quality ratings (`readQuality`) and the settings (`loadDecisionsSettings`). `buildReport` folds the records by id and keeps the first answer for matches. It builds the by-mode, by-stage, arm, channel, reason, progress and legacy blocks, and counts the lines it skipped. `reportLine` gives the one-line Russian summary used in the daily topic message. The shares count only the headline `tui` channel for the arm table.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `loadReport`
- `reportText`
- `reportLine`
- `decisionCount`
- `annotatedCount`
- `backfilledCount`
- `CANCEL_ANSWER`
- `journalAsk`
- `DECISION_SOURCES`
- `WORK_DECISION_SOURCES`
- `BLIND_PROBABILITY`
- `DEFAULT_IRREVERSIBLE`
- `isIrreversible`
- `loadDecisionsConfig`
- `answerDecision`
- `openDecision`
- `recordReason`
- `buildReport`
- `renderReport`
- `renderReportLine`

### Key files

- `src/decisions/service.ts` - imported by 24, imports 15
- `src/decisions/store.ts` - imported by 26, imports 2
- `src/decisions/types.ts` - imported by 20, imports 1
- `src/decisions/arms.ts` - imported by 17, imports 3
- `src/decisions/journal.ts` - imported by 14, imports 6
- `src/decisions/report.ts` - imported by 8, imports 5

### Depends on

- `src/lib` - 2 import(s)
- `src/flow` - 2 import(s)
- `src/security` - 2 import(s)

### Depended on by

- `src/commands` - 4 import(s)
- `src/tui` - 4 import(s)
- `src/review` - 1 import(s)

### Dependency basis

- Production imports only: 27 import(s) from test file(s) (e.g. `src/commands/research-sync.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 34
- Cross-module imports: 6

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/flow](src-flow.md)
- [Module src/security](src-security.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/review](src-review.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
