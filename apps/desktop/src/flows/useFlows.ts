import { useCallback, useEffect, useRef, useState } from "react";
import { flowsList, flowsWatch, onFlowsChanged, type FlowCard } from "../platform/commands";
import { errMessage } from "../lib/format";

export interface FlowsState {
  cards: FlowCard[];
  loading: boolean;
  error: string | null;
  /** True when the folder has no `.metaproject/flows`. */
  empty: boolean;
  refreshedAt: number | null;
  /** Bumped whenever the watcher or a refresh reloads, so open details re-read. */
  version: number;
}

export function useFlows(cwd: string) {
  const [state, setState] = useState<FlowsState>({
    cards: [],
    loading: true,
    error: null,
    empty: false,
    refreshedAt: null,
    version: 0,
  });
  const inflight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    setState((s) => ({ ...s, loading: true }));
    try {
      const cards = await flowsList(cwd);
      setState((s) => ({
        cards,
        loading: false,
        error: null,
        empty: cards.length === 0,
        refreshedAt: Date.now(),
        version: s.version + 1,
      }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errMessage(e) }));
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [cwd]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void refresh();
    void flowsWatch(cwd).catch(() => {});
    // The core may report a canonicalised path; compare loosely (one project per window).
    const norm = (p: string) => p.replace(/\/+$/, "");
    void onFlowsChanged((p) => {
      if (!p?.cwd || norm(p.cwd) === norm(cwd) || norm(p.cwd).endsWith(norm(cwd))) void refresh();
    }).then((u) => {
      if (alive) off = u;
      else u();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [cwd, refresh]);

  return { ...state, refresh };
}
