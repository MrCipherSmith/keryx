# Review layers: reliability and test tails of PR 1006 round 3

Status: draft, criteria awaiting operator approval before freeze
Source: agent finding (origin: agent-finding)

## Problem

Round 3 of PR 1006 (flow 431) skipped seven findings that are not refactors: three reliability gaps in the layers refresh
and four weak or misnamed tests. They shipped in 0.3.113 as known residuals.

- R3-06: the SIGINT/SIGTERM handler lives only inside `withDetachedWorktree`. A signal after the graph build (wiki, memory,
  `layers.json` write) kills the process without releasing `refresh.lock`, and a lock with a fresh mtime reads as held.
- R3-12: `wikiFor`, `memoryFor` and `affectedFor` swallow reader failures, so a failure looks the same as "nothing relevant".
- R3-29: a package whose graph build failed persistently is rebuilt on every `ensurePackageLayers` call (worktree, full
  build, cleanup, behind `refresh.lock`).
- R3-22, R3-23, R3-28, R3-31: a timeout test that cannot tell a timeout from a no-JSON exit, a double-start guard test that
  cannot tell a module-level guard from a per-view one, a fixed 150 ms wait in `blockedWhile`, and test names that carry
  round ids.

## Expected Outcome

A signal at any phase of a layers refresh leaves no `refresh.lock`, no detached worktree and no staging directory. A reader
failure shows in the layers block as `unavailable` with a reason. A persistently failing build is not retried at the same
head inside a short window unless `--force`. The four tests fail against the mutants they were meant to catch.

## Outcome criteria

- Источник: `.metaproject/flows/431-2026-10-12-metaproject-in-review/reviews/2026-10-14-pr-1006-round3-72920f1d` (skipped findings R3-06, 12, 22, 23, 28, 29, 31); operator choice A+B, helyx poll 168, 2026-10-14T04:44Z
- Эффект (формализация агента): refresh не оставляет блокировку после сигнала; отказ ридера виден в блоке слоёв; повторная сборка того же головного коммита после сбоя не идёт при каждом вызове; четыре теста ловят то, ради чего написаны.
- Как наблюдать (предложение агента): тест, который шлёт сигнал в фазе wiki и проверяет отсутствие `refresh.lock`; строка `wiki: unavailable (...)` в `keryx review layers block`; второй вызов `ensurePackageLayers` после сбоя не создаёт worktree; мутанты тестов убиваются.

## Out of Scope

R3-08, 10, 11, 13..18, 27 (refactors and performance, later flow). R3-28 is optional: done only if it needs no production change.
