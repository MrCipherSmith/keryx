# Module src/intake

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/intake` turns new GitHub and board events into decision cards that a person acts on from Telegram, the TUI or the CLI. A poll only reads and proposes; every write to a flow happens on a human's press. Groups 37 file(s), depends on `src/scheduler`, `src/remote` and `src/trigger`, and exposes 20 public symbol(s).

## Overview

`src/intake` owns the work-intake loop. A poll reads issues, reviews, CI runs, comments and the product board through read-only `gh` calls, turns each new event into a card, and delivers those cards in batches. It also owns what a person does with a card: a button press either records a decision or runs an action (`take` and `review-flow` create a flow, `ci-triage` runs a triage). The poll itself never writes to GitHub or to a flow.

## How it works

The contract lives in `types.ts`: the event kinds, the closed set of actions per kind (`INTAKE_ACTIONS_BY_KIND`), the card and ledger shapes, and two injectable seams. `IntakeCardSink` is what the poll needs from serve's Telegram path, and `IntakeAssessor` is the single model call that writes an assessment. Every other file imports its types from here.

State is split across three stores under `.metaproject/data/intake/`, all owned by `store.ts`. `cards.json` is the only place card texts live. `ledger.jsonl` is append-only, one line per state change, and carries no texts. `state.json` records what the poll has seen, delivery retries and pending Telegram edits. The registry and the ledger share one lock. A card is visible only through its ledger line, so `registerIntakeCard` writes the ledger first and heals a half-written card on the next call. A card id is a hash of the event key and its stamp, so one event cannot produce two cards.

`poll.ts` drives the flow. `runIntakePoll` takes a dispatch lock and calls `collectIntakeEvents` under the same gh limits as the scheduled digest. The first read of a source only baselines it. Later, only events not yet seen (or board entries that moved) are assessed within the budget and registered as cards. `flushIntakeCards` then sends what quiet hours and `cardsPerHour` allow, and folds the excess into one overflow card. `runIntakeTick` is the entry point serve calls on every tick.

`actions.ts` is the single door for decisions, whatever surface makes them. It reads the card from the registry rather than trusting the press, and checks the press against the card's own buttons. It moves the card out of `sent` through one check-and-append (`appendIntakeIfState`), so two presses cannot both run the action. Take, review and triage claim the card as `taking` and keep the claim alive with a heartbeat. `recoverIntakeTaking` reclaims claims left behind by a dead process.

## Key concepts

- **Event** (`IntakeEvent`): one thing that happened on GitHub or the board, keyed stably across polls (for example `issue:<repo>#<n>`). Its body is untrusted text used only for the assessor and is never stored.
- **Card** (`IntakeCardContent`, `IntakeCardView`): what a card says, kept in the registry, joined at read time with the ledger's latest state. Kinds are the five event kinds plus `overflow`, the "ещё N событий" card.
- **Card state**: `queued`, `sent`, `collapsed`, `taking`, `taken`, `decided`, `failed`, `expired`, `undelivered`. A press can only arrive in an open state (`sent`, `collapsed`, `failed`).
- **Ledger record and folded card** (`IntakeLedgerRecord`, `IntakeLedgerCard`): an appended line per change. A record that puts a card back in `queued` or `sent` resets its decision fields, so `timeToAnswerMs` is measured from the send the human saw.
- **Baseline**: the first successful read of a source marks its items seen and makes no card, so a new install does not flood the topic.
- **Config** (`IntakeConfig`): repositories, quiet hours, `cardsPerHour`, button lifetime, the "later" delay, the model budget and `allowTakeInWork`. Take and review are refused on a work-account project unless that flag is set.
- **Status** (`IntakeStatus`): the one object every surface renders, including the waiting, queued and deferred counts.

Event, card and state are kept apart on purpose: the registry holds text, the ledger holds history without text, and the state holds what the poll has already seen.

## Main flows

1. **Poll to card.** `runIntakeTick` finds the poll due and calls `runIntakePoll`, which takes the dispatch lock and runs `pollLocked`. That reads GitHub through `collectIntakeEvents`, diffs the answers against `state.seen`, and assesses each new event (`IntakeAssessor`, within `budgetUsd`). `cardContent` builds the card, which `registerIntakeCard` writes. The state is saved, then `flushIntakeCards` sends each card through `IntakeCardSink.sendCard` and records it as `sent` in the ledger.

2. **Press take on an issue.** `decideIntakeCard` calls `decide`, which reads the card view, checks the action against `INTAKE_ACTIONS_BY_KIND`, the expiry, and the open state, then looks up the project and applies `workRefusal`. It claims the card as `taking` with `appendIntakeIfState` and starts a heartbeat. `runFlow` adopts an existing flow for the card through `flows.findByCard` or creates one through `flows.init`, writes a journal line, and settles the card as `taken` with its `flowId`. Any throw ends in `failed`, never in a card left in `taking`.

3. **Later and the TUI.** A "later" press records `decided` with a `remindAt` from `remindAtFor`, which pushes the time past quiet hours. A later flush brings the card back once as `queued` with a `reminder` reason. A decision made in the TUI or CLI is queued as a pending edit through `queueIntakeCardEdit`, and the next flush applies it to the Telegram card with `editCard`.

---

<!-- keryx:reference:begin v=1 hash=864e78751420af5da98b53ef68fd8cc7fb57a44fa0d58d4d51c178d4d2345ac3 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `INTAKE_SEEN_CAP`
- `INTAKE_PENDING_EDIT_MAX_ATTEMPTS`
- `INTAKE_PENDING_EDIT_TTL_MS`
- `intakeLedgerPath`
- `intakeCardsPath`
- `intakeStatePath`
- `ensureIntakeDataIgnored`
- `cardIdFor`
- `overflowCardId`
- `emptyIntakeState`
- `readIntakeState`
- `markIntakeSeen`
- `updateIntakeState`
- `readIntakeCards`
- `registerIntakeCard`
- `updateIntakeCard`
- `readIntakeLedger`
- `foldIntakeLedger`
- `readIntakeLedgerCards`
- `readIntakeCardViews`

### Key files

- `src/intake/store.ts` - imported by 29, imports 3
- `src/intake/intake.test-helpers.ts` - imported by 24, imports 5
- `src/intake/poll.ts` - imported by 16, imports 13
- `src/intake/intake-actions.test-helpers.ts` - imported by 13, imports 10
- `src/intake/actions.ts` - imported by 16, imports 6
- `src/intake/types.ts` - imported by 21, imports 1

### Depends on

- `src/scheduler` - 12 import(s)
- `src/remote` - 11 import(s)
- `src/trigger` - 5 import(s)
- `src/commands` - 4 import(s)
- `src/lib` - 3 import(s)
- `src/security` - 2 import(s)

### Depended on by

- `src/commands` - 13 import(s)
- `src/tui` - 5 import(s)

### Dependency basis

- Production imports only: 14 import(s) from test file(s) (e.g. `src/commands/agent-granted-json.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 37
- Cross-module imports: 38
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/scheduler](src-scheduler.md)
- [Module src/remote](src-remote.md)
- [Module src/trigger](src-trigger.md)
- [Module src/commands](src-commands.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
