# Implementation Plan

Status: approved by owner 2026-10-15 (all gates; quote = card text + yes; implement now)

## Approach

Reuse the operator-confirmed tool pattern (flow 295): one native tool per gate, built like
`schedule_create`. `confirmation(input)` reads the real state and builds a card (what is
decided, the exact effect, the subject: package/flow/patch hash/schedule); the driver asks
in every mode with `alwaysAsk`; on yes `invoke` calls the same library function the CLI
calls, in process, with the in-memory single-use token. No child process, env var or file
carries the decision.

Rejected: a token/socket/env handed to the `shell_exec` child (the model controls `sh -c`
and the env, and can read the user's files — forgeable); `ask_user` (auto-answered by
review-auto, arbiter and answers files; the answer returns through the model).

## Steps

1. Framework (T5): `src/commands/operator-confirm-tools.ts` — a helper that turns
   `{title, lines, subject, effect}` into a card + token and records
   `confirmedVia: "tui-card"` with `quote = "<card title>: yes"` (+ optional comment);
   registration in src/commands/interactive-agent-tools.ts; listed as interactive-only in
   src/trigger/unattended.ts; the TUI dialog shows the card title and text (tui-shell.ts
   ~:5283, :5423). Remote answering follows whatever existing `alwaysAsk` cards do —
   verify and state it; never weaker.
2. Review gates (T6): `review_chunks_answer`, `review_publish`, `review_waive_coverage`,
   `review_waive_readiness` calling chunks-estimate / publish / complete in process;
   `confirmedVia` added next to `operator_quote`/`operatorQuote`/chunk answer records.
3. Other gates (T7): `flow_confirm` (mint the TM-03 token in process and return it to the
   caller for `flow complete`), `external_apply` (card shows run id, branch and the full
   patch hash), `learn_accept` / `learn_promote` / `learn_graduate`, and
   `schedule_resume` / `schedule_run` / `schedule_pause` / `schedule_remove` next to the
   existing `schedule_create`.
4. Redirects (T8): each TTY refusal text, and the advisory `KERYX_TOOL_CALL=1` refusal,
   names the tool to use instead. Skills that tell the agent to send the operator to a
   terminal (review-orchestrator, flow complete docs, learn, schedule) name the tool.
   Docs: a decision record next to TM-03 with honest limits (a same-user shell can still
   forge the stores; the card proves a human pressed yes in this TUI, not who).
5. Verify, review, PR, release (T9-T11), then the owner's live check (T12).

## Risks

- Card text must show the real decision (what files are waived, what is posted, which
  patch lands) — a vague card is consent to anything. Built from state, never from model
  input alone.
- `review publish` posts publicly: card shows target PR, verdict and the body's first
  lines + size; `--partial` stays labelled.
- Library functions may assume CLI context (cwd, console output) — call them with explicit
  roots and capture output for the tool result.
- tui-shell.ts is large and shared — small, local edits only.
