import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "./platform/backend";
import {
  acpStop,
  pickFolder,
  setFolderPrompter,
  setWindowTitle,
  settingsAddRecent,
  settingsGet,
  windowInitialCwd,
  windowOpenProject,
} from "./platform/commands";
import { applyTheme, setPrefs, MOD } from "./lib/prefs";
import { basename } from "./lib/format";
import { Dialog, overlayOpen } from "./components/ui";
import { AppShell, type View } from "./shell/AppShell";
import { CommandPalette, type PaletteItem } from "./shell/CommandPalette";
import { SettingsView } from "./shell/SettingsView";
import { Welcome } from "./shell/Welcome";
import { FlowsBoard } from "./flows/FlowsBoard";
import { laneOf, workPrompt } from "./flows/model";
import { useFlows } from "./flows/useFlows";
import { AskUserDialog, FatalDialog, PermissionDialog } from "./session/Approvals";
import type { ComposerHandle } from "./session/Composer";
import { SessionView } from "./session/SessionView";
import { useAcpSession } from "./session/useAcpSession";

export function App() {
  const [cwd, setCwd] = useState<string | null | undefined>(undefined);
  const [welcomeSettings, setWelcomeSettings] = useState(false);
  const [prompt, setPrompt] = useState<{ title: string; resolve: (v: string | null) => void } | null>(null);

  useEffect(() => {
    applyTheme();
    void windowInitialCwd()
      .then((c) => setCwd(c ?? null))
      .catch(() => setCwd(null));
    if (!isTauri()) setFolderPrompter((title) => new Promise((resolve) => setPrompt({ title, resolve })));
    return () => setFolderPrompter(null);
  }, []);

  useEffect(() => {
    if (cwd === null) void setWindowTitle("Keryx");
    if (cwd) void settingsAddRecent(cwd).catch(() => {});
    if (!isTauri() && cwd !== undefined) {
      const url = cwd ? `?cwd=${encodeURIComponent(cwd)}` : window.location.pathname;
      window.history.replaceState(null, "", url);
    }
  }, [cwd]);

  if (cwd === undefined) return null;
  return (
    <>
      {cwd ? (
        // Keyed by folder so switching folders gets a fresh keryx process.
        <ProjectWindow key={cwd} cwd={cwd} onOpenProject={setCwd} onCloseProject={() => setCwd(null)} />
      ) : welcomeSettings ? (
        <div className="standalone">
          <div className="welcome-drag" data-tauri-drag-region />
          <SettingsView onBack={() => setWelcomeSettings(false)} />
        </div>
      ) : (
        <Welcome onOpen={setCwd} onSettings={() => setWelcomeSettings(true)} />
      )}
      {prompt ? (
        <PathPrompt
          title={prompt.title}
          onDone={(v) => {
            prompt.resolve(v);
            setPrompt(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Browser dev mode has no native picker: ask for a path. */
function PathPrompt({ title, onDone }: { title: string; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog
      title={title}
      icon="folderOpen"
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={() => onDone(value.trim())}>
            Open
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Absolute path</span>
        <input
          className="mono"
          data-autofocus
          placeholder="/Users/you/project"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onDone(value.trim())}
        />
        <span className="field-hint">Browser dev mode has no folder picker. The bridge opens this path on your machine.</span>
      </label>
    </Dialog>
  );
}

function useNarrow(px: number): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < px);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return narrow;
}

type Status = { tone: "ok" | "busy" | "warn" | "danger" | "idle"; label: string; detail?: string };

function ProjectWindow({ cwd, onOpenProject, onCloseProject }: { cwd: string; onOpenProject: (cwd: string) => void; onCloseProject: () => void }) {
  const s = useAcpSession(cwd);
  const flows = useFlows(cwd);
  const [view, setView] = useState<View>("session");
  const [palette, setPalette] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const paletteOpen = useRef(false);
  paletteOpen.current = palette !== null;
  const narrow = useNarrow(1000);
  const { state } = s;

  useEffect(() => {
    void settingsGet()
      .then((st) => setRecents(st.recentProjects))
      .catch(() => {});
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    if (v === "session") requestAnimationFrame(() => composer.current?.focus());
  }, []);

  const openFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (picked) onOpenProject(picked);
  }, [onOpenProject]);

  /** Prefill the composer; never sends. */
  const fillComposer = useCallback((text: string) => {
    setView("session");
    requestAnimationFrame(() => composer.current?.setText(text));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // While any dialog or overlay is up (an approval above all) the shortcuts stand down;
      // only the palette itself may be toggled closed again.
      if (overlayOpen()) {
        if (k === "k" && paletteOpen.current) {
          e.preventDefault();
          setPalette(null);
        }
        return;
      }
      if (k === "k") {
        e.preventDefault();
        setPalette("");
      } else if (k === "1") {
        e.preventDefault();
        go("session");
      } else if (k === "2") {
        e.preventDefault();
        go("flows");
      } else if (k === ",") {
        e.preventDefault();
        go("settings");
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        if (state.phase === "ready") {
          go("session");
          void s.newSession();
        }
      } else if (k === "o") {
        e.preventDefault();
        void openFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, openFolder, s, state.phase]);

  const flowsActive = useMemo(() => flows.cards.filter((c) => laneOf(c) !== "done").length, [flows.cards]);

  const status = useMemo<Status>(() => {
    if (state.phase === "starting") return { tone: "idle", label: "Starting" };
    if (state.phase === "exited") return { tone: "danger", label: "Stopped", detail: "keryx is not running" };
    if (s.fatal?.kind === "incompatible" || s.fatal?.kind === "noShell") return { tone: "warn", label: "Incompatible" };
    if (state.busy) return { tone: "busy", label: "Working" };
    return { tone: "ok", label: "Ready", detail: state.agentVersion ? `keryx ${state.agentVersion} · ${state.profile} profile` : undefined };
  }, [state.phase, state.busy, state.agentVersion, state.profile, s.fatal]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { id: "v-session", group: "Go to", label: "Session", icon: "chat", hint: `${MOD}1`, run: () => go("session") },
      { id: "v-flows", group: "Go to", label: "Flows", icon: "board", hint: `${MOD}2`, run: () => go("flows") },
      { id: "v-settings", group: "Go to", label: "Settings", icon: "settings", hint: `${MOD},`, run: () => go("settings") },
      {
        id: "a-new",
        group: "Session",
        label: "New session",
        icon: "plus",
        hint: `${MOD}N`,
        run: () => {
          go("session");
          void s.newSession();
        },
      },
    ];
    if (state.busy) items.push({ id: "a-stop", group: "Session", label: "Stop the current turn", icon: "stop", run: s.cancel });
    if (state.phase === "exited") items.push({ id: "a-restart", group: "Session", label: "Restart keryx", icon: "refresh", run: s.restart });
    for (const m of state.modes?.availableModes ?? []) {
      if (m.id === state.modes?.currentModeId) continue;
      items.push({
        id: `m-${m.id}`,
        group: "Session",
        label: `Switch to ${m.name} mode`,
        detail: m.description ?? undefined,
        icon: "shield",
        run: () => void s.setMode(m.id),
      });
    }
    for (const c of state.commands) {
      items.push({ id: `c-${c.name}`, group: "Slash commands", label: `/${c.name}`, detail: c.description, icon: "command", run: () => fillComposer(`/${c.name} `) });
    }
    for (const ses of state.sessions.slice(0, 30)) {
      if (ses.sessionId === state.sessionId) continue;
      items.push({
        id: `s-${ses.sessionId}`,
        group: "Open session",
        label: ses.title?.trim() || "Untitled session",
        icon: "history",
        run: () => {
          go("session");
          void s.loadSession(ses.sessionId);
        },
      });
    }
    items.push({ id: "p-open", group: "Projects", label: "Open Folder…", icon: "folderOpen", hint: `${MOD}O`, run: () => void openFolder() });
    for (const r of recents) {
      if (r === cwd) continue;
      items.push({ id: `p-${r}`, group: "Projects", label: basename(r), detail: r, icon: "folder", run: () => onOpenProject(r) });
    }
    items.push(
      { id: "t-system", group: "Appearance", label: "Theme: System", icon: "sun", run: () => setPrefs({ theme: "system" }) },
      { id: "t-light", group: "Appearance", label: "Theme: Light", icon: "sun", run: () => setPrefs({ theme: "light" }) },
      { id: "t-dark", group: "Appearance", label: "Theme: Dark", icon: "moon", run: () => setPrefs({ theme: "dark" }) },
    );
    return items;
  }, [go, s, state.busy, state.phase, state.modes, state.commands, state.sessions, state.sessionId, recents, cwd, openFolder, onOpenProject, fillComposer]);

  // The title bar names the project and the view; the page below keeps only its own toolbar.
  const title =
    view === "session" ? (
      <span className="truncate">{state.title?.trim() || "New session"}</span>
    ) : (
      <span className="truncate">
        {basename(cwd)} · {view === "flows" ? "Flows" : "Settings"}
      </span>
    );

  const topPermission = s.permissions[0];
  const topAsk = s.asks[0];

  return (
    <AppShell
      cwd={cwd}
      recents={recents}
      view={view}
      onView={go}
      title={title}
      status={status}
      flowsActive={flowsActive}
      onOpenFolder={() => void openFolder()}
      onSwitchProject={onOpenProject}
      onNewWindow={(p) => void windowOpenProject(p)}
      onCloseProject={onCloseProject}
      onPalette={() => setPalette("")}
    >
      {/* The session view stays mounted so the transcript and draft survive view switches. */}
      <div className="view" hidden={view !== "session"}>
        <SessionView ref={composer} s={s} projectName={basename(cwd)} onGoFlows={() => go("flows")} narrow={narrow} />
      </div>
      {view === "flows" ? (
        <div className="view">
          <FlowsBoard cwd={cwd} flows={flows} onWorkOn={(c) => fillComposer(workPrompt(c))} />
        </div>
      ) : null}
      {view === "settings" ? (
        <div className="view">
          <SettingsView agentVersion={state.agentVersion} />
        </div>
      ) : null}

      {palette !== null ? <CommandPalette items={paletteItems} initialQuery={palette} onClose={() => setPalette(null)} /> : null}

      {s.fatal ? (
        <FatalDialog
          fatal={s.fatal}
          agentVersion={state.agentVersion}
          onContinue={s.continueAnyway}
          onNewSession={() => void s.newSession()}
          onDismiss={s.dismissFatal}
          onSettings={() => {
            s.dismissFatal();
            go("settings");
          }}
          onClose={() => {
            void acpStop();
            onCloseProject();
          }}
        />
      ) : null}
      {!s.fatal && topPermission ? (
        <PermissionDialog
          key={topPermission.id}
          pending={topPermission}
          modeId={state.modes?.currentModeId ?? null}
          queued={s.permissions.length - 1}
          onAnswer={s.answerPermission}
        />
      ) : null}
      {!s.fatal && !topPermission && topAsk ? <AskUserDialog key={topAsk.id} pending={topAsk} onAnswer={s.answerAsk} /> : null}
    </AppShell>
  );
}
