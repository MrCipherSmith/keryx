# SAC Workspace Lifecycle Completion
Version: 1.0.0

## Назначение

`src/sac/workspace-service.ts` (уже реализованный, не design-only SAC-1
"workspace registry") имеет только `create`/`list`/`show`/`addResource`.
Найдено аудитом (2026-08-16): нет способа архивировать workspace (хотя
`docs/requirements/shared-agent-context/artifact-lifecycle.md:8` это прямо
обещает — `status: active → archived`), нет `removeResource`, нет
переименования, и — важно — нет способа добавить второго member'а иначе,
чем вручную отредактировав `workspace.json` в обход всей authorization/lock/
audit машинерии (собственный тест-сьют так и делает,
`workspace-service.test.ts:31-33`). Этот пакет закрывает то, что можно
закрыть безопасно сейчас, и явно документирует то, что закрывать сейчас
не стоит.

## Статус

Design. Кода нет. Сформирован тремя независимыми brainstorm-агентами
(Pragmatist/Innovator/Critic), каждое утверждение сверено с реальным кодом
(`src/sac/workspace-service.ts`, `src/sac/index.ts`,
`src/sac/proposal-lifecycle.ts`, `docs/requirements/shared-agent-context/
artifact-lifecycle.md`).

## Документы

- [PRD](prd.md) — проблема, пользователи, требования (`WSL-N`), риски.
- [Specification](specification.md) — функциональная surface, permission
  model, acceptance criteria (`AC-N`).
- [Implementation plan](implementation-plan.md) — единственная фаза, нулевая
  зависимость от slate в эту сторону.
- [Phase execution prompts](phase-execution-prompts.md) — промт для запуска
  через `flow-orchestrator`.

## Что входит (v1)

- **WSL-1 — Archive.** Единственный терминальный статус (`active→archived`,
  без изменения схемы). Прячется из `list()` по умолчанию, блокирует новые
  write-операции (add-resource/propose), НЕ блокирует уже идущий review
  существующих proposals.
- **WSL-2 — Pending-review discovery независим от archived-фильтра.**
  Правит взаимодействие с уже formalized `docs/requirements/slate/`
  SLATE-13/SLATE-10: enumeration pending proposals никогда не должна тихо
  терять archived workspaces.
- **WSL-3 — Resource removal.** Зеркало `addResource`, проверено по коду —
  нулевой blast radius на pending/accepted proposals (evidence резолвится
  напрямую, не через членство в `resources[]`).
- **WSL-4 — Rename/title edit.** Мелкая, низкорисковая доработка.

## Что сознательно НЕ входит

- **Member management** (`addMember`/`removeMember`/`updateRole`) —
  явный, признанный, не закрываемый здесь gap. Причина не "сложно", а
  "бессмысленно и вводит в заблуждение до RP-06": `localWorkspaceAuthorizationServer`
  выводит actor только из OS uid — добавленный member с произвольным
  subject никогда не сможет технически предъявить себя как отдельный,
  верифицируемый actor. Ссылка: [SAC RP-06 Identity and
  Capabilities](../shared-agent-context-identity-capabilities/README.md).
  Не строить временный/упрощённый `addMember` — временные ACL-полумеры в
  security-чувствительном коде обычно переживают "временное" решение.
- **Delete.** Конфликтует с уже принятым `AC-9` SAC-спеки (`docs/requirements/
  shared-agent-context/specification.md`: rejected/dismissed/stale proposals
  retain audit-only metadata) и `artifact-lifecycle.md`'s "derived before
  primary manifest" моделью, которая для delete целиком не была рассчитана.
  Archive — единственная разрушающая-подобная операция v1.
- **Git-native member management** (коммит в `workspace.json` в обход
  сервиса как способ "расшарить") — явно отвергнуто: ломает инвариант
  "`WorkspaceService` — единственный write-owner манифеста" и офлайн-first
  дизайн, не решает identity, просто прячет её за git author.
- **Manifest integrity/checksum защита от ручных правок `workspace.json`**
  — подтверждена как реальная, уже существующая (не создаваемая этим
  пакетом) дыра; вне скоупа, ссылка на будущий RP.

## Связанные модули

- [Keryx Shared Agent Context](../shared-agent-context/README.md) — владелец
  `WorkspaceService`, этот пакет — прямое расширение его write-поверхности.
- [SAC RP-06 Identity and Capabilities](../shared-agent-context-identity-capabilities/README.md)
  — владелец member management/multi-person identity, явно не дублируется
  здесь.
- [Keryx Slate](../slate/README.md) — SLATE-10/SLATE-13 читают workspace
  list/proposals; WSL-2 фиксирует границу взаимодействия явно.
