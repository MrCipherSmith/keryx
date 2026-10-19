# PRD: operator acts answered by the host's own question (Claude Code, Codex, keryx shell, others)

Status: APPROVED v3 (operator polls 225 and 227, message 214878, 2026-10-19); flow 467. Acceptance criteria are in the flow package. Supersedes draft v1, which proposed a keryx-run card with its own press verification for hosts outside the shell; the operator rejected that as too heavy: "it should be just a question, every harness can do that".

## Problem

The operator's acts in the review lifecycle (`confirm-plan`, `decide-premise`, `waive-*`, `complete`) can be recorded only through a keryx shell card or a terminal. The CLI refuses without a TTY (`src/commands/review-operator.ts`, `requireTerminal`), and the keryx MCP server exposes no card tool. An agent in Claude Code or Codex that already asked the operator the question, and got the answer, still cannot record it. Case: PR 1052 held findings C-05, C-10, C-25 (decided uphold, uphold, dismiss in poll 223) and E-42 stayed unrecorded.

Every harness already has a way to ask: Claude Code's question tool, Codex's, keryx's `ask_user`, and in this deployment a Telegram poll through helyx (`send_poll`). The operator uses it every day.

## Goal

The operator's answer to a plain question, asked through whichever question tool the host has, is accepted as the operator's decision. The agent records it through one keryx verb that keeps the question and the answer, so the record is attributable and checkable later.

## Decision this reverses

TM-04 §5 and flow 464 refused `ask_user`/agent-sent polls as proof, because the answer returns through the model, and review-auto, the arbiter or an answers file can produce one. This flow accepts that weaker proof on the operator's instruction, the same trade the operator already made for `flow ac confirm` (poll 222). The record must say so: it carries `confirmedVia: "host-question"`, not `remote-card`, and the text of TM-04 §3/§6a and the limitations page says which of the two a record is. A keryx-verified press (`tui-card`, `remote-card`) stays available and stays the stronger kind.

## Proposed behaviour

- Each gated verb accepts a recorded question answer when there is no TTY: `--answered-by <source>:<ref> --answer-text "<operator's words, verbatim>" --question-text "<the question as asked>"`. `source` is `claude-code`, `codex`, `keryx-shell`, `helyx-poll` or `other`; `ref` is the question or poll id (for helyx the poll id plus message id).
- keryx builds the usual effect from disk state and refuses what the CLI refuses today: unknown package, unknown or not held finding, missing reason, a stale plan.
- The record keeps `confirmedVia: "host-question"`, the source, ref, the verbatim question and answer, and the time. It also writes a `keryx decisions` entry, so `decisions report` shows the question, the options and the choice.
- The answer must be one of the options the question offered for that verb (for `decide-premise`: uphold or dismiss); free text is not a decision.
- Unattended runs and a nested keryx (`KERYX_TOOL_CALL=1`) still refuse: no operator is there to have answered.
- The skills (`review-orchestrator`, `job-orchestrator`, `review-premise`) say: ask the operator with the host's question tool, then record the answer with the verb. They no longer say "stop and ask the operator to open a terminal or keryx shell".

## Decisions (poll 227)

- Q1: all four standalone verbs (`decide-premise`, `confirm-plan`, `waive-mutation`, `override-reviewers`) accept a recorded question. `review complete` does not; its `--waive` and `--waive-coverage` flags exist only on `complete` and stay on the terminal and card path.
- Q2: free text is never a decision; the answer must be one of the verb's options.

## Out of scope

- Proving who answered, or that a person did (TM-03 §5, TM-04 §4: unchanged limits; this flow loosens the proof further and says so).
- Any new transport, token, serve route or MCP tool.
- Other TM-04 acts (learn, schedule, external apply, flow confirm).

## Risks

- An agent can invent an answer. The record keeps the verbatim question, answer and poll or message id so a reviewer can check them against the Telegram log; keryx cannot check them itself. This is the cost the operator accepted.
- The loosened path could be used where the stronger one was meant. The verbs' help and the skills name the stronger path as the first choice where a card is available.
