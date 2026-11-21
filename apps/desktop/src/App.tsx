import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DeskRun, DeskRunKey } from "../../../src/review/desk-run-types";
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
import { basename, errMessage } from "./lib/format";
import { Dialog, EmptyState, overlayOpen, Spinner } from "./components/ui";
import { AppShell, PROJECT_VIEWS, type View } from "./shell/AppShell";
import { CommandPalette, type PaletteItem } from "./shell/CommandPalette";
import { SettingsView, type SettingsTab } from "./shell/SettingsView";
import { Welcome } from "./shell/Welcome";
import { UpdateBanner } from "./shell/UpdateBanner";
import { ReviewBoard, type ReviewTabIndicator } from "./review/ReviewBoard";
import { ReviewLaunchDialog } from "./review/ReviewLaunchDialog";
import { SessionReviewActivity } from "./review/SessionReviewActivity";
import { loadSessionReviewTargets, readSessionReviewLinks, rememberSessionReview, reviewFlowId, reviewSessionTitle, type ReviewComposerTarget, type SessionReviewLink } from "./review/sessionReview";
import { publishSessionReview, reviewRun } from "./platform/reviewRuns";
import { modelChoices, providerOf } from "./session/Composer";
import { FlowsBoard } from "./flows/FlowsBoard";
import type { LinkedSession } from "./flows/FlowDetail";
import { sessionFlags } from "./acp/types";
import type { FlowCard } from "./platform/commands";
import { laneOf, workPrompt } from "./flows/model";
import { useFlows } from "./flows/useFlows";
import { AskUserDialog, FatalDialog, PermissionDialog } from "./session/Approvals";
import type { ComposerHandle } from "./session/Composer";
import { ProvidersDialog, useProvidersDialog, type ProvidersApi } from "./session/ProvidersDialog";
import { SessionView } from "./session/SessionView";
import { modelOption, useAcpSession } from "./session/useAcpSession";
import { ProjectMenu } from "./project/ProjectMenu";
import { ProjectSetupDialog } from "./project/ProjectSetupDialog";
import { ProjectNotifications } from "./project/ProjectNotifications";
import { useProjectDiagnostics, type ProjectNotice } from "./platform/projectDiagnostics";
import { inspectProjectSetup, shouldOfferProjectSetup, type SetupInspection, type SetupResult } from "./platform/projectSetup";
import { GitHubIntegrations, ProjectGitHubSettings } from "./project/GitHubSettings";
import { getProjectGitHubAccount, type ProjectGitHubAccount } from "./platform/githubAccounts";
import { PROJECT_COMMANDS } from "./project/projectCommands";
import { useProjectRunner } from "./project/useProjectRunner";
import { providersLister, WikiEnrichDialog } from "./project/WikiEnrichDialog";
import { supportsProviders } from "./acp/providers";
import { onProjectsState, onProjectSetupRequest, projectRegister, projectsState, projectSwitch, reportProjectActivity, takeProjectSetupRequest, type LiveProject } from "./platform/projects";
import { projectActivity, railProjects, removeRailProject, syncRailProjects } from "./shell/projectRail";

