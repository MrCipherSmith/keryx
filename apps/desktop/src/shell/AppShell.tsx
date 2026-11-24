import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri, listen } from "../platform/backend";
import { basename } from "../lib/format";
import { fitSidePanelWidth, getPrefs, MOD, setPrefs, usePrefs, type SidePanelTab } from "../lib/prefs";
import { SidePanel } from "../panels/SidePanel";
import { slotRef, useActivityRunning } from "../panels/sideSlots";
import { ConsentDialog } from "../panels/ConsentDialog";
import { overlayOpen } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { Kbd } from "../components/ui";
import { projectHue, projectInitials, type ProjectActivity } from "./projectRail";
import type { LiveProject } from "../platform/projects";
import type { ReviewTabIndicator } from "../review/ReviewBoard";
import type { ReviewsTabIndicator } from "../reviews/ReviewsView";

export type View = "session" | "flows" | "reviews" | "review" | "issues" | "metaproject" | "settings";

/** The project tabs in order (D4): Keryx work (Flows, Reviews) before the GitHub slices; `MOD`+digit follows the order. */
export const PROJECT_VIEWS = [
  { id: "session", label: "Sessions", icon: "chat", shortcut: `${MOD}1` },
  { id: "flows", label: "Flows", icon: "board", shortcut: `${MOD}2` },
  { id: "reviews", label: "Reviews", icon: "checklist", shortcut: `${MOD}3` },
  { id: "review", label: "Pull requests", icon: "pr", shortcut: `${MOD}4` },
  { id: "issues", label: "Issues", icon: "circleDot", shortcut: `${MOD}5` },
  { id: "metaproject", label: "Metaproject", icon: "branch", shortcut: `${MOD}6` },
] as const;

/** The project tab a `MOD`+digit key opens: the digit is the tab's position in `PROJECT_VIEWS`. */
export function projectViewForKey(key: string): (typeof PROJECT_VIEWS)[number]["id"] | undefined {
  return /^[1-9]$/.test(key) ? PROJECT_VIEWS[Number(key) - 1]?.id : undefined;
}

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
  onProjectSettings?: () => void;
  title: ReactNode;
  /** Links shown beside the session title (its Subject and Flow). */
  titleLinks?: ReactNode;
  hasSession?: boolean;
  onOpenSourceIssue?: () => void;
  status: { tone: "ok" | "busy" | "warn" | "danger" | "idle"; label: string; detail?: string };
  flowsActive: number;
  reviewIndicator?: ReviewTabIndicator;
  reviewsIndicator?: ReviewsTabIndicator;
  /** The projects on the rail, in the user's order; `cwd` is one of them. */
  projects: string[];
  /** This window's project's live state. */
  activity: ProjectActivity;
  /** Every project running in a window of the app, this one and those in the background. */
  live: LiveProject[];
  onRemoveProject: (cwd: string) => void;
  onOpenFolder: () => void;
  onSwitchProject: (cwd: string) => void;
  onNewWindow: (cwd: string) => void;
  onCloseProject: () => void;
  onPalette: () => void;
  /** Title-bar controls before the palette button (the Project menu). */
  actions?: ReactNode;
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

/** The window's inner width, following resizes. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return width;
}

/** The session sidebar shows beside the chat in a window at least this wide (`useNarrow` in App). */
const SIDEBAR_WINDOW_MIN = 1000;

