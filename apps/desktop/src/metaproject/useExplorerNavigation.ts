import { useLayoutEffect, useRef, useState } from "react";
import type { MetaprojectOpenSpecKind } from "../../../../src/integrations/metaproject-explorer-contract";
import type { OpenSpecLocation } from "./OpenSpecView";

type Route =
  | { mode: "graph"; query: string; selection: string; panelOpen: boolean; archive?: boolean }
  | { mode: "wiki"; query: string; selection: string; fragment?: string }
  | { mode: "openspec"; query: string; collection: MetaprojectOpenSpecKind; location: OpenSpecLocation | null };

const INITIAL: { [Mode in Route["mode"]]: Extract<Route, { mode: Mode }> } = {
  graph: { mode: "graph", query: "", selection: "", panelOpen: false },
  wiki: { mode: "wiki", query: "", selection: "" },
  openspec: { mode: "openspec", query: "", collection: "spec", location: null },
};
const PANES = [".metaproject-panes", ".metaproject-list", ".metaproject-content", ".metaproject-node-body"];

export function useExplorerNavigation() {
  const [route, setRoute] = useState<Route>(INITIAL.graph);
  const [history, setHistory] = useState<Route[]>([]);
  const remembered = useRef<Partial<Record<Route["mode"], Route>>>({});
  const scroll = useRef(new WeakMap<Route, number[]>());
  const restore = useRef<Route | null>(null);
  const root = useRef<HTMLElement>(null);

  function panes() {
    return PANES.map(selector => root.current?.querySelector<HTMLElement>(selector));
  }

  function remember() {
    remembered.current[route.mode] = route;
    scroll.current.set(route, panes().map(pane => pane?.scrollTop ?? 0));
  }

  function visit(next: Route) {
    if (next === route) return;
    remember();
    restore.current = next;
    setHistory(current => [...current.slice(-39), route]);
    setRoute(next);
  }

  function switchView(mode: Route["mode"]) {
    if (mode !== route.mode) visit(remembered.current[mode] ?? INITIAL[mode]);
  }

  function back() {
    const previous = history.at(-1);
    if (!previous) return;
    remember();
    restore.current = previous;
    setHistory(current => current.slice(0, -1));
    setRoute(previous);
  }

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
  }, [route]);

  return { route, setRoute, visit, switchView, back, canGoBack: history.length > 0, root };
}
