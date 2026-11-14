# Desktop app: quick start (web and TUI) and evidence pass

Status: draft
Source: operator request in Telegram (origin: human-request); requirements package `docs/requirements/keryx-desktop-app/` (README, prd, specification)

## Problem

Starting work in the Hub today needs a pre-imported specification and a hand-written Flow with criteria. There is no way to type one line ("login button does nothing on Safari"), pick a mode and get a running Flow. The desktop-app programme (four directions, 16 requirements) starts with this entry point, but its data contracts for stages and findings were written without checking what the work module stores.

## Expected Outcome

1. The work module has a quick-start path: mode, description, optional clarifying answers and criteria become a Flow with frozen criteria through one idempotent server call that composes the existing `flow.create`, `intent.create` and `flow.approve-and-start` handlers.
2. The web has a "New task" dialog and the TUI has a `/task` modal, both keyboard-operable, both feeding the same server call.
3. The five modes (quick, bug, task, epic, refactor) and their template questions come from one table that both surfaces read.
4. Section 6 of the specification carries real field names, taken from the code, in place of the planned ones.

## Outcome criteria

- Запрос (дословно): «Делай» (source: Telegram 262337/262357/262387/262409), the reply to the offer "подготовлю PRD с критериями приёмки по этим четырём направлениям, и по вашему правилу в нём будут и пункты для TUI".
- Эффект (формализация агента): an operator can start a managed piece of work from one typed line, in the web or in the terminal, without importing a specification first, and the Flow it creates has frozen, checkable criteria.
- Как наблюдать (предложение агента): open the Hub web, press "New task", choose "bug", type one line, submit; the Flow appears in the work view with its criteria frozen. In `keryx shell` run `/task` and get the same Flow shape. Submitting twice with the same operation id leaves one Flow.

## Out of Scope

- Stage timeline, stage logs, diff view, findings beside code, visual QA (programme phase 2, later Flows).
- Solo Hub mode, auth and the Tauri shell (phases 3 and 4).
- Model-generated clarifying questions (decision D5: templates only in v1).
- Changing intake from external tickets.