export function App() {
  const [cwd, setCwd] = useState<string | null | undefined>(undefined);
  const [welcomeSettings, setWelcomeSettings] = useState<SettingsTab | null>(null);
  const [setupFinding, setSetupFinding] = useState<string>();
  const [desktopSettingsRequest, setDesktopSettingsRequest] = useState(0);
  const diagnostics = useProjectDiagnostics(cwd);
  const scan = diagnostics.scan;
  const refreshDiagnostics = useCallback(() => { void scan("afterApply"); }, [scan]);
  const [prompt, setPrompt] = useState<{ title: string; resolve: (v: string | null) => void } | null>(null);

  useEffect(() => {
    applyTheme();
    void windowInitialCwd()
      .then(async (c) => {
        if (c) {
          const finding = await takeProjectSetupRequest().catch(() => null);
          if (finding) setSetupFinding(finding);
        }
        setCwd(c ?? null);
      })
      .catch(() => setCwd(null));
    if (!isTauri()) setFolderPrompter((title) => new Promise((resolve) => setPrompt({ title, resolve })));
    return () => setFolderPrompter(null);
  }, []);

  useEffect(() => {
    if (cwd === null) void setWindowTitle("Keryx");
    if (cwd) void settingsAddRecent(cwd).catch(() => {});
    if (cwd === null) void projectRegister(null).catch(() => {});
    if (!isTauri() && cwd !== undefined) {
      const url = cwd ? `?cwd=${encodeURIComponent(cwd)}` : window.location.pathname;
      window.history.replaceState(null, "", url);
    }
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    let active = true;
    let off: (() => void) | undefined;
    void onProjectSetupRequest((finding) => { if (active) setSetupFinding(finding); }).then((stop) => {
      if (active) off = stop;
      else stop();
    }).catch(() => {});
    return () => { active = false; off?.(); };
  }, [cwd]);

  const openNotice = async (notice: ProjectNotice) => {
    if (notice.target === "desktop") {
      if (cwd) setDesktopSettingsRequest((n) => n + 1);
      else setWelcomeSettings("desktop");
    } else if (notice.target === "setup") {
      await projectSwitch(notice.cwd, notice.finding);
    }
  };
  const notifications = isTauri() ? <ProjectNotifications diagnostics={diagnostics} onOpen={openNotice} /> : undefined;

  if (cwd === undefined) return null;
  return (
    <>
      {cwd ? (
        // Keyed by folder so switching folders gets a fresh keryx process.
        <ProjectOpening key={cwd} cwd={cwd} onOpenProject={setCwd} onCloseProject={() => { setSetupFinding(undefined); setDesktopSettingsRequest(0); setCwd(null); }}
          notifications={notifications} setupFinding={setupFinding} clearSetupFinding={() => setSetupFinding(undefined)}
          desktopSettingsRequest={desktopSettingsRequest} refreshDiagnostics={refreshDiagnostics} />
      ) : welcomeSettings ? (
        <div className="standalone">
          <div className="welcome-drag" data-tauri-drag-region />
          <SettingsView key={welcomeSettings} initialTab={welcomeSettings} onBack={() => setWelcomeSettings(null)} integrations={<GitHubIntegrations />} />
        </div>
      ) : (
        <Welcome onOpen={async (folder) => {
          if (isTauri()) await projectSwitch(folder);
          else setCwd(folder);
        }} onSettings={() => setWelcomeSettings("appearance")} />
      )}
      {!cwd && notifications ? <div className="welcome-notifications">{notifications}</div> : null}
      <UpdateBanner />
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

interface ProjectWindowProps {
  cwd: string;
  onOpenProject: (cwd: string) => void;
  onCloseProject: () => void;
  notifications?: ReactNode;
  setupFinding?: string;
  clearSetupFinding: () => void;
  desktopSettingsRequest: number;
  refreshDiagnostics: () => void;
}

function ProjectOpening(props: ProjectWindowProps) {
  const { cwd } = props;
  const [opening, setOpening] = useState<
    { phase: "checking" | "ready" } | { phase: "offer"; inspection: SetupInspection | null; error: string }
  >(() => ({ phase: isTauri() ? "checking" : "ready" }));
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void projectRegister(cwd).then(() => inspectProjectSetup(cwd)).then((inspection) => {
      if (!active) return;
      setOpening((current) => current.phase !== "checking" ? current : shouldOfferProjectSetup(inspection)
        ? { phase: "offer", inspection, error: "" }
        : { phase: "ready" });
    }).catch((failure: unknown) => {
      if (active) setOpening((current) => current.phase === "checking"
        ? { phase: "offer", inspection: null, error: errMessage(failure) } : current);
    });
    return () => { active = false; };
  }, [cwd]);

  if (opening.phase === "ready") return <ProjectWindow {...props} />;
  const open = () => { props.clearSetupFinding(); setOpening({ phase: "ready" }); };
  return (
    <div className="standalone">
      <div className="welcome-drag" data-tauri-drag-region />
      {opening.phase === "offer" ? (
        <ProjectSetupDialog cwd={cwd} opening finding={props.setupFinding} initialInspection={opening.inspection} initialError={opening.error}
          onResult={props.refreshDiagnostics} onClose={open} />
      ) : (
        <Dialog title="Checking Metaproject" icon="settings" onClose={open} focusRoot
          footer={<button className="btn" onClick={open}>Open without setup</button>}>
          <div className="loading-row" role="status"><Spinner /> Checking {basename(cwd)}…</div>
        </Dialog>
      )}
    </div>
  );
}

