# Recommendation journal v2: arms, reasons, coverage, quality

Status: draft PRD approved by the operator (poll 58, AC1-AC16); full text in ~/prompts/keryx-supervisor/flow-F2-prd-draft.md
Source: operator request (origin: human-request), channel messages 180099-180101

## Problem

Flow 392 records ask_user questions, the agent's recommendation and the human's choice, and one third of the questions are asked blind. The journal is the measuring instrument for part 2 of the article on role blurring. Four defects of the instrument must be closed before data collection: (1) in the ordinary mode three influences act at once (option order, the "(Recommended)" mark, preselection), and blind mode removes all three together, so the report cannot say which one shifts the choice; (2) the recommendation reason on the ask_user path is always empty although AC1 of flow 392 requires it; (3) part of the decisions never reach the journal (round-limit picker, TUI pickers, text A/B/C/D questions of skills); (4) the deviation rate alone does not measure quality of judgement, so an independent assessment of recommendation quality is needed.

## Expected Outcome

The choice result is deterministic, reproducible and studied per influence, with no change of user experience where research does not need one: four arms (A agent/shown/on, B agent/shown/off, C shuffled/shown/off, D shuffled/hidden/off) assigned by a seeded PRNG; a separate `recommendationReason`; every work decision with options passes the journal; quality is rated by a human and by a model in a clean context; the report and export serve the article without leaking question text.

Decisions of the operator folded in (poll 57): the effect phrase is the operator's (outcome author human); Telegram polls are kept in the same journal by hand with a `channel` field; irreversible questions stay in arm A and A is split by `forced`; the 87 legacy records are imported (ordinary to A, blind to D, flagged `legacy`); the judge is the same model in a clean context, labelled self-assessment; text A/B/C/D questions require a host, otherwise NEEDS_CONTEXT.

## Outcome criteria

- Запрос (дословно): «в openDecision, добавить режимы „пометка без предвыбора“ и „перемешано с пометкой“ … эффект — сделать результат выбора более детерминированным и изучаемым» (source: channel messages 180099-180101, 2026-10-03T09:23Z; PRD and AC approved in poll 58, outcome author human per poll 57)
- Эффект (формализация агента): the report distinguishes the contribution of order, mark and preselection to the share of choices matching the recommendation; a repeated run with the same journal yields the same arms.
- Как наблюдать (предложение агента): two weeks after release `keryx decisions report --json` shows at least 5 decisions in each of the four arms and a non-zero number of quality ratings.

## Out of Scope

- Rating the quality of the decision itself, hidden deliberation, and records from before this version beyond the legacy import.
- Journaling pure permissions (allow/deny); the exception is documented in a code comment.
- Distinguishing arms A and B in Telegram (not possible without preselection); documented as a limitation.
