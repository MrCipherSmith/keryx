// The type-to-filter list machinery shared by every TUI picker: `/model`'s
// `pickModelInTui` (`tui-shell.ts`), the session switcher, and — flow 305 —
// `/routing`'s flat model picker. Extracted out of `tui-shell.ts` (which owns
// no imports from the `*-inspector.ts` modal files, only the reverse) so a
// NEW modal module can reuse it without a `tui-shell.ts` <-> modal import
// cycle. Behavior is unchanged from the version that lived inline in
// `tui-shell.ts`.
import { getTheme } from "./theme";
import { selectThemeColors } from "./shell-chrome";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
export type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift?: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/** What {@link mountFilterList} renders: `items`, narrowed by a typed filter. */
export interface FilterListSpec<T> {
  idPrefix: string;
  items: readonly T[];
  toOption: (item: T) => { name: string; description: string };
  /** `query` is already trimmed and lower-cased. */
  matches: (item: T, query: string) => boolean;
  /** The placeholder row when `items` itself is empty. */
  emptyLabel: string;
  /** Filter-line text while no filter is typed. */
  idleHint: string;
  filterHint: (filter: string, shown: number, total: number) => string;
  showDescription: boolean;
  width: number | "100%";
  height: number;
  /** Enter on a row: the item, or `undefined` on a placeholder row. */
  onPick: (item: T | undefined) => void;
}

/**
 * The type-to-filter list every picker shares, in either host (the full-screen
 * overlay or a ModalHost tab body): a filter line over a focused
 * `SelectRenderable`. ↑/↓/Enter stay native to the select; the returned `onKey`
 * edits the filter on printable keys and Backspace. Esc belongs to the host.
 */
export function mountFilterList<T>(
  otui: OpenTui,
  r: Renderer,
  parent: Box,
  spec: FilterListSpec<T>,
): { onKey: (key: KeypressEvent) => void } {
  const filterLine = new otui.TextRenderable(r, { id: `${spec.idPrefix}-filter`, content: "" });
  parent.add(filterLine);
  const sel = new otui.SelectRenderable(r, {
    id: `${spec.idPrefix}-sel`,
    width: spec.width,
    showDescription: spec.showDescription,
    height: spec.height,
    showScrollIndicator: true,
    wrapSelection: true,
    options: [],
    ...selectThemeColors(getTheme()),
  });
  parent.add(sel);
  sel.focus();

  let filter = "";
  let shown: readonly T[] = spec.items;
  const apply = (): void => {
    const q = filter.trim().toLowerCase();
    shown = q.length > 0 ? spec.items.filter((item) => spec.matches(item, q)) : spec.items;
    sel.options =
      shown.length > 0
        ? shown.map(spec.toOption)
        : [{ name: spec.items.length === 0 ? spec.emptyLabel : "(no match)", description: "" }];
    sel.selectedIndex = 0;
    filterLine.content = otui.t`${dimChunk(otui,
      q.length > 0 ? spec.filterHint(filter, shown.length, spec.items.length) : spec.idleHint,
    )}`;
  };
  apply();

  sel.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
    spec.onPick(shown[sel.getSelectedIndex()]);
  });

  return {
    onKey: (key) => {
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        apply();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      const ch = key.sequence;
      if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
        filter += ch;
        apply();
        key.preventDefault();
        key.stopPropagation();
      }
    },
  };
}
