import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MetaprojectOpenSpecKind } from "../../../../src/integrations/metaproject-explorer-contract";
import type { OpenSpecLocation } from "./OpenSpecView";

export type Route =
  | { mode: "graph"; query: string; selection: string; panelOpen: boolean; archive?: boolean }
  | { mode: "wiki"; query: string; selection: string; fragment?: string }
  | { mode: "openspec"; query: string; collection: MetaprojectOpenSpecKind; location: OpenSpecLocation | null };

const INITIAL: { [Mode in Route["mode"]]: Extract<Route, { mode: Mode }> } = {
  graph: { mode: "graph", query: "", selection: "", panelOpen: false },
  wiki: { mode: "wiki", query: "", selection: "" },
  openspec: { mode: "openspec", query: "", collection: "spec", location: null },
};
const PANES = [".metaproject-panes", ".metaproject-list", ".metaproject-content", ".metaproject-node-body"];
const CONTENT_PANE = PANES.indexOf(".metaproject-content");
const HISTORY_LIMIT = 40;

/**
 * Route and Back history of the explorer. `visit` and `navigate` add a history entry;
 * `setRoute` changes the current entry in place (query edits, filters, panel close).
 */
export function useExplorerNavigation() {
  const [route, setRoute] = useState<Route>(INITIAL.graph);
  const [history, setHistory] = useState<Route[]>([]);
  const current = useRef(route);
  current.current = route;
  const previousRoutes = useRef(history);
  previousRoutes.current = history;
  const remembered = useRef<Partial<Record<Route["mode"], Route>>>({});
  const scroll = useRef(new WeakMap<Route, number[]>());
  const restore = useRef<Route | null>(null);
  const root = useRef<HTMLElement>(null);

  const panes = useCallback(() => PANES.map(selector => root.current?.querySelector<HTMLElement>(selector)), []);

  const remember = useCallback((leaving: Route) => {
    const offsets = panes().map(pane => pane?.scrollTop ?? 0);
    remembered.current[leaving.mode] = leaving;
    scroll.current.set(leaving, offsets);
    return offsets;
  }, [panes]);

  /** Move to `next` as a new history entry; `seed` is the scroll the new entry starts from. */
  const enter = useCallback((next: Route, seed?: (offsets: number[]) => number[]) => {
    const leaving = current.current;
    if (next === leaving) return;
    const offsets = remember(leaving);
    if (seed) scroll.current.set(next, seed(offsets));
    restore.current = next;
    current.current = next;
    setHistory(entries => [...entries.slice(1 - HISTORY_LIMIT), leaving]);
    setRoute(next);
  }, [remember]);

  const visit = useCallback((next: Route) => enter(next), [enter]);

  /**
   * A selection inside the current view: a history entry that keeps the list and panel
   * scroll where they are. `update` returns null when there is nothing to record.
   */
  const navigate = useCallback((update: (route: Route) => Route | null, options: { resetContent?: boolean } = {}) => {
    const next = update(current.current);
    if (next) enter(next, offsets => offsets.map((top, index) => options.resetContent && index === CONTENT_PANE ? 0 : top));
  }, [enter]);

  const switchView = useCallback((mode: Route["mode"]) => {
    if (mode !== current.current.mode) enter(remembered.current[mode] ?? INITIAL[mode]);
  }, [enter]);

  const back = useCallback(() => {
    const previous = previousRoutes.current.at(-1);
    if (!previous) return;
    remember(current.current);
    restore.current = previous;
    current.current = previous;
    previousRoutes.current = previousRoutes.current.slice(0, -1);
    setHistory(entries => entries.slice(0, -1));
    setRoute(previous);
  }, [remember]);

  useLayoutEffect(() => {
    if (restore.current !== route || !root.current) return;
    const area = root.current;
    const offsets = scroll.current.get(route) ?? PANES.map(() => 0);
    const apply = () => {
      let settled = true;
      panes().forEach((pane, index) => {
        const top = offsets[index] ?? 0;
        if (pane) pane.scrollTop = top;
        if (top && (!pane || pane.scrollTop + 1 < top)) settled = false;
      });
      if (settled) stop();
    };
    const observer = new MutationObserver(apply);
    function stop() {
      observer.disconnect();
      area.removeEventListener("wheel", stop);
      area.removeEventListener("pointerdown", stop);
      area.removeEventListener("keydown", stop);
      if (restore.current === route) restore.current = null;
    }
    observer.observe(area, { subtree: true, childList: true, characterData: true });
    area.addEventListener("wheel", stop, { passive: true });
    area.addEventListener("pointerdown", stop);
    area.addEventListener("keydown", stop);
    apply();
    return stop;
  }, [route, panes]);

  return { route, setRoute, visit, navigate, switchView, back, canGoBack: history.length > 0, root };
}
