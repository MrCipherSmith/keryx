import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { DeskRevision, DeskRun, DeskRunKey } from "../../../src/review/desk-run-types";
import { SESSION_REVIEW_REQUEST_LIMIT, SESSION_REVIEW_REQUEST_METHOD, SESSION_REVIEWS_METHOD, type SessionReviewSummary } from "../../../src/acp/session-reviews-contract";
import type { DeskReviewOptions } from "../../../src/review/desk-run-options";
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
import { Dialog, EmptyState, overlayOpen } from "./components/ui";
import { AppShell, PROJECT_VIEWS, projectViewForKey, type View } from "./shell/AppShell";
import { CommandPalette, type PaletteItem } from "./shell/CommandPalette";
import { SettingsView } from "./shell/SettingsView";
import { Welcome } from "./shell/Welcome";
import { UpdateBanner } from "./shell/UpdateBanner";
import { ReviewBoard, type ReviewTabIndicator } from "./review/ReviewBoard";
import type { ReviewIntent } from "./review/ReviewWorkspace";
import type { FixFindingsFlow } from "./reviews/model";
import { ReviewsView, type ReviewsFocus, type ReviewsTabIndicator } from "./reviews/ReviewsView";
import { RoutingDialog } from "./shell/RoutingDialog";
import { ReviewLaunchDialog } from "./review/ReviewLaunchDialog";
import { SessionReviewActivity } from "./review/SessionReviewActivity";
import { loadSessionReviewTargets, readSessionReviewLinks, reviewFlowId, reviewSessionTitle, type SessionReviewLink } from "./review/sessionReview";
import { publishSessionReview, reviewRun } from "./platform/reviewRuns";
import { modelChoices, providerOf } from "./session/Composer";
import type { IssueOriginRequest } from "./issues/IssueOriginDetail";
import { IssuesView } from "./issues/IssuesView";
import { useIssueWork } from "./issues/IssueWork";
import { FlowsBoard } from "./flows/FlowsBoard";
import type { LinkedSession } from "./flows/FlowDetail";
import { boundSessions, sessionFlags, type SessionSubject } from "./acp/types";
import { flowPrompt, prFlows, prSubject, reviewLaunchTarget, subjectOpener, withPendingSubjects, type PrFlowOffer, type SubjectSessionTarget } from "./review/prWork";
import { usePendingFlowLinks } from "./review/usePendingFlowLinks";
import type { ReviewCard } from "./review/types";
import { SessionSubjectLinks } from "./session/SessionSubjectLinks";
import type { FlowCard } from "./platform/commands";
import { laneOf, workPrompt } from "./flows/model";
import { useFlows } from "./flows/useFlows";
import { AskUserDialog, FatalDialog, PermissionDialog } from "./session/Approvals";
import type { ComposerHandle } from "./session/Composer";
import { ProvidersDialog, useProvidersDialog, type ProvidersApi } from "./session/ProvidersDialog";
import { SessionView } from "./session/SessionView";
import { modelOption, useAcpSession } from "./session/useAcpSession";
import { ProjectMenu } from "./project/ProjectMenu";
import { GitHubIntegrations, ProjectGitHubSettings } from "./project/GitHubSettings";
import { TelegramServeSettings } from "./project/TelegramServeSettings";
import { TelegramBotSettings } from "./project/TelegramBotSettings";
import { getProjectGitHubAccount, type ProjectGitHubAccount } from "./platform/githubAccounts";
import { PROJECT_COMMANDS } from "./project/projectCommands";
import { useProjectRunner } from "./project/useProjectRunner";
import { providersLister, WikiEnrichDialog } from "./project/WikiEnrichDialog";
import { supportsProviders } from "./acp/providers";
import { onProjectsState, projectRegister, projectsState, projectSwitch, reportProjectActivity, type LiveProject } from "./platform/projects";
import { projectActivity, railProjects, removeRailProject, syncRailProjects } from "./shell/projectRail";