export function AppShell(p: ShellProps) {
  const overlay = useTitlebarInset();
  const prefs = usePrefs();
  const windowWidth = useWindowWidth();
  useSidePanelShortcuts(p.onPalette);
  const side = prefs.sidePanel !== null && p.view !== "settings";
  const sidebar = prefs.sessionSidebar && windowWidth >= SIDEBAR_WINDOW_MIN ? prefs.sessionSidebarWidth : 0;
  const sideWidth = fitSidePanelWidth(prefs.sidePanelWidth, windowWidth, sidebar);
  const reviewNotice = p.reviewIndicator === "attention" ? "Review or changes requested" :
    p.reviewIndicator === "watching" ? "PR watcher is on" : "";
  const reviewsNotice = p.reviewsIndicator === "attention" ? "Review waiting on you" : "";
  return (
    <div
      className={`app-shell${overlay ? " titlebar-overlay" : ""}${side ? " with-side" : ""}`}
      style={side ? ({ "--side-w": `${sideWidth}px` } as React.CSSProperties) : undefined}
    >
      <TitleBar {...p} />
      <Rail {...p} />
      <main className="app-main" id="main">
        {p.view !== "settings" && (
          <nav className="project-views" aria-label={`Project views for ${basename(p.cwd)}`}>
            {PROJECT_VIEWS.map(({ id, label, icon, shortcut }) => {
              const notice = id === "review" ? reviewNotice : id === "reviews" ? reviewsNotice : "";
              return <button key={id} aria-current={p.view === id ? "page" : undefined}
                title={`${label} (${shortcut})${notice ? " · " + notice : ""}`} onClick={() => p.onView(id)}>
                <Icon name={icon} size={15} />
                {label}
                {notice && <>
                  <span className={id === "reviews" ? "review-tab-dot reviews-tab-dot" : "review-tab-dot"}
                    data-indicator={id === "reviews" ? p.reviewsIndicator : p.reviewIndicator} aria-hidden="true" />
                  <span className="sr-only">, {notice}</span>
                </>}
                {id === "flows" && p.flowsActive > 0 && <span className="sr-only">, {p.flowsActive} active flows</span>}
              </button>;
            })}
          </nav>
        )}
        <div className="project-content">{p.children}</div>
      </main>
      <SidePanel cwd={p.cwd} visible={p.view !== "settings"} />
      <ConsentDialog />
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

function ActivityToggle() {
  const { sidePanel } = usePrefs();
  const running = useActivityRunning();
  const on = sidePanel === "activity";
  return <button type="button" className={`icon-btn titlebar-toggle titlebar-activity${on ? " is-on" : ""}`}
    onClick={() => toggleSidePanel("activity", sidePanel)} aria-pressed={on} aria-label="Activity"
    title={`${on ? "Hide" : "Show"} activity${running ? ` · ${running} running` : ""}`}>
    <Icon name="checklist" size={15} />
    {running > 0 && <span className="tab-count" aria-label={`${running} running`}>{running}</span>}
  </button>;
}

function TitleBar(p: ShellProps) {
  const { cwd, recents, title, status, onOpenFolder, onSwitchProject, onNewWindow, onCloseProject, onPalette } = p;
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const others = recents.filter((r) => r !== cwd).slice(0, 8);
  const items: MenuItem[] = [
    { kind: "header", id: "h-current", label: <span className="truncate" title={cwd}>{cwd}</span> },
    ...(p.onProjectSettings ? [{ id: "project-settings", label: "Project Settings", icon: "settings" as const, onSelect: p.onProjectSettings }] : []),
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
        <div className="titlebar-title" data-tauri-drag-region>{title}</div>
        {p.view === "session" && p.titleLinks}
        {p.view === "session" && <div className="titlebar-session-controls" ref={slotRef("sessionControls")} />}
      </div>
      <div className="titlebar-right" data-tauri-drag-region>
        {p.view === "session" && p.onOpenSourceIssue && <button className="icon-btn" aria-label="Open source issue"
          title="Open source issue" onClick={p.onOpenSourceIssue}><Icon name="circleDot" size={15} /></button>}
        <InfoToggle show={p.view === "session"} />
        {p.view === "session" && p.hasSession && <ActivityToggle />}
        <SideToggles />
        {p.actions}
        <button className="palette-btn" onClick={onPalette} aria-label="Commands and sessions" title="Commands and sessions">
          <Icon name="search" size={13} />
          <span>Commands</span>
          <Kbd>{MOD}K</Kbd>
        </button>
        <span className={`conn conn-${status.tone}`} title={status.detail ?? status.label} role="status">
          <span className="conn-dot" />
          {status.label}
        </span>
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
  running,
  onOpen,
  onMenu,
}: {
  path: string;
  current: boolean;
  active: boolean;
  activity: ProjectActivity;
  /** Kept running in the background. */
  running: boolean;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void;
}) {
  const name = basename(path);
  const state = ACTIVITY_LABEL[activity];
  const where = current ? " (open)" : running ? " (running in the background)" : "";
  const tip = `${name}${where}${state ? ` · ${state}` : ""}\n${path}`;
  return (
    <button
      className={`rail-project${active ? " is-active" : ""}${current ? " is-current" : ""}${running ? " is-running" : ""}`}
      style={{ "--project-hue": projectHue(path) } as React.CSSProperties}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.currentTarget);
      }}
      aria-current={current || undefined}
      aria-label={`${name}${state ? `, ${state}` : ""}`}
      title={tip}
    >
      <span className="rail-project-mark">{projectInitials(name)}</span>
      {activity !== "idle" ? <span className={`rail-dot rail-dot-${activity}`} aria-hidden /> : null}
    </button>
  );
}

function Rail(p: ShellProps) {
  const { view, onView, cwd, projects, activity, live, onSwitchProject, onOpenFolder, onNewWindow, onRemoveProject } = p;
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
    <nav className="rail" aria-label="Projects and settings">
      <div className="rail-projects" role="list" aria-label="Projects">
        {projects.map((path) => (
          <div role="listitem" key={path}>
            <ProjectButton
              path={path}
              current={path === cwd}
              active={path === cwd && view !== "settings"}
              activity={path === cwd ? activity : (live.find((l) => l.cwd === path)?.activity ?? "idle")}
              running={path !== cwd && live.some((l) => l.cwd === path)}
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
      <div className="grow" />
      <button className={`rail-btn${view === "settings" ? " is-active" : ""}`} onClick={() => onView("settings")}
        aria-current={view === "settings" ? "page" : undefined} title={`Settings (${MOD},)`}>
        <Icon name="settings" size={18} />
        <span className="rail-label">Settings</span>
      </button>
    </nav>
  );
}
