# Conditional mandatory reads for documents cited by project rules

Status: draft (PRD and criteria wait for the operator; not frozen)
Source: user description (origin: human-request)
PRD: docs/requirements/keryx-conditional-reads/README.md
Depends on: flow 461 (PR #1047). Rebase onto main once it is merged.

## Problem

Flow 461 made project rules mandatory reading for code and test workers. A document that a rule only cites (Vantage: STYLING.md about 100 KB, THEMING.md about 68 KB) is resolved as an optional on-demand contract with no condition. The validator never requires it, and nothing tells the worker when it matters. A task on className or theme tokens can pass every gate without the governing document being read.

## Expected Outcome

A project declares, for each cited document, where it applies (file globs plus task keywords), the section that matters and a description. The resolver promotes matching documents from on_demand to must_read. The worker's result proves the read with the path, the sha256, the anchor and a summary. A deterministic validator checks that proof, warning first and blocking under the existing enforcement setting. The project can see gaps (undeclared citations, dead anchors, thin descriptions) from the CLI and the TUI.

## Outcome criteria

- Запрос (дословно): «то есть я так понимаю что когда мы их импортируем в эти файлы которые идут в project rules должны не только ссылки хэши но и правильное грамотное описание чтобы агент мог понять и когда ему нужно читать основное правило и что он обязан его прочитать чтобы он сходил по ссылке именно вычитал» (source: helyx-channel message 212151, 2026-10-18T07:15:20Z (voice, transcribed); poll 211 answers)
- Эффект (формализация агента): when a task touches a document's declared area, the worker cannot finish with a passing gate unless its result cites that document's declared section by hash and anchor with a summary that matches the section; an imported rule's cited documents carry a description saying when to read them.
- Как наблюдать (предложение агента): resolve a fixture task on a styling file and see the document as must_read in the last-resolve record and in the TUI References tab; submit a result without the citation and see the validator miss; submit it with a summary unrelated to the section and see the summary miss; run the same task on an unrelated file and see the document stay on_demand with its description.

## Out of Scope

- Proving a model really read the text (the check is a deterministic proxy, documented as such).
- Model-inferred conditions; declarations are authored.
- Changing rule selection, the cap default, or release/version bumps (releases are batched).
- Rollout to other projects (operator).
