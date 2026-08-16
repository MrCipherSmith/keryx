# SAC Workspace Lifecycle Completion — PRD
Version: 1.0.0

## Problem

`WorkspaceService` — уже реализованный SAC-1 "workspace registry" — умеет
только `create`/`list`/`show`/`addResource`. Аудит (2026-08-16) подтвердил:
`status` пишется один раз при `create()` (`"active"`) и никогда не
читается/не переписывается нигде, хотя `artifact-lifecycle.md:8` прямо
обещает `active → archived` lifecycle. Нет `removeResource` — `resources[]`
растёт монотонно навсегда. Нет переименования. И главное: единственный
способ добавить второго member'а — вручную отредактировать `workspace.json`
в обход `withAuthorizedActor`/`withFileLock`/schema-валидации целиком (это
буквально то, что делает собственный тест-сьют,
`workspace-service.test.ts:31-33`). Поскольку `localWorkspaceAuthorizationServer`
выводит actor только из OS uid (`user:local-${uid}`), «шарится между
клиентами» сегодня реально означает «разные инструменты (TUI/Claude/Grok)
под одним OS-пользователем на одной машине» — не между людьми.

## Goal

Закрыть безопасно то, что можно закрыть, переиспользуя существующий
`addResource`-паттерн (`withAuthorizedActor` → мутация manifest →
`validateManifest` → `writeFileAtomic` под `withFileLock`) — не трогая
общий authorization-примитив (`authorizeSacUse`, security-критичная граница,
используемая и `proposal-lifecycle.ts`, и `fwk-service.ts`). Явно
задокументировать, что НЕ закрывается сейчас и почему, вместо тихого
умолчания.

## Users

- Owner workspace'а, который хочет архивировать/убрать неверный
  resource/переименовать после того, как первичная задача изменилась.
- Reviewer, использующий SLATE-10 catch-up/SLATE-13 list-proposals —
  не должен тихо терять pending review из архивных workspace.

## Product requirements

- **WSL-1 — Archive.** `archive(workspaceId)`, owner-only (локальный гейт
  внутри `execute(manifest)` — `manifest.members.find(m => m.subject ===
  actor.subject)?.role !== "owner"` → `access_denied`; НЕ трогать
  `authorizeSacUse` — blast radius на `proposal-lifecycle.ts`/`fwk-service.ts`
  того не стоит для трёх owner-only операций). `next = {...manifest, status:
  "archived", updatedAt}`, схема уже допускает `"archived"` (`workspace-
  manifest.schema.json`), менять не нужно. `list()` по умолчанию фильтрует
  `status !== "archived"`, `--include-archived` флаг показывает всё. Новые
  write-операции (`addResource`, `propose`) на архивной workspace —
  блокируются явной проверкой в начале каждой. Review уже существующих
  pending proposals **не блокируется** — доводить начатое до конца можно;
  архивация не создаёт proposals-в-подвешенном-состоянии навсегда сама по
  себе (см. WSL-2 для дискаверабилити).
- **WSL-2 — Pending-review discovery независим от archived-фильтра.**
  Найденное взаимодействие с уже formalized `docs/requirements/slate/`: если
  `SLATE-13`'s `listVisibleProposedProposals(actor)` строится поверх
  `WorkspaceService.list()`, а `list()` по умолчанию прячет archived — pending
  proposal в архивной workspace станет невидимым и для SLATE-10 catch-up
  тоже, тихо, без ошибки (самый опасный класс бага для audit-ориентированной
  системы, по формулировке Critic'а). `listVisibleProposedProposals` обязана
  ИГНОРИРОВАТЬ archived-фильтр специально при проверке pending proposals —
  discoverability важнее, чем "не захламлять список" default, уместный для
  обычного `workspace list`.
- **WSL-3 — Resource removal.** `removeResource(workspaceId, uri)` —
  зеркало `addResource` (`workspace-service.ts:205-223`): не найден →
  `not_found`, найден → убрать из `resources[]`, `validateManifest`, write.
  Проверено по коду: `fwk-service.ts` читает `resources[]` напрямую для
  overview/read (значит удаление сразу перестаёт показывать ресурс там), но
  `proposal-lifecycle.ts`'s `targetWriteOrStale` резолвит evidence напрямую
  через `resolveWorkspaceReference`, не через членство в `resources[]` —
  ни pending, ни accepted proposals не рвутся при удалении resource.
- **WSL-4 — Rename/title edit.** Мелкое расширение того же паттерна,
  `title` меняется, `updatedAt` бампится.

## Явно НЕ входит (не молчаливое умолчание — обоснованное решение)

- **Member management** — не строить `addMember`/`removeMember`/
  `updateRole` даже в упрощённой owner-only форме. Не вопрос сложности (схема
  уже бесплатно валидирует single-owner topology, реализация была бы дешёвой)
  — вопрос смысла: добавленный member с произвольным subject не может
  технически предъявить себя как отдельного actor'а при сегодняшней
  identity-модели (OS-uid-only), значит `addMember` создал бы ACL-запись без
  верифицируемого исполнителя — легитимизированную иллюзию multi-person
  sharing, а не реальную фичу. Явная ссылка на RP-06 как на владельца этого
  скоупа.
- **Delete.** Конфликтует с `AC-9` SAC-спеки (append-only audit metadata для
  rejected/dismissed/stale proposals) и не описан в `artifact-lifecycle.md`'s
  lifecycle вообще (только `active → archived`). Archive — единственная
  разрушающая-подобная операция v1.
- **Git-native membership** (коммит в `workspace.json` в обход сервиса) —
  ломает инвариант "SAC = единственный write-owner манифеста", офлайн-first
  дизайн; не решает identity, а прячет её за git author.
- **Manifest integrity/checksum** против ручных правок `workspace.json` мимо
  API — подтверждённая, но не создаваемая этим пакетом дыра; отдельный
  будущий scope.
- **Surfaced archive-подсказка на flow-complete** (Innovator idea) —
  разумная UX-надстройка поверх WSL-1, но требует нового обратного индекса
  flow→workspace и решения, в каком модуле живёт hook (flow или SAC) — не
  блокирует WSL-1..4, явный follow-up, не v1.

## Success criteria

- `archive`/`removeResource`/rename используют ровно тот же скелет, что
  `addResource` — ноль нового security-мышления, ноль изменений в
  `authorizeSacUse`.
- Ни один pending proposal не становится недостижимым через нормальный
  discovery-путь (SLATE-10/SLATE-13) после архивации своей workspace.
- Ни одна из отвергнутых операций (member management, delete, git-native
  sharing) не реализована как «временное приближение» — задокументированы
  как явные non-goals с обоснованием, не молчаливые пропуски.

## Risks

- **WSL-2 без реализации** — archive тихо ломает SLATE-10/13 discoverability.
  Обязателен к реализации вместе с WSL-1, не отдельно/потом.
- **Соблазн добавить "временный" `addMember`** — явно отвергнут с
  обоснованием (не временная мера, устойчивое заблуждение). Если решение
  пересматривается — делать это осознанно, после RP-06, не как патч этого
  пакета.

## Recommendation

Реализовать WSL-1…4 (S effort на каждый — WSL-1/WSL-3/WSL-4 по независимой
оценке Pragmatist'а,
переиспользуя `addResource`-скелет буквально). Member management и delete —
не реализовывать, задокументированы как обоснованные non-goals.
