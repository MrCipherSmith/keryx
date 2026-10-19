# Implementation Plan

Status: approved scheme; details below are the implementer's starting point.

## Approach

One parser in `src/commands/review-operator.ts` reads `--answered-by`, `--answer-text`, `--question-text`. When `--answered-by` is present the verb skips `requireTerminal` and the terminal `ask`, builds the same question text from disk state as today, checks the supplied answer against the verb's options, and records through the existing recorders (`recordOperatorDecision`, `recordPlanConfirmation`, `answerPremiseQuestion`) with `confirmedVia: "host-question"` plus a `hostQuestion` object (source, ref, questionText, answerText). A second write goes to the `keryx decisions` journal. Refusals happen before any write. Unattended runs and `KERYX_TOOL_CALL=1` refuse the flag. `review complete` keeps its flag list.

Rejected: a keryx-run card with its own press verification for hosts outside the shell (draft v1 of the PRD; the operator called it too heavy); an MCP card tool (operator: it must be a plain question every harness can ask).

## Steps

1. Type: add `"host-question"` to `OperatorDecisionVia` (and `ConfirmedVia` consumers) and a `hostQuestion` field on the records; keep older records readable.
2. Verb flags and refusals for the four verbs (AC1-AC3, AC5, AC7); tests first.
3. `keryx decisions` entry (AC6) and the report/`/decisions` display (AC8).
4. Help text, skills (both bundled copies, line ceilings), TM-04, limitations, CLI reference, README, docs site (AC9, AC10).
5. Record the PR 1052 decisions through the verb (AC11) after merge to the branch that carries the verb.

## Risks

- An agent can invent an answer; the record keeps the verbatim question, answer and poll or message id so a reviewer can check them against the Telegram log. keryx cannot.
- Skill byte-identity and line-ceiling tests are tight; edit both copies together.
- Existing tests assert the "needs a terminal" message: keep it byte-identical when the flag is absent.
