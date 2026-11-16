import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "../platform/backend";
import { basename } from "../lib/format";
import { MOD } from "../lib/prefs";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { Kbd } from "../components/ui";

export type View = "session" | "flows" | "settings";

/**
 * With `titleBarStyle: "Overlay"` the web view runs under the traffic lights and
 * the window has no native title bar height; leave room for the lights then.
 * With a standard title bar the inset collapses to normal padding.
 */
function useTitlebarInset(): boolean {
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const check = () => setOverlay(window.outerHeight - window.innerHeight < 8);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return overlay;
}

interface ShellProps {
  cwd: string;
  recents: string[];
  view: View;
  onView: (v: View) => void;
  title: ReactNode;
  status: { tone: "ok" | "busy" | "warn" | "danger" | "idle"; label: string; detail?: string };
  flowsActive: number;
  onOpenFolder: () => void;
  onSwitchProject: (cwd: string) => void;
  onNewWindow: (cwd: string) => void;
  onCloseProject: () => void;
  onPalette: () => void;
  children: ReactNode;
}

export function AppShell(p: ShellProps) {
  const overlay = useTitlebarInset();
  return (
    <div className={`app-shell${overlay ? " titlebar-overlay" : ""}`}>
      <TitleBar {...p} />
      <Rail view={p.view} onView={p.onView} flowsActive={p.flowsActive} />
      <main className="app-main" id="main">
        {p.children}
      </main>
    </div>
  );
}

function TitleBar({ cwd, recents, title, status, onOpenFolder, onSwitchProject, onNewWindow, onCloseProject, onPalette }: ShellProps) {
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const others = recents.filter((r) => r !== cwd).slice(0, 8);
  const items: MenuItem[] = [
    { kind: "header", id: "h-current", label: <span className="truncate" title={cwd}>{cwd}</span> },
    { id: "open", label: "Open Folder…", icon: "folderOpen", hint: `${MOD}O`, onSelect: onOpenFolder },
    { id: "newwin", label: "Open this folder in a new window", icon: "external", onSelect: () => onNewWindow(cwd) },
    ...(others.length
      ? ([{ kind: "separator", id: "s1" }, { kind: "header", id: "h-recent", label: "Recent projects" }] as MenuItem[])
      : []),
    ...others.map<MenuItem>((r) => ({
      id: `r-${r}`,
      label: basename(r),
      description: <span className="truncate">{r}</span>,
      icon: "folder",
      onSelect: () => onSwitchProject(r),
    })),
    { kind: "separator", id: "s2" },
    { id: "close", label: "Close project", icon: "x", onSelect: onCloseProject },
  ];
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <button
          ref={btn}
          className="project-switcher"
          onClick={() => setMenu((m) => !m)}
          aria-haspopup="menu"
          aria-expanded={menu}
          title={cwd}
        >
          <Icon name="folder" size={14} />
          <span className="truncate">{basename(cwd)}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        {menu ? <Menu anchor={btn.current} items={items} onClose={() => setMenu(false)} label="Project" width={320} /> : null}
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {title}
      </div>
      <div className="titlebar-right" data-tauri-drag-region>
        <span className={`conn conn-${status.tone}`} title={status.detail ?? status.label} role="status">
          <span className="conn-dot" />
          {status.label}
        </span>
        <button className="palette-btn" onClick={onPalette} title="Commands and sessions">
          <Icon name="search" size={13} />
          <span>Commands</span>
          <Kbd>{MOD}K</Kbd>
        </button>
      </div>
    </header>
  );
}

const RAIL: Array<{ id: View; label: string; icon: IconName; key: string }> = [
  { id: "session", label: "Session", icon: "chat", key: "1" },
  { id: "flows", label: "Flows", icon: "board", key: "2" },
];

function Rail({ view, onView, flowsActive }: { view: View; onView: (v: View) => void; flowsActive: number }) {
  return (
    <nav className="rail" aria-label="Views">
      {RAIL.map((r) => (
        <RailButton key={r.id} active={view === r.id} onClick={() => onView(r.id)} icon={r.icon} label={r.label} shortcut={`${MOD}${r.key}`}>
          {r.id === "flows" && flowsActive > 0 ? <span className="sr-only">, {flowsActive} active flows</span> : null}
        </RailButton>
      ))}
      <div className="grow" />
      <RailButton active={view === "settings"} onClick={() => onView("settings")} icon="settings" label="Settings" shortcut={`${MOD},`} />
    </nav>
  );
}

function RailButton({
  active,
  onClick,
  icon,
  label,
  shortcut,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  label: string;
  shortcut: string;
  children?: ReactNode;
}) {
  return (
    <button className={`rail-btn${active ? " is-active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined} title={`${label} (${shortcut})`}>
      <Icon name={icon} size={18} />
      <span className="rail-label">{label}</span>
      {children}
    </button>
  );
}
