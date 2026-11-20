import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { onAgentTerminal, onBrowserEvent } from "../platform/panels";
import { Icon } from "../components/Icon";
import { fitSidePanelWidth, setPrefs, usePrefs, type SidePanelTab } from "../lib/prefs";
import { Spinner } from "../components/ui";
import type { IconName } from "../components/Icon";
import { slotRef, useActivityRunning } from "./sideSlots";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const BrowserPanel = lazy(() => import("./BrowserPanel").then((m) => ({ default: m.BrowserPanel })));
const FilesPanel = lazy(() => import("./FilesPanel").then((m) => ({ default: m.FilesPanel })));

export const SIDE_TABS: Array<{ id: SidePanelTab; label: string; icon: IconName }> = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "browser", label: "Browser", icon: "globe" },
  { id: "activity", label: "Activity", icon: "checklist" },
  { id: "info", label: "Info", icon: "info" },
  { id: "files", label: "Files", icon: "folder" },
];

/** The agent used a panel tool: show that tab of the panel, even when the panel is closed. */
function useAgentReveal(): void {
  useEffect(() => {
    let live = true;
    const offs: Array<() => void> = [];
    const keep = (u: () => void) => (live ? offs.push(u) : u());
    void onAgentTerminal(() => setPrefs({ sidePanel: "terminal" })).then(keep);
    void onBrowserEvent((e) => {
      if (e.kind === "show") setPrefs({ sidePanel: "browser" });
    }).then(keep);
    return () => {
      live = false;
      offs.forEach((u) => u());
    };
  }, []);
}

/** The right side panel of a project window (D-13): Terminal, Browser, Activity and Info tabs. */
export function SidePanel({ cwd, visible = true }: { cwd: string; visible?: boolean }) {
  const prefs = usePrefs();
  useAgentReveal();
  const running = useActivityRunning();
  const tab = prefs.sidePanel;
  const panel = useRef<HTMLElement>(null);
  // A tab is mounted once first shown (a terminal is not started for a panel opened on the browser).
  const [shown, setShown] = useState<ReadonlySet<SidePanelTab>>(new Set());
  if (tab && !shown.has(tab)) setShown(new Set([...shown, tab]));
  if (!tab) return null;

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.current?.offsetWidth ?? prefs.sidePanelWidth;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // As wide as the window allows: dragging past that stores no width the chat cannot afford.
      const sidebar = document.querySelector<HTMLElement>(".session-sidebar")?.offsetWidth ?? 0;
      setPrefs({ sidePanelWidth: fitSidePanelWidth(startW + (startX - ev.clientX), window.innerWidth, sidebar) });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <aside ref={panel} className="side-panel" aria-label="Side panel" hidden={!visible}>
      <div className="side-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize side panel" />
      <div className="side-head">
        <div className="side-switch" role="tablist" aria-label="Side panel">
          {SIDE_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`side-switch-btn${tab === t.id ? " is-active" : ""}`}
              onClick={() => setPrefs({ sidePanel: t.id })}
            >
              <Icon name={t.icon} size={13} />
              {t.label}
              {t.id === "activity" && running > 0 ? <span className="tab-count" title="Running">{running}</span> : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="icon-btn icon-btn-sm" onClick={() => setPrefs({ sidePanel: null })} aria-label="Close side panel" title="Close panel">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="side-body">
        <Suspense fallback={<Spinner size={14} />}>
          {/* Both stay mounted while the panel is open, so switching keeps the screens. */}
          {shown.has("terminal") || tab === "terminal" ? (
            <div className="side-pane" hidden={tab !== "terminal"}>
              <TerminalPanel cwd={cwd} />
            </div>
          ) : null}
          {shown.has("browser") || tab === "browser" ? (
            <div className="side-pane" hidden={tab !== "browser"}>
              <BrowserPanel cwd={cwd} visible={visible && tab === "browser"} />
            </div>
          ) : null}
          {shown.has("files") || tab === "files" ? (
            <div className="side-pane" hidden={tab !== "files"}>
              <FilesPanel cwd={cwd} visible={visible && tab === "files"} />
            </div>
          ) : null}
        </Suspense>
        {/* Activity and Info are the session view's: it portals them into these slots (see sideSlots.ts). */}
        {tab === "activity" || tab === "info" ? <div key={tab} className="side-pane side-slot" data-slot={tab} ref={slotRef(tab)} /> : null}
      </div>
    </aside>
  );
}
