import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { onOverlayChange, overlayOpen } from "../components/ui";
import {
  browserClose,
  browserEngine,
  browserGo,
  browserLayout,
  browserList,
  browserNavigate,
  browserOpen,
  browserPick,
  browserPickCancel,
  browserSelect,
  isPicked,
  onBrowserEvent,
  type BrowserEngine,
  type BrowserTab,
} from "../platform/panels";
import { ChromeView } from "./ChromeView";
import { CookieImportDialog } from "./CookieImportDialog";
import { addPick } from "./elementPicks";

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
 * Browser tabs of the side panel. This view owns the chrome (tabs, address, back/forward/reload) and
 * reports where `.browser-body` is. On the WebKit engine the pages are native child web views the
 * host lays over the body (hidden while a dialog or menu is open, which they would cover); on the
 * Chromium engine the host sizes the page to the body and this view draws it (`ChromeView`).
 */
export function BrowserPanel({ cwd, visible }: { cwd: string; visible: boolean }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  // The address a new tab is being opened on, shown in the bar until the tab exists.
  const [opening, setOpening] = useState<string | null>(null);
  // A click that focuses the bar selects its whole text (the click's release would put the caret
  // at the click point and drop the selection, so new typing was added to the old address).
  const selectOnRelease = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeTab = tabs.find((t) => t.id === active) ?? null;
  const [engine, setEngine] = useState<BrowserEngine | null>(null);
  const [cookiesOpen, setCookiesOpen] = useState(false);

  useEffect(() => {
    let live = true;
    browserEngine()
      .then((e) => live && setEngine(e))
      .catch(() => live && setEngine("webkit"));
    return () => {
      live = false;
    };
  }, []);

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
      } else if (e.kind === "engine") {
        setEngine(e.engine);
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
  const shownUrl = activeTab ? (activeTab.url !== "about:blank" ? activeTab.url : "") : (opening ?? "");
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
    const offOverlay = onOverlayChange(layout);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", layout);
      offOverlay();
    };
  }, [layout]);

  // Leaving the panel hides the pages; they keep running for when it comes back.
  useEffect(() => () => void browserLayout(null, false).catch(() => {}), []);

  const go = async (raw: string) => {
    // A second Enter while the new tab opens would open another one.
    if (!activeTab && opening !== null) return;
    setError(null);
    // The page takes over: the bar shows its address from now on, not the draft.
    setEditing(false);
    input.current?.blur();
    try {
      if (activeTab) await browserNavigate(activeTab.id, raw);
      else {
        setOpening(raw.trim());
        const t = await browserOpen(cwd, raw);
        setTabs((list) => applyBrowserTab(list, t));
        setActive(t.id);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setOpening(null);
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

  // The element picker: one at a time, on the active tab. It ends when the user clicks an element or
  // presses Esc in the page, when the button is pressed again, or when the tab or panel goes away.
  const [picking, setPicking] = useState<number | null>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const togglePick = useCallback(async () => {
    const current = pickingRef.current;
    if (current !== null) {
      void browserPickCancel(current).catch(() => {});
      return;
    }
    if (active === null) return;
    const id = active;
    setError(null);
    setPicking(id);
    try {
      const result = await browserPick(id);
      if (isPicked(result)) addPick(cwd, result);
    } catch (e) {
      setError(`Could not pick an element: ${errText(e)}`);
    } finally {
      setPicking((p) => (p === id ? null : p));
    }
  }, [active, cwd]);
  useEffect(() => {
    if (picking === null || (visible && active === picking)) return;
    void browserPickCancel(picking).catch(() => {});
  }, [picking, visible, active]);
  useEffect(() => () => void (pickingRef.current !== null && browserPickCancel(pickingRef.current).catch(() => {})), []);
  // Cmd+Shift+C starts or stops it while the app (not the page) has focus.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyC" || !e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      void togglePick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, togglePick]);

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
          onMouseDown={(e) => {
            selectOnRelease.current = document.activeElement !== e.currentTarget;
          }}
          onMouseUp={(e) => {
            if (!selectOnRelease.current) return;
            selectOnRelease.current = false;
            e.preventDefault();
            e.currentTarget.select();
          }}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            // Typing is editing, whatever the focus events said: the page's address never replaces a draft.
            setEditing(true);
            setAddress(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={`icon-btn icon-btn-sm${picking !== null ? " is-on" : ""}`}
          disabled={!activeTab || activeTab.loading}
          onClick={() => void togglePick()}
          aria-pressed={picking !== null}
          aria-label={picking !== null ? "Stop picking" : "Pick an element"}
          title={picking !== null ? "Stop picking (Esc in the page)" : "Pick an element to add to the message (⌘⇧C)"}
        >
          <Icon name="pick" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={() => setCookiesOpen(true)}
          aria-label="Import cookies from Chrome"
          title="Import cookies from Chrome…"
        >
          <Icon name="lock" size={13} />
        </button>
      </form>
      {cookiesOpen ? <CookieImportDialog cwd={cwd} engine={engine} onClose={() => setCookiesOpen(false)} /> : null}
      {error ? (
        <div className="browser-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </div>
      ) : null}
      <div ref={body} className="browser-body" data-testid="browser-body">
        {engine === "chromium" && activeTab ? <ChromeView tab={activeTab.id} /> : null}
        {!activeTab ? (
          <div className="panel-empty">
            <span>Type a local dev server address (localhost:5173) or any http(s) address. Pages here keep their own storage for this project.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
