# Operator confirmations answered in the TUI instead of a separate terminal

Status: formalized
Source: user description (origin: human-request)

## Problem

Seven keryx commands accept an operator's answer only when stdin and stdout are a TTY.
Inside `keryx shell` the agent runs commands through `shell_exec` (no TTY), so it stops
and tells the human to open a terminal and type a long command — e.g. on 2026-10-15 a
review of vantage-frontend PR 7947 asked the owner to run
`keryx review chunks estimate … --answer yes --quote "…"` by hand. The owner wants the
TUI to ask the question itself and take a yes/no.

The TTY gate exists so an agent cannot answer for the operator. A proof cannot be handed
to a child process safely: the model controls the command text and its environment
(`sh -c`), and can read/write everything the user can (sandbox off by default). The
codebase already has the trusted pattern: an in-process tool whose `confirmation()`
returns a card the TUI shows with `alwaysAsk` in every mode (auto included), denied when
unattended, token held in TUI memory (flow 295, `schedule_create`,
src/commands/schedule-tools.ts, src/commands/agent.ts:5955-6092).

Gates (anchors from main, 2026-10-15):

| # | Command | Asks | Records |
|---|---|---|---|
| 1 | `review chunks estimate --answer` | lift the 25-pass ceiling | `{value, quote, at}` chunks-estimate.ts:112 |
| 2 | `review publish` | post the review to GitHub | the post |
| 3 | `review complete --waive-coverage` | accept uncovered files | `CoverageWaiver{operatorQuote,time,files}` |
| 4 | `review complete --waive <item>` | waive a readiness item | `ReadinessWaiver{item,operator_quote,time}` |
| 5 | `flow confirm` | mint a completion token | token hash, flow-bound |
| 6 | `agents external apply` | land an external agent's patch | branch `external/<run-id>` |
| 7 | `learn accept/promote/graduate apply` | accept/promote a learned pattern | the learning record |
| 8 | `schedule add/resume/run/remove/pause` | create or change an unattended schedule | signed schedule (create already has a card tool) |

## Expected Outcome

In `keryx shell`, each of these operator decisions is a card in the TUI: the human sees
exactly what is being decided and presses yes or no; the decision takes effect without
leaving the TUI and is recorded with the card text, the answer, the time and
`confirmedVia: "tui-card"`. No mode, saved approval, review-auto, ask_user auto-answer or
arbiter can answer a card; an unattended run is denied as today. In a real terminal the
existing TTY paths keep working unchanged. Skills and refusal texts send the agent to the
card tool instead of "run this in a terminal".

## Outcome criteria

- Запрос (дословно): «Мне не нравится такое поведение что он просит идти в терминал, такие команды должны в  TUI реализовываться через вопросы пользователю, и я нашму да или нет» (source: claude-code session 2026-10-15, after a keryx shell review asked the operator to run chunks estimate --answer in a terminal)
- Эффект (формализация агента): в keryx shell ни одно из восьми операторских решений
  не требует отдельного терминала — TUI показывает карточку, владелец жмёт «да»/«нет»,
  решение применяется и записывается; агент не может ответить сам.
- Как наблюдать (предложение агента): в следующем ревью/фло, где нужно решение
  оператора (лимит проходов, waiver, publish, flow confirm), агент вызывает инструмент,
  владелец видит карточку и отвечает в TUI; в журнале/пакете стоит `confirmedVia: tui-card`.

## Out of Scope

- Making the child-process CLI paths trust anything new (no env/socket/token handed to a
  `shell_exec` child).
- Changing what each gate decides or records beyond `confirmedVia` and the card text.
- A typed free-text quote (owner chose card text + yes; an optional comment is allowed).
