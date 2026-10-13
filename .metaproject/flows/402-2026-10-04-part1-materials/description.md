# Part 1 article materials: protocol, counts script, contribution log, pilot export

Status: draft
Source: operator flow prompt `keryx-flow-prompt-part1-materials.md` (origin: human-request)

## Problem

Part 1 of the article "Размытие ролей…" / "Role Blurring…" appears as a preprint with three promises that must be true at publication: the snapshot and counting script are published with the data, the protocol is fixed on 4 October 2026 as a dated document in the repository, and the contribution log with dates and verbatim quotes is available with the data. None of the three files exists in the repository yet.

## Expected Outcome

One directory, `docs/research/role-blurring-part1/`, holds all of it and gives one public link. A reader can recompute the numbers on the recorded commit.

## Outcome criteria

- Запрос (дословно): «напиши промт, что нужно конкретно в keryx» (source: operator request of 2026-10-04 relayed through the flow prompt keryx-flow-prompt-part1-materials.md; channel messages 182981 and 182996, 2026-10-04T13:08-13:10Z)
- Эффект (формализация агента): the three promises in Part 1 are true: protocol, counting script with its output, and contribution log are published in one directory of the repository, and the pilot decisions export sits beside them without any question or option text.
- Как наблюдать (предложение агента): the operator opens the README link after publication and runs `part1-counts.py` at the recorded commit; the numbers match `part1-counts.json`.

## Out of Scope

Anything about the operator's team repositories (no aggregates, codebook or mentions). Editing the counting script to fit the article. The article text. Version bump and release.
