// Flow 303 (AC6, AC8): the `/help` modal — one tab per onboarding group,
// in order (`←`/`→` switch tabs, `modal-host.ts`'s own job); inside a tab,
// `↑`/`↓` move a selection cursor over that group's commands, `Enter` shows
// the selected command's detail (usage-shaped: what it is, whether it needs
// a model, whether it only reads), and `Esc` closes (`modal-host.ts`'s own
// job too). Same shape as `schedules-inspector.ts`'s list modal: one
// `TextRenderable` body per tab, keys delivered through a caller-supplied
// `onKeypress` (never a second internal subscription — `modal-host.ts`
// already owns Esc, arrows and the 1..9 tab jump).
//
// ZONE NOTE: this file is in `src/tui/`, a CLIENT zone module. It reaches
// `HELP_GROUPS` ONLY through `../standard/service` (the facade) — see the
// zone note at the top of `src/standard/help-groups.ts`.

import {
  entriesInGroup,
  findEntry,
  groupBySlug,
  HELP_GROUP_ORDER,
  renderEntryDetail,
  type HelpEntry,
  type HelpGroupDef,
} from "../standard/service";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const HELP_MODAL_TITLE = "/help";

/** The keys, shown as the first line of every tab (mirrors `schedules-inspector.ts`'s `DETAIL_KEYS`/`LIST_KEYS`). */
export const HELP_MODAL_KEYS = "keys: ↑/↓ select · enter details · ←/→ tabs · esc close";

/** Every group tab, in onboarding order — `id` is the group's CLI-addressable slug. */
export const HELP_MODAL_TABS = HELP_GROUP_ORDER.map((g) => ({ id: g.slug, label: g.name }));

/** A group's commands in list order: CLI verbs first, then slash commands. */
function entriesForGroup(group: HelpGroupDef): HelpEntry[] {
  return [...entriesInGroup(group.name, "cli"), ...entriesInGroup(group.name, "slash")];
}

interface TabState {
  readonly entries: readonly HelpEntry[];
  selected: number;
  detail: boolean;
  scroll: number;
}

export interface HelpModalOptions {
  /** Delivers keypresses to this modal's own handler (never blocked by another overlay). */
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  inputBlocked?: () => boolean;
  /** Opens on this group's tab instead of the first (AC8: first-run opens on "Connect a model provider"). */
  initialGroupSlug?: string;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
}

export interface HelpModalHandle extends ModalHandle {
  /** The lines currently visible in the active tab, for tests. */
  visibleLines(): readonly string[];
  /** The selected entry's `kind:name` in the active tab (`cli:init`, `slash:/theme`), or `undefined` if the group is empty. */
  selectedEntry(): string | undefined;
  /** Whether the active tab is showing a command's detail rather than the list. */
  showingDetail(): boolean;
}

function bodyRowsFor(chrome: unknown, options: Pick<HelpModalOptions, "renderer" | "visibleRows">): number {
  const hint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const rows =
    typeof hint?.width === "number" && typeof hint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(hint.width, hint.height).height)
      : 13;
  return Math.max(1, (options.visibleRows ?? rows) - 2);
}

