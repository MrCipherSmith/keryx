import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri, listen } from "../platform/backend";
import { basename } from "../lib/format";
import { getPrefs, MOD, setPrefs, usePrefs, type SidePanelTab } from "../lib/prefs";
import { SidePanel } from "../panels/SidePanel";
import { overlayOpen } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { Kbd } from "../components/ui";
import { projectHue, projectInitials, type ProjectActivity } from "./projectRail";

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
  /** The projects on the rail, in the user's order; `cwd` is one of them. */
  projects: string[];
  /** This window's project's live state (other projects run no keryx here). */
  activity: ProjectActivity;
  onRemoveProject: (cwd: string) => void;
  onOpenFolder: () => void;
  onSwitchProject: (cwd: string) => void;
  onNewWindow: (cwd: string) => void;
  onCloseProject: () => void;
  onPalette: () => void;
  children: ReactNode;
}

let lastToggle = 0;

export function toggleSidePanel(tab: SidePanelTab, current: SidePanelTab | null): void {
  lastToggle = Date.now();
  setPrefs({ sidePanel: current === tab ? null : tab });
}

/**
 * A panel shortcut from the native menu (`menu://panel`). The menu also sees keys the page already
 * handled; a toggle the page made a moment ago is that same key press and is not repeated.
 */
export function onMenuPanel(id: string, openPalette: () => void): void {
  if (overlayOpen() && id !== "palette") return;
  if (id === "palette") openPalette();
  else if ((id === "terminal" || id === "browser") && Date.now() - lastToggle > 250) toggleSidePanel(id, getPrefs().sidePanel);
}

/** `Ctrl+\`` toggles the terminal, `Cmd+Shift+B` the browser; caught before a focused terminal sees them. */
export function sidePanelShortcut(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): SidePanelTab | null {
  if (e.altKey) return null;
  if (e.code === "Backquote" && e.ctrlKey && !e.metaKey) return "terminal";
  if (e.code === "KeyB" && e.metaKey && e.shiftKey && !e.ctrlKey) return "browser";
  return null;
}