function ProjectWindow({ cwd, onOpenProject, onCloseProject, notifications, setupFinding, clearSetupFinding, desktopSettingsRequest, refreshDiagnostics }: ProjectWindowProps) {
  const s = useAcpSession(cwd);
  const flows = useFlows(cwd);
  const providers = useProvidersDialog();
  const providersApi = useMemo<ProvidersApi>(() => ({ request: s.rpc, extensions: s.extensions, onChallenge: s.onLoginChallenge }), [s.rpc, s.extensions, s.onLoginChallenge]);
  const [view, setView] = useState<View>("session");
  const settingsReturn = useRef<Exclude<View, "settings">>("session");
  const settingsFocus = useRef<HTMLElement | null>(null);
  const settingsProjectReturn = useRef(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [githubAccount, setGitHubAccount] = useState<ProjectGitHubAccount | null>(null);
  const reviewViewer = githubAccount?.login ?? undefined;
  const [reviewNotice, setReviewNotice] = useState<{ binding?: string; viewer?: string; indicator: ReviewTabIndicator }>();
  const updateReviewNotice = useCallback((indicator: ReviewTabIndicator, viewer?: string) => {
    setReviewNotice({ binding: reviewViewer, viewer, indicator });
  }, [reviewViewer]);
  const [githubAccountError, setGitHubAccountError] = useState("");
  const [projectSettings, setProjectSettings] = useState(false);
  const [localSetupOpen, setSetupOpen] = useState(false);
  const setupOpen = localSetupOpen || !!setupFinding;
  const openSetup = useCallback(() => setSetupOpen(true), []);
  const closeSetup = () => { setSetupOpen(false); clearSetupFinding(); };
  const refreshConfiguredProject = useCallback((result: SetupResult) => {
    refreshDiagnostics();
    if (result.steps.some((step) => step.status === "completed" && ["init", "configure", "update"].includes(step.id))) {
      void flows.refresh();
    }
  }, [flows.refresh, refreshDiagnostics]);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const accountRevision = useRef(0);
  const registration = useRef<Promise<void> | null>(null);
  const [linkedFlow, setLinkedFlow] = useState<string | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [enrich, setEnrich] = useState(false);
  const runProject = useProjectRunner(cwd, s.keryxPath);
  const listProviders = useMemo(() => (supportsProviders(s.extensions) ? providersLister(s.rpc) : null), [s.extensions, s.rpc]);
  const [recents, setRecents] = useState<string[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const paletteOpen = useRef(false);
  paletteOpen.current = palette !== null;
  const narrow = useNarrow(1000);
  const { state } = s;

  const refreshGitHubAccount = useCallback(async () => {
    const revision = ++accountRevision.current;
    try {
      registration.current ??= projectRegister(cwd).catch((failure: unknown) => {
        registration.current = null;
        throw failure;
      });
      await registration.current;
      const account = await getProjectGitHubAccount(cwd);
      if (revision !== accountRevision.current) return;
      setGitHubAccount(account);
      setGitHubAccountError("");
    } catch (failure) {
      if (revision === accountRevision.current) setGitHubAccountError(errMessage(failure));
    }
  }, [cwd]);

  useEffect(() => {
    const refresh = () => void refreshGitHubAccount();
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      accountRevision.current += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [refreshGitHubAccount]);

  const [projects, setProjects] = useState<string[]>(() => railProjects(cwd, []));
  useEffect(() => {
    void settingsGet()
      .then((st) => {
        setRecents(st.recentProjects);
        setProjects(syncRailProjects(cwd, st.recentProjects));
      })
      .catch(() => setProjects(syncRailProjects(cwd, [])));
  }, [cwd]);
  const removeProject = useCallback((p: string) => setProjects(removeRailProject(p)), []);
  const activity = useMemo(() => projectActivity(s.marks), [s.marks]);

  /** Every project running in a window of this app (this one and those in the background). */
  const [live, setLive] = useState<LiveProject[]>([]);
  useEffect(() => {
    void reportProjectActivity(activity).catch(() => {});
  }, [activity]);
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    const take = (list: LiveProject[]) => {
      setLive(list);
      // Another window may have put a project on the rail.
      setProjects(syncRailProjects(cwd, []));
    };
    void projectsState().then(take).catch(() => {});
    void onProjectsState(take).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [cwd]);

  /** Switch to another project; the one we leave keeps running in its own (hidden) window. */
  const switchProject = useCallback(
    (p: string) => {
      if (p === cwd) return;
      void projectSwitch(p)
        .then((done) => {
          if (!done) onOpenProject(p);
        })
        .catch((e: unknown) => s.notify("error", `Could not open ${basename(p)}: ${e instanceof Error ? e.message : String(e)}`));
    },
    [cwd, onOpenProject, s],
  );

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    if (view !== "settings") {
      settingsReturn.current = view;
      settingsFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setSettingsTab(tab);
    setView("settings");
  }, [view]);

  const handledDesktopSettings = useRef(0);
  useEffect(() => {
    if (desktopSettingsRequest <= handledDesktopSettings.current) return;
    handledDesktopSettings.current = desktopSettingsRequest;
    openSettings("desktop");
  }, [desktopSettingsRequest, openSettings]);

  const closeSettings = useCallback(() => {
    setView(settingsReturn.current);
    if (settingsProjectReturn.current) {
      settingsProjectReturn.current = false;
      setProjectSettings(true);
      return;
    }
    requestAnimationFrame(() => {
      if (settingsFocus.current?.isConnected) settingsFocus.current.focus();
      else if (settingsReturn.current === "session") composer.current?.focus();
    });
  }, []);

  const openProjectSettings = useCallback(() => {
    setProjectSettings(true);
    void refreshGitHubAccount();
  }, [refreshGitHubAccount]);

  const go = useCallback((v: View) => {
    if (v === "settings") {
      openSettings();
      return;
    }
    setLinkedFlow(null);
    setView(v);
    if (v === "session") requestAnimationFrame(() => composer.current?.focus());
  }, [openSettings]);

  const openFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (picked) switchProject(picked);
  }, [switchProject]);

  /** Prefill the composer; never sends. */
  const fillComposer = useCallback((text: string) => {
    setView("session");
    requestAnimationFrame(() => composer.current?.setText(text));
  }, []);

  /** Sessions linked to a flow package (their `_meta.keryx.flow`), newest first. */
  const linkedSessions = useCallback(
    (dir: string): LinkedSession[] =>
      state.sessions
        .filter((x) => sessionFlags(x).flow === dir && sessionFlags(x).archivedAt === undefined)
        .map((x) => ({ id: x.sessionId, title: x.title?.trim() || "Untitled session", updatedAt: x.updatedAt ?? null })),
    [state.sessions],
  );

  /** Work on a flow: a new session linked to it gets the work prompt; a linked one is just shown. */
  const workOn = useCallback(
    async (card: FlowCard, target: "new" | string) => {
      setView("session");
      const id = await s.workOnFlow(card.dir, target);
      if (id && target === "new") fillComposer(workPrompt(card));
    },
    [s, fillComposer],
  );

  const openSessionWith = useCallback(async (reference: string, flow?: FlowCard) => {
    const id = flow ? await s.workOnFlow(flow.dir, "new") : await s.newSession();
    if (id) fillComposer(reference);
  }, [s, fillComposer]);

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
      } else if (k === "3") {
        e.preventDefault();
        go("review");
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
    if (s.fatal?.kind === "incompatible" || s.fatal?.kind === "noShell") {
      return { tone: "warn", label: "Incompatible", detail: "This keryx cannot run the app. Restart it or choose another keryx in Settings." };
    }
    if (state.phase === "starting") return { tone: "idle", label: "Starting" };
    if (state.phase === "exited") return { tone: "danger", label: "Stopped", detail: "keryx is not running" };
    if (state.busy) return { tone: "busy", label: "Working" };
    return { tone: "ok", label: "Ready", detail: state.agentVersion ? `keryx ${state.agentVersion} · ${state.profile} profile` : undefined };
  }, [state.phase, state.busy, state.agentVersion, state.profile, s.fatal]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      ...PROJECT_VIEWS.map(({ id, label, icon, shortcut }) => ({
        id: `v-${id}`, group: basename(cwd), label: `Go to ${label}`, icon, hint: shortcut, run: () => go(id),
      })),
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
    for (const c of PROJECT_COMMANDS) {
      items.push({ id: `k-${c.id}`, group: "Run", label: `keryx ${c.args.join(" ")}`, detail: c.description, icon: "play", run: () => void runProject(c.args, `keryx ${c.args.join(" ")}`) });
    }
    items.push({ id: "k-project-setup", group: "Project", label: "Set up Metaproject…", icon: "settings", run: openSetup });
    items.push({ id: "k-wiki-enrich", group: "Run", label: "keryx wiki enrich…", detail: "Fill draft pages with a model: one job or waves", icon: "wand", run: () => setEnrich(true) });
    items.push({ id: "p-open", group: "Projects", label: "Open Folder…", icon: "folderOpen", hint: `${MOD}O`, run: () => void openFolder() });
    for (const r of recents) {
      if (r === cwd) continue;
      items.push({ id: `p-${r}`, group: "Projects", label: basename(r), detail: r, icon: "folder", run: () => switchProject(r) });
    }
    items.push(
      { id: "t-system", group: "Appearance", label: "Theme: System", icon: "sun", run: () => setPrefs({ theme: "system" }) },
      { id: "t-light", group: "Appearance", label: "Theme: Light", icon: "sun", run: () => setPrefs({ theme: "light" }) },
      { id: "t-dark", group: "Appearance", label: "Theme: Dark", icon: "moon", run: () => setPrefs({ theme: "dark" }) },
    );
    return items;
  }, [go, s, state.busy, state.phase, state.modes, state.commands, state.sessions, state.sessionId, recents, cwd, openFolder, switchProject, fillComposer, runProject, openSetup]);

  const topPermission = s.permissions[0];
  const topAsk = s.asks[0];
  const workView = view === "settings" ? settingsReturn.current : view;
  const offerGitHub = githubAccount?.eligible && !githubAccount.configured && !onboardingDismissed
    && view !== "settings" && !s.fatal && !topAsk && !topPermission && !providers.request && !enrich && !setupOpen && palette === null;
  const reviewDisconnected = githubAccount?.configured && !githubAccount.login;

  const currentNotice = !reviewDisconnected && reviewNotice?.binding === reviewViewer ? reviewNotice : undefined;
  const [reviewComposer, setReviewComposer] = useState<ReviewComposerTarget>();
  const [reviewLinks, setReviewLinks] = useState(() => readSessionReviewLinks(cwd));
  const linkReviewContinuation = useCallback((link: SessionReviewLink) => {
    setReviewLinks(rememberSessionReview(cwd, link));
  }, [cwd]);
  const openReviewWorkspace = useCallback(async (key: DeskRunKey, run: DeskRun) => {
    const prior = readSessionReviewLinks(cwd).find(link => link.id === run.id && link.key.repositoryId === key.repositoryId &&
      link.key.viewer.toLowerCase() === key.viewer.toLowerCase() && state.sessions.some(session =>
        session.sessionId === link.sessionId && !sessionFlags(session).archivedAt));
    const id = prior ? prior.sessionId : await s.newSession();
    if (!id) throw new Error("Could not create the review session.");
    if (prior) await s.loadSession(id);
    else setReviewLinks(rememberSessionReview(cwd, {
      id: run.id, sessionId: id, key, revision: { baseSha: run.baseSha, headSha: run.headSha },
      prompt: `Review https://github.com/${key.repo}/pull/${key.number}`,
    }));
    setView("session");
  }, [cwd, s, state.sessions]);
  const draftReview = s.reviewDraftRequest;
  const sessionFlow = state.sessions.find(session => session.sessionId === state.sessionId);
  const flowId = reviewFlowId(flows.cards, sessionFlow && sessionFlags(sessionFlow).flow, draftReview?.flowId);
  const viewer = reviewViewer ?? currentNotice?.viewer;
  const sessionReviews = useMemo(() => reviewLinks.filter(link => link.sessionId === state.sessionId &&
    (!viewer || viewer.toLowerCase() === link.key.viewer.toLowerCase())), [reviewLinks, state.sessionId, viewer]);
  const sessionTitle = reviewSessionTitle(state.title?.trim(), sessionReviews.at(-1)) || "New session";
  // The title bar names the project and the view; the page below keeps only its own toolbar.
  const title =
    view === "session" ? (
      <span className="truncate">{sessionTitle}</span>
    ) : (
      <span className="truncate">
        {view === "settings" ? "Settings" : `${basename(cwd)} · ${view === "flows" ? "Flows" : "Pull requests"}`}
      </span>
    );

  useEffect(() => { void setWindowTitle(`${sessionTitle} — ${basename(cwd)}`); }, [sessionTitle, cwd]);
  const loadReviewTargets = useCallback((hint?: string, signal?: AbortSignal) => {
    if (reviewDisconnected) return Promise.reject(new Error("Choose the project's GitHub account in Project Settings."));
    return loadSessionReviewTargets(cwd, reviewViewer, hint, signal);
  }, [cwd, reviewViewer, reviewDisconnected]);
  const sessionModel = modelOption(state.configOptions);
  const reviewModels = useMemo(() => modelChoices(sessionModel).flatMap(option => {
    const provider = providerOf(option);
    const model = provider ? option.value.slice(provider.length + 1) : "";
    return provider && model ? [{ provider, model, label: option.name }] : [];
  }), [sessionModel]);
  const currentReviewModel = reviewModels.find(choice => `${choice.provider}/${choice.model}` === sessionModel?.currentValue);

  return (
    <AppShell
      cwd={cwd}
      recents={recents}
      view={view}
      onView={go}
      onProjectSettings={openProjectSettings}
      onProjectSetup={openSetup}
      notifications={notifications}
      title={view === "session" ? <span className="truncate">{sessionTitle}</span> : title}
      hasSession={state.sessionId !== null}
      status={status}
      flowsActive={flowsActive}
      reviewIndicator={currentNotice?.indicator}
      projects={projects}
      activity={activity}
      live={live}
      onRemoveProject={removeProject}
      onOpenFolder={() => void openFolder()}
      onSwitchProject={switchProject}
      onNewWindow={(p) => void windowOpenProject(p)}
      onCloseProject={onCloseProject}
      onPalette={() => { if (!setupOpen) setPalette(""); }}
      actions={<ProjectMenu run={runProject} onSetup={openSetup} onEnrich={() => setEnrich(true)} />}
    >
      {/* The session view stays mounted so the transcript and draft survive view switches. */}
      <div className="view" hidden={view !== "session"}>
        <SessionView ref={composer} s={s} cwd={cwd} projectName={basename(cwd)} onGoFlows={() => go("flows")} onGoSettings={() => go("settings")} narrow={narrow} onProviders={providers.openProviders}
          reviewLinks={reviewLinks} reviewComposer={reviewDisconnected ? undefined : reviewComposer}
          reviewActivity={!reviewDisconnected && sessionReviews.length ? <SessionReviewActivity cwd={cwd} links={sessionReviews} visible={view === "session"}
            onComposerTarget={setReviewComposer} focusComposer={() => composer.current?.focus()}
            onContinuation={linkReviewContinuation} /> : undefined}
          githubAccount={githubAccount?.eligible ? githubAccount : undefined} onProjectSettings={openProjectSettings} />
      </div>
      {workView === "flows" ? (
        <div className="view" hidden={view !== "flows"}>
          <FlowsBoard initialOpenDir={linkedFlow} cwd={cwd} flows={flows} linkedSessions={linkedSessions} onOpenSession={(card) => void openSessionWith(card.prUrl ?? `.metaproject/flows/${card.dir}`, card)} onWorkOn={(c, target) => void workOn(c, target)} />
        </div>
      ) : null}
      <div className="view" hidden={view !== "review"}>
        {reviewDisconnected ? (
          <EmptyState title="GitHub is not connected" icon="pr">
            <button className="btn" onClick={openProjectSettings}>Choose an account</button>
          </EmptyState>
        ) : (
          <ReviewBoard key={reviewViewer ?? "active-gh"} expectedViewer={reviewViewer} onIndicatorChange={updateReviewNotice} active={workView === "review"} cwd={cwd} flows={flows.cards} reviewModels={reviewModels} currentRepairModel={currentReviewModel} onOpenReviewSession={openReviewWorkspace} onOpenSession={(card) => void openSessionWith(card.url, flows.cards.find(flow =>
              flow.prUrl?.replace(/\/$/, "").toLowerCase() === card.url.toLowerCase()))} onOpenFlow={(dir) => {
            setLinkedFlow(dir);
            setView("flows");
          }} />
        )}
      </div>
      {view === "settings" ? (
        <div className="view">
          <SettingsView key={desktopSettingsRequest} agentVersion={state.agentVersion} onBack={closeSettings} initialTab={settingsTab} integrations={<GitHubIntegrations />} />
        </div>
      ) : null}

      {view === "session" && draftReview && !topPermission && !topAsk && !providers.request && !projectSettings && !offerGitHub && !setupOpen &&
        <ReviewLaunchDialog key={JSON.stringify([draftReview.nonce, reviewViewer])} flows={flows.cards} defaultFlow={flowId}
          initialTarget={draftReview.target} models={reviewModels} loadTargets={loadReviewTargets}
          onApply={async (key, revision, options) => {
            const result = await reviewRun(cwd, key, { kind: "start", ...revision, options });
            const id = result.startedRunId;
            if (!id || !result.runs.some(run => run.id === id)) throw new Error("The selected Keryx CLI did not confirm the new review attempt.");
            setReviewLinks(rememberSessionReview(cwd, { id, sessionId: draftReview.sessionId, key, revision,
              ...(draftReview.prompt && { prompt: draftReview.prompt }) }));
            publishSessionReview(cwd, key, result);
          }}
          onClose={() => s.dismissReviewDraftRequest(draftReview.nonce)} />}

      {!setupOpen && (projectSettings || offerGitHub) ? (
        <ProjectGitHubSettings cwd={cwd} account={githubAccount} accountError={githubAccountError} onRetryAccount={() => void refreshGitHubAccount()}
          onboarding={!projectSettings}
          onSetup={openSetup}
          onSaved={(account) => {
            accountRevision.current += 1;
            setGitHubAccount(account);
            setGitHubAccountError("");
            setProjectSettings(false);
          }}
          onClose={() => {
            setOnboardingDismissed(true);
            setProjectSettings(false);
          }}
          onIntegrations={() => {
            settingsProjectReturn.current = projectSettings;
            setProjectSettings(false);
            openSettings("integrations");
          }} />
      ) : null}

      {setupOpen ? <ProjectSetupDialog cwd={cwd} finding={setupFinding} onClose={closeSetup} onResult={refreshConfiguredProject} /> : null}
      {!setupOpen && providers.request ? <ProvidersDialog request={providers.request} api={providersApi} onClose={providers.close} /> : null}
      {enrich ? <WikiEnrichDialog listProviders={listProviders} onRun={(args, title) => void runProject(args, title)} onClose={() => setEnrich(false)} /> : null}
      {palette !== null ? <CommandPalette items={paletteItems} initialQuery={palette} onClose={() => setPalette(null)} /> : null}

      {!setupOpen && s.fatal && !(s.fatalHidden && (s.fatal.kind === "incompatible" || s.fatal.kind === "noShell")) ? (
        <FatalDialog
          fatal={s.fatal}
          agentVersion={state.agentVersion}
          onContinue={s.continueAnyway}
          onNewSession={() => void s.newSession()}
          onDismiss={s.dismissFatal}
          onSettings={() => {
            // The failure stays on the window (banner, status); only the dialog gives way to Settings.
            s.hideFatal();
            go("settings");
          }}
          onClose={() => {
            void acpStop();
            onCloseProject();
          }}
        />
      ) : null}
      {!setupOpen && !s.fatal && topPermission ? (
        <PermissionDialog
          key={topPermission.id}
          pending={topPermission}
          modeId={state.modes?.currentModeId ?? null}
          queued={s.permissions.length - 1}
          onAnswer={s.answerPermission}
        />
      ) : null}
      {!setupOpen && !s.fatal && !topPermission && topAsk ? <AskUserDialog key={topAsk.id} pending={topAsk} onAnswer={s.answerAsk} /> : null}
    </AppShell>
  );
}