/** Open the `/help` modal. Missing OpenTUI/chrome is a typed no-op, same as `openModal`. */
export function openHelpModal(otui: unknown, chrome: unknown, options: HelpModalOptions): HelpModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const bodyRows = bodyRowsFor(chrome, options);
  const states = new Map<string, TabState>(
    HELP_GROUP_ORDER.map((group) => [
      group.slug,
      { entries: entriesForGroup(group), selected: 0, detail: false, scroll: 0 },
    ]),
  );
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const activeState = (): TabState => {
    const id = host.handle?.activeTab() ?? (HELP_MODAL_TABS[0]?.id ?? "");
    const existing = states.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const fallback: TabState = { entries: [], selected: 0, detail: false, scroll: 0 };
    states.set(id, fallback);
    return fallback;
  };

  const tabLines = (state: TabState): string[] => {
    if (state.entries.length === 0) {
      return [HELP_MODAL_KEYS, "", "(no commands in this group)"];
    }
    if (state.detail) {
      const entry = state.entries[state.selected];
      return [HELP_MODAL_KEYS, "", ...(entry === undefined ? ["(nothing selected)"] : wrapLines(renderEntryDetail(entry), width).split("\n"))];
    }
    const rows = state.entries.map((entry, i) => {
      const marker = i === state.selected ? ">" : " ";
      const line = `${marker} ${entry.name}  ${entry.summary}`;
      return wrapLines(line, width).split("\n").join("\n");
    });
    return [HELP_MODAL_KEYS, "", ...rows];
  };

  const paint = (): void => {
    if (closed) {
      return;
    }
    const state = activeState();
    const lines = tabLines(state);
    if (!state.detail) {
      // Keep the cursor row in view (AC6: up/down must visibly move the selection).
      state.scroll = scrollToReveal(state.selected + 2, state.scroll, bodyRows);
    }
    state.scroll = clampScroll(state.scroll, lines.length, bodyRows);
    if (bodyNode !== undefined) {
      bodyNode.content = core.t`${dimChunk(core, windowLines(lines, state.scroll, bodyRows).join("\n"))}`;
    }
  };

  const initialTab =
    options.initialGroupSlug !== undefined && groupBySlug(options.initialGroupSlug) !== undefined
      ? options.initialGroupSlug
      : undefined;

  const handle = openModal(core, chrome as never, {
    title: HELP_MODAL_TITLE,
    tabs: HELP_MODAL_TABS,
    ...(initialTab !== undefined ? { initialTab } : {}),
    footer: [
      { key: "↑/↓", label: "select" },
      { key: "enter", label: "details" },
      { key: "←/→", label: "tabs" },
      { key: "esc", label: "close" },
    ],
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "help-body", content: "" }) as never;
      parent.add(bodyNode as never);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  host.handle = handle;

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) {
      return;
    }
    const token = key.name || key.sequence;
    const state = activeState();
    if (token === "return" || token === "enter") {
      if (state.entries.length > 0) {
        state.detail = !state.detail;
        state.scroll = 0;
      }
      paint();
      return;
    }
    // Detail view scrolls the wrapped detail text; the list view moves the
    // selection cursor. Both live on up/down, same key, different meaning,
    // exactly like `schedules-inspector.ts`'s list (select) vs. detail
    // (scroll) tabs.
    if (token === "up" || token === "k") {
      if (state.detail) {
        state.scroll = clampScroll(state.scroll - 1, tabLines(state).length, bodyRows);
      } else if (state.entries.length > 0) {
        state.selected = Math.max(0, state.selected - 1);
      }
      paint();
      return;
    }
    if (token === "down" || token === "j") {
      if (state.detail) {
        state.scroll = clampScroll(state.scroll + 1, tabLines(state).length, bodyRows);
      } else if (state.entries.length > 0) {
        state.selected = Math.min(state.entries.length - 1, state.selected + 1);
      }
      paint();
    }
  });

  return {
    ...handle,
    visibleLines: () => windowLines(tabLines(activeState()), activeState().scroll, bodyRows),
    selectedEntry: () => {
      const state = activeState();
      const entry = state.entries[state.selected];
      return entry === undefined ? undefined : `${entry.kind}:${entry.name}`;
    },
    showingDetail: () => activeState().detail,
  };
}

/** The slug of the group `findEntry` places `name` in, or `undefined`. Convenience for callers wiring AC8. */
export function groupSlugFor(kind: "cli" | "slash", name: string): string | undefined {
  const entry = findEntry(kind, name);
  if (entry === undefined) {
    return undefined;
  }
  return HELP_GROUP_ORDER.find((g) => g.name === entry.group)?.slug;
}