function useSidePanelShortcuts(openPalette: () => void): void {
  const palette = useRef(openPalette);
  palette.current = openPalette;
  useEffect(() => {
    let off: (() => void) | null = null;
    let live = true;
    void listen<string>("menu://panel", (id) => onMenuPanel(id, () => palette.current())).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tab = sidePanelShortcut(e);
      if (!tab || overlayOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSidePanel(tab, getPrefs().sidePanel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function AppShell(p: ShellProps) {
  const overlay = useTitlebarInset();
  const prefs = usePrefs();
  useSidePanelShortcuts(p.onPalette);
  const side = prefs.sidePanel !== null;
  return (
    <div
      className={`app-shell${overlay ? " titlebar-overlay" : ""}${side ? " with-side" : ""}`}
      style={side ? ({ "--side-w": `${prefs.sidePanelWidth}px` } as React.CSSProperties) : undefined}
    >
      <TitleBar {...p} />
      <Rail {...p} />
      <main className="app-main" id="main">
        {p.children}
      </main>
      <SidePanel cwd={p.cwd} />
    </div>
  );
}

/** Title-bar toggles of the side panel's terminal and browser. */
function SideToggles() {
  const prefs = usePrefs();
  const items: Array<{ tab: SidePanelTab; icon: IconName; label: string; keys: string }> = [
    { tab: "terminal", icon: "terminal", label: "Terminal", keys: "Ctrl+`" },
    { tab: "browser", icon: "globe", label: "Browser", keys: `${MOD}⇧B` },
  ];
  return (
    <>
      {items.map((i) => (
        <button
          key={i.tab}
          className={`icon-btn titlebar-toggle${prefs.sidePanel === i.tab ? " is-on" : ""}`}
          onClick={() => toggleSidePanel(i.tab, prefs.sidePanel)}
          aria-pressed={prefs.sidePanel === i.tab}
          title={`${prefs.sidePanel === i.tab ? "Hide" : "Show"} ${i.label.toLowerCase()} (${i.keys})`}
          aria-label={i.label}
        >
          <Icon name={i.icon} size={15} />
        </button>
      ))}
    </>
  );
}

/** Shows or hides the session info (the side panel's Info tab; on the session view only). */
function InfoToggle({ show }: { show: boolean }) {
  const prefs = usePrefs();
  if (!show) return null;
  const on = prefs.sidePanel === "info";
  return (
    <button
      className={`icon-btn titlebar-toggle${on ? " is-on" : ""}`}
      onClick={() => toggleSidePanel("info", prefs.sidePanel)}
      aria-pressed={on}
      title={on ? "Hide session info" : "Show session info"}
      aria-label="Session info"
    >
      <Icon name="info" size={15} />
    </button>
  );
}

function TitleBar(p: ShellProps) {
  const { cwd, recents, title, status, onOpenFolder, onSwitchProject, onNewWindow, onCloseProject, onPalette } = p;
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
        <InfoToggle show={p.view === "session"} />
        <SideToggles />
        <button className="palette-btn" onClick={onPalette} title="Commands and sessions">
          <Icon name="search" size={13} />
          <span>Commands</span>
          <Kbd>{MOD}K</Kbd>
        </button>
      </div>
    </header>
  );
}

const ACTIVITY_LABEL: Record<ProjectActivity, string> = {
  action: "needs your answer",
  busy: "working",
  idle: "",
};

/** One project on the rail: its initials, a status dot, the full path on hover. */
function ProjectButton({
  path,
  current,
  active,
  activity,
  onOpen,
  onMenu,
}: {
  path: string;
  current: boolean;
  active: boolean;
  activity: ProjectActivity;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void;
}) {
  const name = basename(path);
  const state = ACTIVITY_LABEL[activity];
  const tip = `${name}${current ? " (open)" : ""}${state ? ` · ${state}` : ""}\n${path}`;
  return (
    <button
      className={`rail-project${active ? " is-active" : ""}${current ? " is-current" : ""}`}
      style={{ "--project-hue": projectHue(path) } as React.CSSProperties}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.currentTarget);
      }}
      aria-current={current ? "page" : undefined}
      aria-label={`${name}${state ? `, ${state}` : ""}`}
      title={tip}
    >
      <span className="rail-project-mark">{projectInitials(name)}</span>
      {activity !== "idle" ? <span className={`rail-dot rail-dot-${activity}`} aria-hidden /> : null}
    </button>
  );
}

function Rail(p: ShellProps) {
  const { view, onView, flowsActive, cwd, projects, activity, onSwitchProject, onOpenFolder, onNewWindow, onRemoveProject } = p;
  const [menu, setMenu] = useState<{ path: string; anchor: HTMLElement } | null>(null);
  const items: MenuItem[] = menu
    ? [
        { kind: "header", id: "h", label: <span className="truncate" title={menu.path}>{menu.path}</span> },
        ...(menu.path !== cwd ? [{ id: "open", label: "Open here", icon: "folder" as IconName, onSelect: () => onSwitchProject(menu.path) }] : []),
        { id: "win", label: "Open in a new window", icon: "external", onSelect: () => onNewWindow(menu.path) },
        ...(menu.path !== cwd ? [{ id: "rm", label: "Remove from the bar", icon: "x" as IconName, onSelect: () => onRemoveProject(menu.path) }] : []),
      ]
    : [];
  return (
    <nav className="rail" aria-label="Projects and views">
      <div className="rail-projects" role="list" aria-label="Projects">
        {projects.map((path) => (
          <div role="listitem" key={path}>
            <ProjectButton
              path={path}
              current={path === cwd}
              active={path === cwd && view === "session"}
              // Only this window's project runs a keryx: other projects show no live state.
              activity={path === cwd ? activity : "idle"}
              onOpen={() => (path === cwd ? onView("session") : onSwitchProject(path))}
              onMenu={(anchor) => setMenu({ path, anchor })}
            />
          </div>
        ))}
        <button className="rail-project rail-add" onClick={onOpenFolder} title={`Add a project (${MOD}O)`} aria-label="Add a project">
          <Icon name="plus" size={16} />
        </button>
      </div>
      {menu ? <Menu anchor={menu.anchor} items={items} onClose={() => setMenu(null)} label="Project" width={300} /> : null}
      <div className="rail-sep" />
      <RailButton active={view === "flows"} onClick={() => onView("flows")} icon="board" label="Flows" shortcut={`${MOD}2`}>
        {flowsActive > 0 ? <span className="sr-only">, {flowsActive} active flows</span> : null}
      </RailButton>
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
