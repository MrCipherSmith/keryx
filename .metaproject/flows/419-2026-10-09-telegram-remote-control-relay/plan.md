# Implementation Plan

Status: implemented on `feat/telegram-remote-control-relay`; AC8 (live run) waits for the operator.

## Approach

Keep the existing split: `keryx serve` owns Telegram, the shell is a client over `/v1/remote/*`. Each
criterion is closed at the narrowest layer that already owns the behaviour, with a test beside it:

- Mirror shell prompts through the bridge's `askApproval`/`askUser`, not through the TUI, so a turn typed in
  the shell is covered too (`src/tui/approval-mirror.ts`). First answer wins; the loser is closed with
  `prompt-close`.
- Reminders live in `RemoteHttpSurface`, next to the prompt table, so the timer dies with the prompt.
- Commands from the topic wait for an idle main in the command router (`awaitIdle`), with a notice, instead of
  being refused.
- Progress notes are composed from counts and names only (`src/remote/progress-notes.ts`), driven by the tool
  hook and the subagent fleet listener, with one rate limiter.
- A status question is answered by the bridge from session state, so it never reaches the model or the queue.
- Close archives (`closeForumTopic`) instead of deleting; the orphan sweep does the same for a killed shell.

Rejected: a timer-driven ticker for progress (notes would fire in an idle turn), and a model-written summary
(slow, can leak tool output).

## Steps

1. AC7 + AC1/AC2: archive on close, mirror approvals and `ask_user`, `prompt-close` for the loser. (a556a84a)
2. AC3: reminders, 2 min, at most 3. (c9d17c57)
3. AC4: `/route` on the menu, queue-when-busy for `/route`, `/external`, `/external-agents`, `/model`. (2121fcf5)
4. AC5, AC6, AC7 explicit test: progress notes, instant status answers, topic survives exit and Ctrl+C. (f9f0ee34)
5. AC9: README, drive-keryx-remotely guide (new "What the topic hears" and "What happens when the shell closes"),
   cli-reference, wiki page, CHANGELOG; `mkdocs build --strict` passes.
6. AC8: operator-run live review (not started; the operator runs it):
   1. Install the branch build (`npm pack`, then `npm i -g` the tarball; npm only) and run `keryx update` in the
      test project. Telegram connected via `/channels`; `keryx serve` running.
   2. `/clear`, then in a shell start a long review (a real PR with several reviewers) and type `/remote-control`.
   3. From now on touch only Telegram: answer every approval and `ask_user` from the topic; ask "how is it going?"
      once mid-run; send `/model` or `/route` once while main is busy and check the queued notice.
   4. Leave one prompt unanswered for over 2 minutes and check the reminder.
   5. When the review ends, `/exit` in the shell and check the topic is archived with its history.
   6. Export the topic's message log and attach it to the flow with the shell's transcript; then
      `keryx flow ac confirm 419 AC8 --note "<log path>"`.

## Risks

- Progress notes fire on tool calls and subagent events only; a long silent model step produces no note.
- A wave-start note names only the subagents known at that moment; the rate limit coalesces the rest.
- Status questions are matched by a short phrase list (en/ru); anything else goes to the model when main is idle
  and is queued as work when busy.
- Everything was tested against a fake Bot API; real Telegram behaviour (closed topics, reactions) is AC8.
