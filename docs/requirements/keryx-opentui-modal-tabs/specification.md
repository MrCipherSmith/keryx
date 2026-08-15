# Keryx OpenTUI Modal and Tabs — Specification
Version: 0.1.0

## Identity and ownership

**Package id:** `keryx-opentui-modal-tabs`.

| Concern | Owner | This package |
|---|---|---|
| Shell chrome, composer, `/`-menu, overlay guard | `src/tui/shell-chrome.ts` | Registers as an overlay source; does not replace chrome |
| Feature bodies (session fields, model lists) | Callers | `renderTab(id, ctx)` only |
| OpenTUI capability | `src/capability/` | Host loads OpenTUI only through the existing dynamic import |

## Storage structure

None. The host is in-process UI state. No `.metaproject/` files, no new
manifest keys.

## Manifest / config

No `metaproject.json` flag. Availability = TUI is running.

## CLI or skill surface

No new `keryx` CLI verb. No slash command in this package. Callers (e.g.
`/session-info`) open the host from the existing slash registry.

## Proposed public API (normative names)

Suggested module: `src/tui/modal-host.ts` (name may shift if a sibling file
already claims it; keep it under `src/tui/` and capability-gated).

```ts
type ModalTab = { id: string; label: string };

type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];          // length >= 1
  initialTab?: string;                // default tabs[0].id
  renderTab: (tabId: string, body: unknown /* OpenTUI parent */) => void | (() => void);
  onClose?: () => void;
};

type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};
```

`openModal` must:

1. Call `chrome.withOverlay` (or `addOverlaySource`) for the modal lifetime.
2. Blur the composer; on close, restore composer focus and the prior
   scroll offset if the host changed it.
3. Refuse to open a second modal on the same renderer (queue or replace —
   v1: **replace** the previous modal after its `onClose`).
4. Ignore unknown `initialTab` and fall back to `tabs[0]`.

## Data contracts

None persisted. In-memory tab ids are opaque strings; callers own uniqueness
inside one `openModal` call.

## Integration points

- `ShellChrome.overlayActive` / `withOverlay` / `addOverlaySource`.
- Slash menu: inert while overlay active (already tested in
  `shell-chrome.test.ts`).
- Block nav (`Ctrl+O`): already disabled when overlay is up.
- First consumer: session-info (follow-up flow; not shipped here).
- Later consumer (out of scope here): remount `selectProviderModelInTui`
  steps as tab bodies (`Providers` / `Models`) instead of stacked
  full-screen `overlayBox` calls.

## Grok reference (behavior to copy, not code)

Observed from Grok Build user-guide (not from keryx source):

- One **extensions modal**, four entry commands, each selecting a tab.
- `/session-info` is an inspect modal with a **Session info** tab.
- Steal-Esc: overlays dismiss before composer/clear/rewind.
- `/settings` and `/config-agents` are the same overlay class.

Keryx must copy the **host pattern**, not Grok's catalog contents.

## Current keryx baseline (do not regress)

- `overlayBox` in `src/tui/tui-shell.ts` is a 100% absolute box — pickers
  today **cover** the shell. The new host is a **panel**, not a replacement
  of that helper until callers migrate.
- `selectProviderModelInTui` stays the `/model` path until a later flow.
- Zero top-level `@opentui/core` imports remains law.

## Acceptance criteria

- **AC-1:** `openModal` with one tab paints a titled panel and backdrop;
  the slash menu does not open on `/` until dismiss.
- **AC-2:** `openModal` with tabs `[a,b]` and `initialTab: "b"` mounts only
  `b`'s body; `←` then mounts `a` and unmounts `b` (cleanup fn from
  `renderTab` runs).
- **AC-3:** Two sequential `openModal` calls with different `initialTab`
  values (simulating `/hooks` vs `/plugins`) share one host implementation.
- **AC-4:** `Esc` closes the modal, runs `onClose`, restores composer
  focus, and `overlayActive()` becomes false.
- **AC-5:** Opening the host without OpenTUI available is a no-op or a
  typed skip; readline `/` commands are unchanged.
- **AC-6:** Headless tests exist under `src/tui/` and do not require a
  user TTY.

## Delivery order

1. This package (host + tests).
2. Session info (follow-up flow).
3. Optional later: model picker on the same host.
