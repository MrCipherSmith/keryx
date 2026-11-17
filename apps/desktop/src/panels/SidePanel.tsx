import { lazy, Suspense, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { setPrefs, SIDE_PANEL_MAX, SIDE_PANEL_MIN, usePrefs, type SidePanelTab } from "../lib/prefs";
import { Spinner } from "../components/ui";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const BrowserPanel = lazy(() => import("./BrowserPanel").then((m) => ({ default: m.BrowserPanel })));

const TABS: Array<{ id: SidePanelTab; label: string; icon: "terminal" | "globe" }> = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "browser", label: "Browser", icon: "globe" },
];

/** The right side panel of a project window (D-13): terminal and browser tabs. */
export function SidePanel({ cwd }: { cwd: string }) {
  const prefs = usePrefs();
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
      const w = Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, startW + (startX - ev.clientX)));
      setPrefs({ sidePanelWidth: Math.round(w) });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <aside ref={panel} className="side-panel" aria-label="Side panel">
      <div className="side-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize side panel" />
      <div className="side-head">
        <div className="side-switch" role="tablist" aria-label="Side panel">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`side-switch-btn${tab === t.id ? " is-active" : ""}`}
              onClick={() => setPrefs({ sidePanel: t.id })}
            >
              <Icon name={t.icon} size={13} />
              {t.label}
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
              <BrowserPanel cwd={cwd} visible={tab === "browser"} />
            </div>
          ) : null}
        </Suspense>
      </div>
    </aside>
  );
}
