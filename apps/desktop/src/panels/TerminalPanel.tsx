import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { onAgentTerminal, ptyClose, ptyList, ptyOpen, ptyWrite, type PtyTab } from "../platform/panels";
import { notifyTabClosed, onCloseTabRequest, onRunRequest, onShowTab } from "./panelBus";
import { TermView } from "./TermView";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Terminal tabs of the side panel. The PTYs belong to the window and outlive this view. */
export function TerminalPanel({ cwd }: { cwd: string }) {
  const toast = useToast();
  const [tabs, setTabs] = useState<PtyTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const state = useRef({ tabs, active });
  state.current = { tabs, active };
  const opening = useRef<Promise<PtyTab> | null>(null);

  const open = useCallback((): Promise<PtyTab> => {
    if (opening.current) return opening.current;
    const p = ptyOpen(cwd, 80, 24)
      .then((tab) => {
        setTabs((t) => [...t.filter((x) => x.id !== tab.id), tab]);
        setActive(tab.id);
        setError(null);
        return tab;
      })
      .finally(() => {
        opening.current = null;
      });
    opening.current = p;
    return p;
  }, [cwd]);

  // Tabs that already run (the panel was closed and reopened), or a first one.
  useEffect(() => {
    let live = true;
    ptyList()
      .then((list) => {
        if (!live) return;
        setLoaded(true);
        if (list.length > 0) {
          setTabs(list);
          setActive((a) => a ?? list[list.length - 1]!.id);
        } else void open().catch((e) => live && setError(errText(e)));
      })
      .catch((e) => {
        if (!live) return;
        setLoaded(true);
        setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let live = true;
    void onAgentTerminal((tab) => {
      setTabs((t) => (t.some((x) => x.id === tab.id) ? t : [...t, tab]));
      setActive(tab.id);
    }).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // Run buttons: the active tab while its shell runs, a new tab otherwise.
  useEffect(
    () =>
      onRunRequest((command) => {
        const { tabs: list, active: id } = state.current;
        const target = list.find((t) => t.id === id && t.running);
        const tab = target ? Promise.resolve(target) : open();
        void tab
          .then((t) => {
            setActive(t.id);
            return ptyWrite(t.id, `${command}\r`);
          })
          .catch((e) => toast({ level: "error", title: "Could not run the command", body: errText(e) }));
      }),
    [open, toast],
  );

  // `/delegate`: a tab opened by the app; shown and focused.
  useEffect(
    () =>
      onShowTab((tab) => {
        setTabs((t) => (t.some((x) => x.id === tab.id) ? t : [...t, tab]));
        setActive(tab.id);
      }),
    [],
  );

  const closeRef = useRef<(id: number) => void>(() => {});
  const close = (id: number) => {
    notifyTabClosed(id);
    void ptyClose(id).catch(() => {});
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id);
      if (state.current.active === id) setActive(rest.length ? rest[rest.length - 1]!.id : null);
      return rest;
    });
  };

  closeRef.current = close;
  // A model-started `/delegate` run that returned its answer: its tab closes like the user's close button.
  useEffect(() => onCloseTabRequest((id) => closeRef.current(id)), []);
  const markExited = (id: number, code: number | null) =>
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, running: false, exitCode: code } : x)));

  return (
    <div className="term-panel">
      <div className="panel-tabs" role="tablist" aria-label="Terminal tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`panel-tab${t.id === active ? " is-active" : ""}${t.running ? "" : " is-exited"}`}>
            <button role="tab" aria-selected={t.id === active} className="panel-tab-btn" onClick={() => setActive(t.id)} title={t.cwd}>
              <Icon name={t.owner === "agent" ? "sparkle" : "terminal"} size={12} />
              <span className="truncate">{t.title}</span>
            </button>
            <button className="icon-btn icon-btn-sm" onClick={() => close(t.id)} aria-label={`Close ${t.title}`} title="Close tab">
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn icon-btn-sm" onClick={() => void open().catch((e) => setError(errText(e)))} aria-label="New terminal" title="New terminal">
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="term-body">
        {tabs.map((t) => (
          <TermView key={t.id} id={t.id} active={t.id === active} onExit={(code) => markExited(t.id, code)} onError={setError} />
        ))}
        {error ? (
          <div className="panel-empty" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : loaded && tabs.length === 0 ? (
          <div className="panel-empty">
            <button className="btn btn-sm" onClick={() => void open().catch((e) => setError(errText(e)))}>
              <Icon name="plus" size={13} /> New terminal
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
