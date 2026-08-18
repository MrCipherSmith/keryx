# Context

Collected deterministically by `keryx flow init` at 2026-08-18T13:57:36.385Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Requirements package already exists and is the source of truth — no
context-collector/brainstorm dispatch needed:

- `docs/requirements/keryx-tui-queue-dock/README.md` — discovery notes.
- `docs/requirements/keryx-tui-queue-dock/prd.md` — FR-1..FR-15, NFR-1..NFR-4,
  Gherkin ACs (item 2, FR-11..FR-15, added mid-session at operator's request after
  item 1 FR-1..FR-10 was already confirmed).
- `docs/requirements/keryx-tui-queue-dock/trd.md` — architecture (§1.1-1.5 queue
  dock, §1.6 click-to-focus/autofocus), data models, API contracts, grounded
  against real code with exact file:line references.

### Relevant memory (surfaced above, worth flagging explicitly)

`.metaproject/memory/lessons/tui-alignself-height-collapse.md` — "OpenTUI:
alignSelf on a transcript box collapses its intrinsic height." Directly relevant:
this flow adds a new persistent `Box` (`queueDock`) into the same flex-column layout
as the transcript. Read this lesson before touching layout props on the new box or
its siblings.

### Files this flow will touch (from TRD §1, §3, §4, §6)

Modified:
- `src/tui/shell-chrome.ts` — new `queueDock` Box (mirrors existing `dock`
  construction), inserted into `main`'s child order between `scroll` (transcript)
  and `dock`; new `readonly queueDock: Box` on `ShellChrome`'s interface;
  `overlayActive()` extended for queue-nav mode; new `onMouseDown` handlers on
  `sidebar`/`scroll`/`queueDock` for region click-to-focus (each guarded by
  `overlayActive()`).
- `src/tui/tui-shell.ts` — `paintMainQueue()` retargeted from `transcript` to
  `chrome.queueDock`; per-item rows gain Force/Edit/Delete `BoxRenderable` buttons
  (`onMouseDown` each); new queue-nav `onKeypress` handler (↑↓ select item, ←→
  select action, Enter fires, Esc exits); one new `chrome.input.focus()` call right
  after `createShellChrome()` resolves (~line 1536) for launch autofocus.

Read-only reference (not modified):
- `src/tui/composer-choice.ts` — row-painting/`onMouseDown` pattern to mirror.
- `src/tui/main-queue.ts` — pure logic layer, reused verbatim
  (`removeMainQueueItem`/`editMainQueueItem`/`reinsertMainQueueItem`/
  `formatMainQueueMarker`/`parseQueueCommand`).

### Explicitly NOT touched (PRD Non-Goals)

Side-1/side-worker queue and its UI, `main-queue.ts`'s function signatures, the
turn-interruption mechanism itself, the existing choice-dock's own lifecycle, the
readline (`--no-tui`) shell.

### Known implementation risk flagged in the TRD (§1.6)

OpenTUI's mouse-event dispatch order for nested `BoxRenderable`s with their own
`onMouseDown` (queue item row vs. its Force/Edit/Delete button children) is NOT
confirmed — the implementer must check `@opentui/core`'s actual bubbling/dispatch
behavior before writing the click handlers (verify, don't assume it either bubbles
or doesn't).
