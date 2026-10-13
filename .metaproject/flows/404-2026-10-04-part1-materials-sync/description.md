# Синхронизация материалов части 1

Status: draft
Source: operator request (origin: human-request), file keryx-flow-prompt-materials-sync.md, trimmed by operator decisions of poll 87 (2026-10-04T20:22:18Z)

## Problem

The catalog `docs/research/role-blurring-part1/` holds a snapshot at commit 04809f4f. Two kinds of data go stale on their own and are visible only after a manual export: the current counts on main (drift from the snapshot) and the recommendation journal (`.metaproject/data/decisions/`, git-ignored, the input of part 2, P7). The claude.ai document "Материалы к части 1 / Part 1 materials" carries no live numbers.

## Expected Outcome

One repeatable step, `keryx research sync`, that on demand and once a day (1) recounts the numbers at the current HEAD, (2) exports the recommendation journal without any text, (3) writes both to `-latest` files beside the snapshot and (4) writes `sync-status.md`. The agent then refreshes the "Текущее состояние / Live status" section of the document from `sync-status.md`, on request and after each release. Nothing is committed automatically.

First step of this flow, a defect fix: `keryx decisions export --since` drops records whose timestamp carries a numeric UTC offset (47 records seen without the filter against 37 with it in flow 402).

## Outcome criteria

- Запрос (дословно): «дай промт что бы керикс агент периодически или когда нужно обновлял артифакт и туда складывал» (source: оператор, канал, 2026-10-05 (файл keryx-flow-prompt-materials-sync.md))
- Эффект (формализация агента): в каталоге материалов лежат свежие `-latest` файлы и `sync-status.md`, а раздел «Текущее состояние» документа совпадает с ними и отстаёт не больше чем на сутки; снимок 04809f4f остаётся нетронутой базой чисел статьи.
- Как наблюдать (предложение агента): через неделю в `git log` каталога видны мои пакетные коммиты синхронизации, дата в `sync-status.md` не старше суток, а в разделе документа те же числа.

## Out of Scope

- Event hooks on flow `done` and on journal entries (operator decision: trimmed scope).
- Hourly commit throttling logic and any automatic commit or PR (operator decision: sync writes the working copy only; commits and PRs are made in batches by the agent).
- Changing the snapshot files `part1-counts.json` and `decisions-export-2026-10-04.jsonl`.
- Any text field in the export: no question, option or reason text, no own answer.
- A GitHub Action (the journal is local).
