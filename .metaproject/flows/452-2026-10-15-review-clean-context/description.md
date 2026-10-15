# Review clean context: no memory outside the orchestrator's stages, and a blocking check

Status: draft
Source: user description (origin: human-request)

## Problem

A review session that ended early reported that at some points it used information from its own memory. A review must be reproducible from its package: the same inputs give the same context, whoever runs it and whatever that agent remembers from earlier work.

Audit (draft 2 of the PRD at `docs/requirements/keryx-review-clean-context/prd.md`, file:line there):

- Legitimate: the orchestrator's own "Memory (required)" stage runs `keryx memory search --status accepted`, scoped to the change, and feeds each reviewer's `layers.memory`.
- Leaks: no review skill says that the agent's session memory, auto-memory index (`MEMORY.md`) and earlier conversation are not inputs; the operator's session loads them before the skill starts. A memory read outside the stage is invisible: `layersUsed.memory` counts calls but compares nothing.
- No general rule for an open question: today only specific forks name where the answer comes from.

## Expected Outcome

The skill states one clean-context rule and one open-question rule; a memory read by the orchestrator outside its stage is detected from the usage log and blocks `completed` and publishing through the readiness checklist of flow 451 (only the operator can waive it). Three paths stay by the operator's decision (poll 179) and are named as such: automatic `prior_findings`, auto-accepted review-notes and skill learning, `memory_search` in reviewer agents.

## Outcome criteria

- Запрос (дословно): «он не должен обращаться в свою память или куда-то, то что было раньше и если возникают какие-то вопросы, он должен искать их в инструкциях самого ревьюоркестратора либо же спросить у пользователя» (source: helyx 206452, voice, 2026-10-15T06:40Z)
- Эффект (формализация агента): новое ревью берёт контекст только со стадий оркестратора; чтение памяти вне стадии обнаруживается и не даёт пометить ревью completed или опубликовать его; открытый вопрос идёт в инструкции оркестратора, затем к пользователю.
- Как наблюдать (предложение агента): на пакете, где оркестратор сделал лишний `keryx memory search` после стадии, `keryx review readiness` печатает NOT READY с пунктом memory-outside-stage и командой для снятия; на чистом пакете пункт зелёный; в скилле есть раздел «Clean context».

## Out of Scope

- Automatic `prior_findings`, review-notes auto-accept and `memory_search` in reviewer agents (operator's decision, poll 179).
- What the memory stage collects and its `--status accepted` rule.
- Isolating the agent runtime from its own memory (named as a limit).
- The 40-file and depth-2 blast-radius defaults, the nine existing readiness items.