const LazyMetaprojectView = lazy(() => import("./metaproject/MetaprojectView").then(module => ({ default: module.MetaprojectView })));

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
    if (cwd === null) void projectRegister(null).catch(() => {});
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
        <SettingsView onBack={() => setWelcomeSettings(false)} integrations={<GitHubIntegrations />} telegramIntegration={<TelegramServeSettings>{(refreshKey) => <TelegramBotSettings refreshKey={refreshKey} />}</TelegramServeSettings>} />
        </div>
      ) : (
        <Welcome onOpen={async (folder) => {
          if (isTauri()) await projectSwitch(folder);
          else setCwd(folder);
        }} onSettings={() => setWelcomeSettings(true)} />
      )}
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

/** Mounts a view on its first visit and keeps it mounted, hidden, afterwards, so its state survives view switches. */
export function RetainedView({ active, visible, children }: { active: boolean; visible: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return visited || active ? <div className="view" hidden={!visible}>{children}</div> : null;
}

type ExplorerProps = { cwd: string; visible?: boolean; onRebuild: () => Promise<boolean>; onDraft?: (task: string) => Promise<void> };

/**
 * The Metaproject explorer in the work area: mounted on its first visit and kept, and told whether it is the
 * shown view, so it closes its Filters popover on leaving and re-reads its catalog on return.
 * `explorer` is a test seam (the app passes nothing); bun's module mocks would outlive one test file.
 */
export function MetaprojectWork({ cwd, view, workView, onRebuild, onDraft, explorer: MetaprojectView = LazyMetaprojectView }: {
  cwd: string;
  view: View;
  workView: Exclude<View, "settings">;
  onRebuild: () => Promise<boolean>;
  onDraft: (task: string) => Promise<void>;
  explorer?: ComponentType<ExplorerProps>;
}) {
  return (
    <RetainedView active={workView === "metaproject"} visible={view === "metaproject"}>
      <Suspense fallback={<p role="status">Loading Metaproject…</p>}>
        <MetaprojectView cwd={cwd} visible={view === "metaproject"} onRebuild={onRebuild} onDraft={onDraft} />
      </Suspense>
    </RetainedView>
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
  const providers = useProvidersDialog();
  const providersApi = useMemo<ProvidersApi>(() => ({ request: s.rpc, extensions: s.extensions, onChallenge: s.onLoginChallenge }), [s.rpc, s.extensions, s.onLoginChallenge]);
  const [view, setView] = useState<View>("session");
  const settingsReturn = useRef<Exclude<View, "settings">>("session");
  const settingsFocus = useRef<HTMLElement | null>(null);
  const settingsProjectReturn = useRef(false);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "integrations">("appearance");
  const [githubAccount, setGitHubAccount] = useState<ProjectGitHubAccount | null>(null);
  const reviewViewer = githubAccount?.login ?? undefined;
  const [reviewNotice, setReviewNotice] = useState<{ binding?: string; viewer?: string; indicator: ReviewTabIndicator }>();
  const updateReviewNotice = useCallback((indicator: ReviewTabIndicator, viewer?: string) => {
    setReviewNotice({ binding: reviewViewer, viewer, indicator });
  }, [reviewViewer]);
  const [reviewsNotice, setReviewsNotice] = useState<{ binding?: string; indicator: ReviewsTabIndicator }>();
  const updateReviewsNotice = useCallback((indicator: ReviewsTabIndicator) => {
    setReviewsNotice({ binding: reviewViewer, indicator });
  }, [reviewViewer]);
  const [reviewsFocus, setReviewsFocus] = useState<ReviewsFocus | null>(null);
  const reviewsFocusNonce = useRef(0);
  const openInReviews = useCallback((target: { repo: string; repositoryId: string; number: number }, intent?: ReviewIntent) => {
    setReviewsFocus({ ...target, intent, nonce: ++reviewsFocusNonce.current });
    setView("reviews");
  }, []);
  // A focus request is handed over once: dropped as soon as the Reviews tab took it, so a remount cannot replay it.
  const reviewsFocusHandled = useCallback((nonce: number) => {
    setReviewsFocus(old => old?.nonce === nonce ? null : old);
  }, []);
  // The PR watcher's background polls and the board's identity reach the Reviews tab.
  const [watcherPolls, setWatcherPolls] = useState(0);
  const noteWatcherPoll = useCallback(() => setWatcherPolls(n => n + 1), []);
  const [boardIdentity, setBoardIdentity] = useState<{ repo: string; repositoryId: string; viewer: string } | null>(null);
  const [githubAccountError, setGitHubAccountError] = useState("");
  const [projectSettings, setProjectSettings] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const accountRevision = useRef(0);
  const registration = useRef<Promise<void> | null>(null);
  const [issueOrigin, setIssueOrigin] = useState<IssueOriginRequest | null>(null);
  const openIssueOrigin = (origin: IssueOriginRequest) => { setIssueOrigin(origin); setView("issues"); };
  const [linkedFlow, setLinkedFlow] = useState<string | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [enrich, setEnrich] = useState(false);
  const runProject = useProjectRunner(cwd, s.keryxPath);
  const rebuildGraph = useCallback(() => new Promise<boolean>(resolve => {
    void runProject(["gdgraph", "build"], "Build Metaproject graph", code => resolve(code === 0))
      .then(started => { if (!started) resolve(false); });
  }), [runProject]);
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

  const openSettings = useCallback((tab: "appearance" | "integrations" = "appearance") => {
    if (view !== "settings") {
      settingsReturn.current = view;
      settingsFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setSettingsTab(tab);
    setView("settings");
  }, [view]);

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
    setIssueOrigin(null);
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
    return id;
  }, [s, fillComposer]);

  /** The sessions the cards see: the stored list plus Subject bindings keryx has not stored yet. */
  const subjectSessions = useMemo(() => withPendingSubjects(state.sessions, s.pendingSubjects), [state.sessions, s.pendingSubjects]);
  const subjectSessionsRef = useRef(subjectSessions);
  subjectSessionsRef.current = subjectSessions;
  // Read at call time, so the board's callbacks below keep their identity and its work rows can stay memoised.
  const acp = useRef(s);
  acp.current = s;
  const flowCards = useRef(flows.cards);
  flowCards.current = flows.cards;
  /** One open per PR at a time: a second press while `session/new` is in flight gets the same open. */
  const openSubject = useMemo(() => subjectOpener(), []);

  /** Open the PR's bound session (newest, named or new); a new one is bound to the PR and gets `prompt`, never sent. */
  const openPrSession = useCallback((card: ReviewCard, target: SubjectSessionTarget, subject: SessionSubject, prompt: string, prefillExisting = false) => {
    setView("session");
    const s = acp.current;
    const flow = prFlows(card, flowCards.current, boundSessions(subjectSessionsRef.current, subject))[0];
    return openSubject({
      sessions: () => subjectSessionsRef.current,
      loadSession: async id => { await s.loadSession(id); },
      // The PR's Flow (one naming it, or one a bound session works on) is linked to the new session.
      newSession: () => flow ? s.workOnFlow(flow.dir, "new") : s.newSession(),
      bind: (id, value) => void s.bindSubject(id, value),
      fill: fillComposer,
      isShown: s.isShown,
    }, subject, target, prompt, prefillExisting);
  }, [fillComposer, openSubject]);

  /**
   * "Create Flow": the PR's session with a flow prompt. The one package that then appears is offered on the
   * PR's work row ("Link Flow #<id>?"); only Link writes the session's `flow` flag. "Fix findings" on the Reviews
   * tab takes the same path with its own prompt on a PR without a Flow.
   */
  const flowLinks = usePendingFlowLinks(flows.cards, flows.refreshedAt !== null, state.sessions, (id, dir) => acp.current.linkFlow(id, dir));
  const flowLinkActions = flowLinks.actions;
  const createPrFlow = useCallback(async (card: ReviewCard, subject: SessionSubject, prompt = flowPrompt(card.url)) => {
    const known = flowLinkActions.known();
    const opened = await openPrSession(card, "latest", subject, prompt, true);
    // Only a prompt this press put into the shown session can make the package: a press coalesced into an open in
    // flight, or an open the user switched away from, registers nothing.
    if (opened?.filled) flowLinkActions.expect(opened.sessionId, known);
  }, [flowLinkActions, openPrSession]);
  const flowOffers = useMemo(() => flowLinks.offers.flatMap((offer): PrFlowOffer[] => {
    const flow = flows.cards.find(card => card.dir === offer.dir);
    return flow ? [{ sessionId: offer.sessionId, flow, ...(offer.linking && { linking: true }), ...(offer.error && { error: offer.error }) }] : [];
  }), [flowLinks.offers, flows.cards]);
  const linkFlowOffer = useCallback((offer: PrFlowOffer) => void flowLinkActions.accept(offer.sessionId), [flowLinkActions]);
  const dismissFlowOffer = useCallback((offer: PrFlowOffer) => flowLinkActions.dismiss(offer.sessionId), [flowLinkActions]);

  const [reviewFocus, setReviewFocus] = useState<{ repo: string; number: number; nonce: number } | null>(null);
  // Never reused, also after a handled request is cleared: the board opens each nonce once.
  const focusNonce = useRef(0);
  const reviewFocusHandled = useCallback((nonce: number) => setReviewFocus(old => old?.nonce === nonce ? null : old), []);
  const openPrFromBoard = useCallback((card: ReviewCard, target: SubjectSessionTarget, subject: SessionSubject) =>
    void openPrSession(card, target, subject, card.url), [openPrSession]);
  const createFlowFromBoard = useCallback((card: ReviewCard, subject: SessionSubject) => void createPrFlow(card, subject), [createPrFlow]);
  /**
   * "Fix findings" on the Reviews tab. On a PR with a Flow (by the work row's rule: its prUrl, or a bound session's flow
   * flag) the Flow's session gets a fix-round prompt for that Flow and no link is expected; otherwise Create Flow's path.
   */
  const fixFindingsFromReviews = useCallback((card: ReviewCard, repository: { repo: string; repositoryId: string }, prompt: string,
    fixRoundPrompt: (flow: FixFindingsFlow) => string) => {
    const subject = prSubject(card, repository.repo, repository.repositoryId);
    const flow = prFlows(card, flowCards.current, boundSessions(subjectSessionsRef.current, subject))[0];
    // openPrSession opens the bound session, else a new one working on this same Flow.
    if (flow) void openPrSession(card, "latest", subject, fixRoundPrompt(flow), true);
    else void createPrFlow(card, subject, prompt);
  }, [createPrFlow, openPrSession]);
  const openFlowFromBoard = useCallback((dir: string) => {
    setLinkedFlow(dir);
    setView("flows");
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
      const projectView = projectViewForKey(k);
      if (k === "k") {
        e.preventDefault();
        setPalette("");
      } else if (projectView) {
        e.preventDefault();
        go(projectView);
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
  }, [go, s, state.busy, state.phase, state.modes, state.commands, state.sessions, state.sessionId, recents, cwd, openFolder, switchProject, fillComposer, runProject]);

  const topPermission = s.permissions[0];
  const topAsk = s.asks[0];
  const workView = view === "settings" ? settingsReturn.current : view;
  const offerGitHub = githubAccount?.eligible && !githubAccount.configured && !onboardingDismissed
    && view !== "settings" && !s.fatal && !topAsk && !topPermission && !providers.request && !enrich && palette === null;
  const reviewDisconnected = githubAccount?.configured && !githubAccount.login;

  const issueWork = useIssueWork({
    cwd, ready: state.phase === "ready", canPrepare: s.canPrepareIssue,
    showSession: async (id, turn, pendingQuestions, signal) => {
      await s.openIssueSession(id, turn, pendingQuestions, signal);
      if (!signal?.aborted) setView("session");
    },
    showFlow: dir => { setLinkedFlow(dir); setView("flows"); },
    notifyError: message => s.notify("error", message),
  });

  const currentNotice = !reviewDisconnected && reviewNotice?.binding === reviewViewer ? reviewNotice : undefined;
  const reviewsIndicator = !reviewDisconnected && reviewsNotice?.binding === reviewViewer ? reviewsNotice?.indicator ?? null : null;
  const [reviewLinks, setReviewLinks] = useState(() => readSessionReviewLinks(cwd));
  const linkReviewContinuation = useCallback((link: SessionReviewLink) => {
    setReviewLinks(previous => [link, ...previous.filter(item => item.id !== link.id || item.sessionId !== link.sessionId)].slice(0, 100));
  }, []);
  const openOriginReviewSession = useCallback(async (sessionId: string) => {
    if (!(await s.loadSession(sessionId))) {
      throw new Error("The originating session could not be opened in this project.");
    }
    setView("session");
  }, [s.loadSession]);
  const openReviewWorkspace = useCallback(async (_key: DeskRunKey, run: DeskRun) => {
    if (!run.sessionId) throw new Error("This review has no originating session.");
    await openOriginReviewSession(run.sessionId);
  }, [openOriginReviewSession]);
  const startSessionReview = useCallback(async (key: DeskRunKey, revision: DeskRevision, options?: DeskReviewOptions, owner?: string, prompt?: string) => {
    const sessionId = owner ?? await s.newSession();
    if (!sessionId) throw new Error("Could not create the review session.");
    const { baseSha, headSha } = revision;
    const snapshot = await reviewRun(cwd, key, { kind: "start", baseSha, headSha, ...(options && { options }), sessionId });
    const run = snapshot.runs.find(attempt => attempt.id === snapshot.startedRunId);
    if (!run) throw new Error("The selected Keryx CLI did not confirm the review attempt.");
    publishSessionReview(cwd, key, snapshot);
    if (run.sessionId !== sessionId) {
      const remembered = !run.sessionId ? readSessionReviewLinks(cwd).find(link =>
        link.id === run.id && link.key.repositoryId === key.repositoryId &&
        link.key.viewer.toLowerCase() === key.viewer.toLowerCase()) : undefined;
      const origin = run.sessionId ?? remembered?.sessionId;
      s.notify("info", origin ? "Opening the review already recorded for this revision." : "This revision already has a review. Opening its details.");
      if (origin) {
        void openOriginReviewSession(origin).catch(() => openInReviews(key));
      } else {
        openInReviews(key);
      }
      return snapshot;
    }
    const request = (prompt || `Review https://github.com/${key.repo}/pull/${key.number}`).slice(0, SESSION_REVIEW_REQUEST_LIMIT);
    let savedRequest: string | undefined;
    if (s.extensions.includes(SESSION_REVIEW_REQUEST_METHOD)) {
      const persisted = await s.rpc<string | null>(SESSION_REVIEW_REQUEST_METHOD, { sessionId, attemptId: run.id, text: request }).catch(() => null);
      if (typeof persisted === "string") savedRequest = persisted;
      else s.notify("warn", "The review started, but its original request could not be saved.");
    }
    linkReviewContinuation({ id: run.id, sessionId, key, ...(savedRequest && { prompt: savedRequest }),
      revision: { baseSha: run.baseSha, headSha: run.headSha } });
    if (!owner) setView("session");
    return snapshot;
  }, [cwd, linkReviewContinuation, s.newSession, s.notify, s.extensions, s.rpc, openOriginReviewSession, openInReviews]);
  const boardReviewRun = useCallback<typeof reviewRun>((project, key, action) => {
    return action.kind === "start" ? startSessionReview(key, action, action.options) : reviewRun(project, key, action);
  }, [startSessionReview]);

  const draftReview = s.reviewDraftRequest;
  const [routingSession, setRoutingSession] = useState<string | null>(null);
  useEffect(() => {
    if (routingSession !== null && (routingSession !== state.sessionId || view !== "session")) setRoutingSession(null);
  }, [routingSession, state.sessionId, view]);
  const sessionFlow = state.sessions.find(session => session.sessionId === state.sessionId);
  const shownSubject = (sessionFlow && sessionFlags(sessionFlow).subject) ?? (state.sessionId ? s.pendingSubjects.get(state.sessionId) : undefined);
  const shownFlowDir = sessionFlow && sessionFlags(sessionFlow).flow;
  const shownFlow = shownFlowDir ? flows.cards.find(card => card.dir === shownFlowDir) : undefined;
  const flowId = reviewFlowId(flows.cards, sessionFlow && sessionFlags(sessionFlow).flow, draftReview?.flowId);
  const viewer = reviewViewer ?? currentNotice?.viewer;
  const [durableReviewLinks, setDurableReviewLinks] = useState<{ sessionId: string; viewer: string | undefined; links: SessionReviewSummary[] }>();
  const reviewSessionId = state.sessionId;
  const canReadSessionReviews = state.held && s.extensions.includes(SESSION_REVIEWS_METHOD);
  useEffect(() => {
    if (!reviewSessionId || !canReadSessionReviews || reviewDisconnected || view !== "session") return;
    let active = true;
    const read = () => {
      void s.rpc<SessionReviewSummary[]>(SESSION_REVIEWS_METHOD, { sessionId: reviewSessionId }).then(links => {
        if (active) setDurableReviewLinks({ sessionId: reviewSessionId, viewer, links });
      }).catch(() => {
        if (active) setDurableReviewLinks(undefined);
      });
    };
    read();
    const timer = state.busy ? window.setInterval(read, 6000) : undefined;
    return () => { active = false; window.clearInterval(timer); };
  }, [reviewSessionId, canReadSessionReviews, reviewDisconnected, view, viewer, state.busy, s.rpc]);
  const sessionReviews = useMemo(() => {
    const durable = durableReviewLinks?.sessionId === reviewSessionId && durableReviewLinks?.viewer === viewer
      ? durableReviewLinks.links : [];
    const remembered = reviewLinks.filter(link => link.sessionId === reviewSessionId &&
      (!viewer || viewer.toLowerCase() === link.key.viewer.toLowerCase()));
    return [...remembered.filter(link => !durable.some(item => link.id === item.id)), ...durable.map(link => ({
      ...link,
      ...(link.prompt === undefined && { prompt: remembered.find(item => item.id === link.id)?.prompt }),
    }))];
  }, [durableReviewLinks, reviewLinks, reviewSessionId, viewer]);
  const sessionTitle = reviewSessionTitle(state.title?.trim(), sessionReviews.at(-1)) || "New session";
  // The title bar names the project and the view; the page below keeps only its own toolbar.
  const title =
    view === "session" ? (
      <span className="truncate">{sessionTitle}</span>
    ) : (
      <span className="truncate">
        {view === "settings" ? "Settings" : `${basename(cwd)} · ${PROJECT_VIEWS.find(item => item.id === view)?.label}`}
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
      title={title}
      titleLinks={<SessionSubjectLinks subject={shownSubject} flow={shownFlow}
        onOpenSubject={subject => {
          if (subject.kind === "issue") {
            if (state.sessionId) openIssueOrigin({ sessionId: state.sessionId });
            return;
          }
          go("review");
          setReviewFocus({ repo: subject.repo, number: subject.number, nonce: ++focusNonce.current });
        }}
        onOpenFlow={dir => { setLinkedFlow(dir); setView("flows"); }} />}
      onOpenSourceIssue={sessionFlow && sessionFlags(sessionFlow).hasIssue
        ? () => openIssueOrigin({sessionId: sessionFlow.sessionId}) : undefined}
      hasSession={state.sessionId !== null}
      status={status}
      flowsActive={flowsActive}
      reviewIndicator={currentNotice?.indicator}
      reviewsIndicator={reviewsIndicator}
      projects={projects}
      activity={activity}
      live={live}
      onRemoveProject={removeProject}
      onOpenFolder={() => void openFolder()}
      onSwitchProject={switchProject}
      onNewWindow={(p) => void windowOpenProject(p)}
      onCloseProject={onCloseProject}
      onPalette={() => setPalette("")}
      actions={<ProjectMenu run={runProject} onEnrich={() => setEnrich(true)} />}
    >
      {/* The session view stays mounted so the transcript and draft survive view switches. */}
      <div className="view" hidden={view !== "session"}>
        <SessionView ref={composer} s={s} cwd={cwd} projectName={basename(cwd)} visible={view === "session"} onGoFlows={() => go("flows")} onGoSettings={() => go("settings")} onTelegramSettings={() => openSettings("integrations")} narrow={narrow} onProviders={providers.openProviders} onRouting={() => setRoutingSession(state.sessionId)}
          reviewLinks={reviewLinks}
          reviewActivity={!reviewDisconnected && sessionReviews.length ? <SessionReviewActivity cwd={cwd} links={sessionReviews} visible={view === "session"}
            onContinuation={linkReviewContinuation} /> : undefined}
          githubAccount={githubAccount?.eligible ? githubAccount : undefined} onProjectSettings={openProjectSettings} />
      </div>
      {workView === "flows" ? (
        <div className="view" hidden={view !== "flows"}>
          <FlowsBoard onOpenIssue={dir => openIssueOrigin({flowDir:dir})} initialOpenDir={linkedFlow} cwd={cwd} flows={flows} linkedSessions={linkedSessions} onOpenSession={(card) => void openSessionWith(card.prUrl ?? `.metaproject/flows/${card.dir}`, card)} onWorkOn={(c, target) => void workOn(c, target)} />
        </div>
      ) : null}
      {issueWork.chooser}
      {workView === "issues" && <div className="view" hidden={view !== "issues"}>
        <IssuesView onViewerChange={issueWork.setViewer} origin={issueOrigin} onCloseOrigin={() => setIssueOrigin(null)} cwd={cwd} preferred={reviewViewer} onSettings={() => openSettings("integrations")}
          sessions={state.sessions}
          onWork={(login, action, ref, flowDir) => issueWork.run({login, action, ref, flowDir})} />
      </div>}
      {/* Kept mounted after its first visit so mode, query, selection, filters and Back survive view switches. */}
      <MetaprojectWork cwd={cwd} view={view} workView={workView} onRebuild={rebuildGraph} onDraft={async task => {
        if (!(await openSessionWith(task))) throw new Error("Could not open a draft session.");
        setView("session");
      }} />
      {/* Mounted while hidden: it re-reads on a session review, a PR watcher poll and, while a Review runs, every minute,
          so the Reviews indicator follows those on every tab. Mounted once the account read settled, so it reads once. */}
      <div className="view" hidden={view !== "reviews"}>
        {reviewDisconnected ? (
          <EmptyState title="GitHub is not connected" icon="checklist">
            <button className="btn" onClick={openProjectSettings}>Choose an account</button>
          </EmptyState>
        ) : (githubAccount || githubAccountError) ? (
          <ReviewsView key={reviewViewer ?? "active-gh"} expectedViewer={reviewViewer} active={workView === "reviews"} cwd={cwd}
            focus={reviewsFocus} onFocusHandled={reviewsFocusHandled} reloadSignal={watcherPolls}
            rulesTarget={boardIdentity} onIndicatorChange={updateReviewsNotice} flows={flows.cards} reviewModels={reviewModels}
            runCommand={boardReviewRun} onOpenOriginSession={openOriginReviewSession} onOpenReviewSession={openReviewWorkspace} onFixFindings={fixFindingsFromReviews} onOpenFlow={(dir) => {
              setLinkedFlow(dir);
              setView("flows");
            }} />
        ) : null}
      </div>
      <div className="view" hidden={view !== "review"}>
        {reviewDisconnected ? (
          <EmptyState title="GitHub is not connected" icon="pr">
            <button className="btn" onClick={openProjectSettings}>Choose an account</button>
          </EmptyState>
        ) : (
          <ReviewBoard key={reviewViewer ?? "active-gh"} expectedViewer={reviewViewer} onIndicatorChange={updateReviewNotice} active={workView === "review"} cwd={cwd} flows={flows.cards} reviewModels={reviewModels} currentRepairModel={currentReviewModel} runCommand={boardReviewRun} onOpenReviewSession={openOriginReviewSession} onOpenInReviews={openInReviews} onWatcherPoll={noteWatcherPoll} onIdentityChange={setBoardIdentity}
            sessions={subjectSessions} focus={reviewFocus} onFocusHandled={reviewFocusHandled}
            onOpenSubjectSession={openPrFromBoard} onCreateFlow={createFlowFromBoard} onOpenFlow={openFlowFromBoard}
            flowOffers={flowOffers} onLinkFlowOffer={linkFlowOffer} onDismissFlowOffer={dismissFlowOffer} />
        )}
      </div>
      {view === "settings" ? (
        <div className="view">
          <SettingsView agentVersion={state.agentVersion} onBack={closeSettings} initialTab={settingsTab} integrations={<GitHubIntegrations />} telegramIntegration={<TelegramServeSettings>{(refreshKey) => <TelegramBotSettings refreshKey={refreshKey} />}</TelegramServeSettings>} />
        </div>
      ) : null}

      {view === "session" && routingSession !== null && routingSession === state.sessionId &&
        !topPermission && !topAsk && !providers.request && !projectSettings && !offerGitHub &&
        <RoutingDialog key={routingSession} sessionId={routingSession} models={reviewModels} rpc={s.rpc}
          onClose={() => setRoutingSession(null)} />}

      {view === "session" && !(routingSession && routingSession === state.sessionId) && draftReview && !topPermission && !topAsk && !providers.request && !projectSettings && !offerGitHub &&
        <ReviewLaunchDialog key={JSON.stringify([draftReview.nonce, reviewViewer])} flows={flows.cards} defaultFlow={flowId}
          initialTarget={reviewLaunchTarget(draftReview.target, shownSubject)} models={reviewModels} loadTargets={loadReviewTargets}
          onApply={async (key, revision, options) => {
            await startSessionReview(key, revision, options, draftReview.sessionId, draftReview.prompt);
          }}
          onClose={() => s.dismissReviewDraftRequest(draftReview.nonce)} />}

      {projectSettings || offerGitHub ? (
        <ProjectGitHubSettings cwd={cwd} account={githubAccount} accountError={githubAccountError} onRetryAccount={() => void refreshGitHubAccount()}
          onboarding={!projectSettings}
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

      {providers.request ? <ProvidersDialog request={providers.request} api={providersApi} onClose={providers.close} /> : null}
      {enrich ? <WikiEnrichDialog listProviders={listProviders} onRun={(args, title) => void runProject(args, title)} onClose={() => setEnrich(false)} /> : null}
      {palette !== null ? <CommandPalette items={paletteItems} initialQuery={palette} onClose={() => setPalette(null)} /> : null}

      {s.fatal && !(s.fatalHidden && (s.fatal.kind === "incompatible" || s.fatal.kind === "noShell")) ? (
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
      {!s.fatal && topPermission ? (
        <PermissionDialog
          key={topPermission.id}
          pending={topPermission}
          modeId={state.modes?.currentModeId ?? null}
          queued={s.permissions.length - 1}
          onAnswer={s.answerPermission}
        />
      ) : null}
      {!s.fatal && !topPermission && topAsk ? <AskUserDialog key={topAsk.id} pending={topAsk} onAnswer={s.answerAsk} onSendToTelegram={s.projectTelegramQuestion} /> : null}
    </AppShell>
  );
}
