# Module src/review/bot

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/review/bot` is the headless pull request review bot: it reviews one same-repository pull request diff with a model, has a second model turn try to refute each finding, and records the survivors as a managed review. It then posts that review to GitHub as one pull request review, after screening every comment for secrets and injected instructions.

## Overview

`src/review/bot` owns the automated review of a single pull request, from reading the diff through the model turns to the single review posted back to GitHub. It also keeps the per-pull-request bot state and computes the metrics that say whether the bot's findings were acted on. Its guards exist because everything it writes is public: a fork's code never reaches the model key or the write token, and a finding that leaks a secret or repeats an injected instruction is withheld rather than masked.

## How it works

The module has three layers. `run.ts` is the pipeline: `runReviewBot` reads the pull request through the `GitHubPort`, refuses forks and closed or merged pulls via `fork-guard.ts`, and checks that the local checkout is at the pull request head with `shaMatchesHead`. It caps the diff with `capDiff` (default `DEFAULT_MAX_DIFF_BYTES`, 200,000 bytes), then makes one reviewer turn and one verifier turn per finding. The model is injected as a `runTurn` function, so the command layer supplies the provider and this module stays provider-agnostic. Findings a verifier refutes are dropped; the rest go into a managed review package through `createManagedReviewPackage` in ingest mode.

`post.ts` is the outbound half. `postBotReview` loads a package and maps each finding to an inline comment only when its file appears in the diff and its line is a changed line in the hunks that `parseDiffHunks` builds. Everything else goes into the review body. Every piece of the outgoing payload is screened by `redaction.ts` (`screenComments`, `screenCommentBody`), and a failing finding is withheld as a whole. The review is sent only with `send`, and a `botMarker` carrying the head commit stops a second review for the same commit.

`metrics.ts` is the read side. `computeBotMetrics` walks the packages on disk, tallies each finding's disposition with `findingDispositionState`, and derives precision and the share of findings resolved before a merge. A ratio with no data is `null` and prints as `n/a`. Per-pull state (`BotState`, stored as JSON under `.metaproject/reviews/bot`) is what `refreshPullStates` updates from GitHub.

## Key concepts

- **Bot review run**: one `runReviewBot` pass, recorded as a `BotRunRecord` with its head SHA, the diff cap facts (`BotDiffFacts`) and, once posted, `postedAt` and `reviewUrl`.
- **Reviewer and verifier**: two prompt roles. The reviewer returns findings as a fenced `keryx:findings` JSON block; the verifier returns a `VerifierVerdict` (`confirmed`, `refuted` or `unverifiable`) for one claim. The verifier is what keeps refuted findings off the pull request.
- **Pull facts**: `PullFacts` is the GitHub view of a pull request (state, merge, head and base SHA, head and base repository) that every guard decides on.
- **Review payload**: `ReviewPayload` is the single GitHub review body: `commit_id`, `COMMENT` event, the body text and the inline `comments`. `ReviewItem` is one finding before it is placed inline or in the body.
- **Withheld finding**: a finding that failed the security output check. It is recorded with its categories and never masked into the payload.
- **Bot metrics**: `BotMetrics` and `ReviewRow` hold the counts behind precision (acted on versus dismissed as incorrect) and resolved-before-merge.

## Main flows

1. **Run a review.** `runReviewBot` reads the pull request, runs the fork and open-state guards, checks the checkout head, and gets the diff through `gitDiff`. It calls the reviewer turn and parses findings with `parseReviewerFindings`. For each finding it calls the verifier and keeps or drops it with `parseVerifierVerdict`. The survivors are packaged, and the run is appended to the bot state for that pull request.
2. **Post a review.** `postBotReview` finds the newest run (or the one named by `review`), rejects it if it was already posted or if its head is no longer the pull request head, and builds the candidates. It screens them, assembles the payload with `buildReviewPayload`, re-screening once after dropping any item that failed (`assemblePayload`), and returns a dry run by default. With `send`, it first checks GitHub for a review carrying the same marker, then posts and records `postedAt`.
3. **Measure the bot.** `computeBotMetrics` reads every review package, skips repeated findings by their `global_id`, and produces the precision and resolved-before-merge figures for `renderBotMetrics`. `refreshPullStates` runs first when the merge state needs to be current.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ReviewRow`
- `BotMetrics`
- `formatRatio`
- `computeBotMetrics`
- `renderBotMetrics`
- `refreshPullStates`
- `DEFAULT_MAX_DIFF_BYTES`
- `ModelTurnInput`
- `ModelTurnResult`
- `REVIEWER_NAME`
- `VERIFIER_NAME`
- `REVIEWER_SYSTEM_PROMPT`
- `VERIFIER_SYSTEM_PROMPT`
- `CappedDiff`
- `capDiff`
- `parseReviewerFindings`
- `VerifierVerdict`
- `parseVerifierVerdict`
- `BotDiffFacts`
- `BotRunRecord`

### Key files

- `src/review/bot/metrics.ts` - imported by 5, imports 6
- `src/review/bot/run.ts` - imported by 6, imports 5
- `src/review/bot/post.ts` - imported by 2, imports 6
- `src/review/bot/redaction.ts` - imported by 2, imports 3
- `src/review/bot/fork-guard.ts` - imported by 4, imports 0
- `src/review/bot/metrics.test.ts` - imported by 0, imports 4

### Depends on

- `src/review` - 9 import(s)
- `src/security` - 2 import(s)
- `src/security/detect` - 1 import(s)
- `src/lib` - 1 import(s)

### Depended on by

- `src/commands` - 4 import(s)
- `src/tui` - 2 import(s)

### Dependency basis

- Production imports only: 7 import(s) from test file(s) (e.g. `src/review/bot/metrics.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 12
- Cross-module imports: 13

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/review](src-review.md)
- [Module src/security](src-security.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
