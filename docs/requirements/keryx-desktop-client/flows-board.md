# Keryx Desktop Client — Flows Board
Version: 0.1.1

Added to M1 at the owner's request on 2026-11-17: the desktop client needs a
place to see and work with the project's flows, the way the Hub web has a
flow board, but locally and without a Hub.

## 1. Why not reuse the Hub components

`apps/hub-web` has a legacy flow board (`features/workflow.tsx`,
`features/global-flows.tsx`) and a managed-work board
(`features/managed-work/*`). Both call `useHub()`, Hub API clients and
role checks, and the managed-work model (Intent, Attempt, Decision) has no
local equivalent. The desktop board reuses the Hub's visual pattern (one lane
per status, cards with progress, a detail panel) and writes its own
components against local data.

## 2. Data source (read-only)

The Rust core reads, inside the open project only:

| File | Use |
|---|---|
| `.metaproject/flows/<id>-<date>-<slug>/flow.json` | `FlowState` (`src/flow/types.ts`): id, title, status, previousStatus, owner, pr, baseBranch, tasks, acConfirmed, acKinds, signatures, completionAttempts, history, updatedAt |
| `acceptance-criteria.md` | lines `- ACn: text [verify: …]` |
| `journal.md` | lines `- <ISO> - <event>: detail` |
| `description.md`, `plan.md`, `context.md` | markdown shown as is |

`keryx flow status` has no JSON output, so the files are the source of
truth. A flow directory whose `flow.json` fails to parse is shown as a
broken card with the parse error, never dropped. The board refreshes when a
`flow.json` changes (a 2 s mtime poll in M1; a burst of writes inside one
interval gives one event) and on window focus.

## 3. Board

- Lanes in `FlowStatus` order: Initializing, Ready, In progress,
  Implemented, Completing, Done. Done is collapsed by default and shows the
  last 20.
- `blocked` flows stay in their `previousStatus` lane with a red Blocked
  badge.
- Card: `#id`, title, tasks done/total bar, ACs confirmed/total, owner, PR
  link chip, relative `updatedAt`, badges for blocked and completion
  exceptions.
- Toolbar: search (title, id), filter "mine / all", refresh, view toggle
  board/list.

## 4. Detail panel

Header (status, base branch, PR), then tabs: Overview (description, plan),
Criteria (each AC with verify tag, kind and confirmation note), Tasks (kind,
status, disposition, dependencies, attempts), Journal (timeline merged from
`journal.md` and `history`), Gates (signatures, completion attempts).

## 5. Actions

Mutations go through the same keryx binary the session uses, as
`keryx flow <subcommand>` with the project as cwd. The Rust core accepts
only this allowlist and builds argv itself; no shell string is ever run.

| Action | Command | Confirmation |
|---|---|---|
| Start | `flow start <id>` | none |
| Block / Unblock | `flow block <id> --reason <r>` / `flow unblock <id>` | reason prompt |
| Add task | `flow task add <id> --title <t> --kind <k>` | form |
| Task attempt | `flow task attempt <id> <Tn> --outcome <started\|failed\|blocked> --detail <d>` | form |
| Task done | `flow task done <id> <Tn>` | none |
| Freeze criteria | `flow freeze <id>` | confirm dialog |
| Next task | `flow next <id> --json` (read-only) | none |

Free-text arguments (reason, title, detail) must be non-empty, must not start
with `-` (the CLI would read them as a flag), contain no NUL and stay within
4000 characters; the form and the Rust core both check this.

Not offered, with a "copy command" button instead: `complete`, `confirm`,
`recover`, `implemented`, `ac update`, `ac reseal`. Their gates and
confirmation tokens belong to a terminal.

**Work on this flow**: opens a session in the same window with the composer
pre-filled `Continue flow #<id> "<title>": take the next task.` The user
sends it; nothing is sent automatically.

## 6. Rust commands

| Command | Result |
|---|---|
| `flows_list(cwd)` | `FlowCard[]` |
| `flows_get(cwd, id)` | `FlowDetail` (card + parsed criteria, tasks, journal, markdown docs) |
| `flows_action(cwd, id, action)` | `{ ok, stdout, stderr, exitCode }` |
| event `flows://changed` | `{ cwd }` |

## 7. Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| FB1 | parsers for `flow.json`, criteria and journal pass fixture tests, including a broken `flow.json` | exec `cd apps/desktop/src-tauri && cargo test flows` |
| FB2 | an action outside the allowlist is refused before any process starts | exec `cd apps/desktop/src-tauri && cargo test flows` |
| FB3 | the board renders this repository's real flows by status lane | judged |
| FB4 | Start / Block / task done round-trip through keryx and the board refreshes | judged |

FB4 evidence so far (2026-11-17): every allowlisted argv ran against a scratch
project with the worktree keryx (freeze, start, task add, task attempt, next,
block, unblock, task done — all succeeded) and the Rust parser read the result
(`in-progress`, 1/5 tasks). The same round-trip through the app's buttons has
not been exercised.
