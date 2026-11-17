import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { overlayOpen } from "../components/ui";
import {
  browserClose,
  browserGo,
  browserLayout,
  browserList,
  browserNavigate,
  browserOpen,
  browserSelect,
  onBrowserEvent,
  type BrowserTab,
} from "../platform/panels";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function tabLabel(t: BrowserTab): string {
  if (t.title.trim()) return t.title.trim();
  try {
    const u = new URL(t.url);
    return u.host || t.url;
  } catch {
    return t.url || "New tab";
  }
}

/** Tabs by id after one browser event. */
export function applyBrowserTab(tabs: BrowserTab[], tab: BrowserTab): BrowserTab[] {
  const i = tabs.findIndex((t) => t.id === tab.id);
  if (i < 0) return [...tabs, tab];
  const next = tabs.slice();
  next[i] = tab;
  return next;
}

/**
 * Browser tabs of the side panel. The pages themselves are native child web views the host lays over
 * `.browser-body`; this view owns the chrome (tabs, address, back/forward/reload) and reports where
 * the body is. The pages stay hidden while a dialog or menu is open, which they would cover.
 */
export function BrowserPanel({ cwd, visible }: { cwd: string; visible: boolean }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeTab = tabs.find((t) => t.id === active) ?? null;

  useEffect(() => {
    let live = true;
    browserList()
      .then((list) => {
        if (!live) return;
        setTabs(list);
        setActive(list.find((t) => t.active)?.id ?? list[list.length - 1]?.id ?? null);
      })
      .catch((e) => live && setError(errText(e)));
    let off: (() => void) | null = null;
    void onBrowserEvent((e) => {
      if (e.kind === "tab") {
        setTabs((t) => applyBrowserTab(t, e.tab));
        if (e.tab.active) setActive(e.tab.id);
      } else if (e.kind === "closed") {
        setTabs((t) => t.filter((x) => x.id !== e.id));
        setActive((a) => (a === e.id ? null : a));
      } else setActive(e.id);
    }).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // The address bar follows the active page unless the user is typing in it.
  const shownUrl = activeTab && activeTab.url !== "about:blank" ? activeTab.url : "";
  useEffect(() => {
    if (!editing) setAddress(shownUrl);
  }, [shownUrl, editing]);

  // Tell the host where the page goes; hide it when the panel or tab is hidden, or an overlay is up.
  const layout = useCallback(() => {
    const el = body.current;
    const show = visible && active !== null && !overlayOpen() && el !== null && el.offsetWidth > 0;
    if (!el || !show) {
      void browserLayout(null, false).catch(() => {});
      return;
    }
    const r = el.getBoundingClientRect();
    void browserLayout({ x: r.left, y: r.top, width: r.width, height: r.height }, true).catch(() => {});
  }, [visible, active]);

  useLayoutEffect(() => {
    layout();
    const el = body.current;
    const ro = new ResizeObserver(layout);
    if (el) ro.observe(el);
    window.addEventListener("resize", layout);
    // Dialogs and menus come and go without resizing anything.
    let overlay = overlayOpen();
    const poll = window.setInterval(() => {
      if (overlayOpen() !== overlay) {
        overlay = overlayOpen();
        layout();
      }
    }, 200);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", layout);
      window.clearInterval(poll);
      void browserLayout(null, false).catch(() => {});
    };
  }, [layout]);

  const go = async (raw: string) => {
    setError(null);
    setEditing(false);
    try {
      if (activeTab) await browserNavigate(activeTab.id, raw);
      else {
        const t = await browserOpen(cwd, raw);
        setTabs((list) => applyBrowserTab(list, t));
        setActive(t.id);
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const newTab = () => {
    setActive(null);
    setAddress("");
    setEditing(true);
    input.current?.focus();
  };

  const select = (id: number) => {
    setError(null);
    setActive(id);
    void browserSelect(id).catch(() => {});
  };

  const close = (id: number) => {
    void browserClose(id).catch(() => {});
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (active === id) setActive(rest.at(-1)?.id ?? null);
  };

  return (
    <div className="browser-panel">
      <div className="panel-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`panel-tab${t.id === active ? " is-active" : ""}`}>
            <button role="tab" aria-selected={t.id === active} className="panel-tab-btn" onClick={() => select(t.id)} title={t.url}>
              <Icon name="globe" size={12} />
              <span className="truncate">{tabLabel(t)}</span>
            </button>
            <button className="icon-btn icon-btn-sm" onClick={() => close(t.id)} aria-label={`Close ${tabLabel(t)}`} title="Close tab">
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn icon-btn-sm" onClick={newTab} aria-label="New browser tab" title="New tab">
          <Icon name="plus" size={13} />
        </button>
      </div>
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void go(address);
        }}
      >
        <button type="button" className="icon-btn icon-btn-sm" disabled={!activeTab} onClick={() => activeTab && void browserGo(activeTab.id, "back")} aria-label="Back" title="Back">
          <Icon name="arrowLeft" size={13} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!activeTab} onClick={() => activeTab && void browserGo(activeTab.id, "forward")} aria-label="Forward" title="Forward">
          <Icon name="arrowRight" size={13} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!activeTab} onClick={() => activeTab && void browserGo(activeTab.id, "reload")} aria-label="Reload" title="Reload">
          <Icon name={activeTab?.loading ? "loader" : "refresh"} size={13} />
        </button>
        <input
          ref={input}
          className="browser-address"
          value={address}
          placeholder="localhost:5173 or an address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address"
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
        />
      </form>
      {error ? (
        <div className="browser-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </div>
      ) : null}
      <div ref={body} className="browser-body" data-testid="browser-body">
        {!activeTab ? (
          <div className="panel-empty">
            <span>Type a local dev server address (localhost:5173) or any http(s) address. Pages here keep their own storage for this project.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
