# Resume prompt — benchmark re-measurement and the deferred remediation
Version: 1.0.0

Paste the block below into a fresh session. Everything it refers to is in the
repository, so it survives a restart.

---

```
Продолжаем работу по keryx. Ветка docs/benchmark-run-report, впереди main на 7
коммитов, в main НЕ влита. Прочитай сначала:
  docs/requirements/keryx-shell-benchmark/run-2026-08-05.md  (в начале врезка с поправкой — читать её)
  docs/requirements/keryx-shell-remediation/README.md
  docs/requirements/keryx-unattended-posture/specification.md

Сделано и смержено в эту ветку: PR #252 (скриптовая дверь, инструменты за
--tools) и PR #253 (паритет параметров, единый tool-surface, закрыт канал
чтения за пределами корня). Флоу 135 и 136 намеренно остаются in-progress:
гейт требует коммит в main, критерии 7/7 подтверждены. Влить ветку в main —
решение владельца, тогда флоу закроются сами.

Отложено, в порядке приоритета:

1. ПЕРЕМЕР БЕНЧМАРКА (P3). Разблокирован — паритет параметров был тем, что его
   держал. Раннер лежит в docs/requirements/keryx-shell-benchmark/harness/,
   промпты в prompts/, запуск: harness/batch.sh <case> <leg>...
   Перед прогоном применить поправки каталога из run-2026-08-05.md §7 D6:
   C2 нужен подсаженный секрет реальной энтропии; C4 гнать через
   harness exec --allowed-domains; A6/A7 не запускаются на helyx (нет
   decision-страниц в вики) — нужен другой таргет; разрешить расхождение
   106 против 102 транзитивных на A1.
   Плечи: keryx-deepseek, opencode-deepseek (та же модель — чистая пара),
   baseline-claude, baseline-grok, naked-claude, naked-grok. gemma4-coder
   не отвечает, из группы A убрана.

2. РЕЖИМ БЕЗ НАДЗОРА — отдельным флоу по docs/requirements/keryx-unattended-posture/.
   Конструктивное ограничение там первым абзацем и оно далось тремя кругами
   ревью: сдерживание не может быть списком запрещённых слов. Рекомендованный
   первый релиз — posture без оболочки вообще, только read-инструменты.
   Корпус атак в спецификации обязателен как регрессионный набор.

3. ДЫРА keryx * в сохранённых разрешениях. Сегодня с этим грантом
   isShellCommandAllowed пропускает keryx ctx run -- rm -rf / без вопроса, на
   supervised-пути. Нужна своя правка: keryx в PREFIX_BANNED, два замороженных
   теста в shell-permissions-hardening.test.ts (:185, :233) переворачивать с
   вниманием, миграция должна отклонять сохранённый keryx *.

4. Мелочи, записаны в описании PR #253: ~14 недостающих exec-обёртчиков
   (timeout, setsid, stdbuf, flock, unshare, strace, busybox, parallel и др.);
   расхождение enum статусов во frozen-схеме memory-search.

Регламент прежний: флоу → реализация → draft PR в текущую ветку → ревью
субагентом → исправления → повторное ревью до чистого → мерж → закрытие флоу.
Каждому субагенту свой git worktree и свой каталог (в прошлый раз параллельные
агенты дважды столкнулись в общем дереве). Прогоны запускать через setsid,
иначе входящее сообщение обрывает работу. Отчёт в канал после каждого кейса и
на значимых переходах, скриншоты каждого плеча, а не только показательного.
```

---

## Notes for whoever resumes

Three things cost real time on 2026-08-05 and are worth not rediscovering.

**Parallel subagents need separate worktrees *and* separate scratch directories.**
Two collided twice: one switched the shared checkout's branch mid-run of the
other, and later one overwrote a file in the other's scratch directory.

**A detached worktree has no `node_modules`.** A test run there fails four tests
on a missing TypeScript import and skips 42 more. That is the environment, not
the code — symlink `node_modules` before believing a number.

**`bun run check` does not include `check:doc-links`.** Both must be run.
