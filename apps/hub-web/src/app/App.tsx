import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  GitBranch,
  BookOpen,
  MessageSquare,
  Code2,
  Send,
  History,
  RefreshCw,
  LogOut,
  FolderKanban,
  Monitor,
  MessagesSquare,
  Play,
  Menu,
  X,
  Layers,
} from "lucide-react";
import type { Principal, Project } from "../api/types";
import {
  ApiError,
  deleteJson,
  errorMessage,
  getJson,
  postJson,
  resetClient,
  setAuthLossHandler,
} from "../api/client";
import { useRemoteEvents } from "../api/remote-hooks";
import { useDraftStore } from "../state/drafts";
import { HubContext } from "./hub-context";
import {
  navigate,
  resetNavigation,
  tabs,
  useLocation,
  type Tab,
} from "./navigation";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
} from "../components/ui";
import { ThemeSelect } from "../theme";
const ManagedWorkView = lazy(() =>
  import("../features/managed-work/view").then((m) => ({
    default: m.ManagedWorkView,
  })),
);
const ProjectsView = lazy(() =>
  import("../features/workflow").then((module) => ({
    default: module.ProjectsView,
  })),
);
const GlobalFlowsView = lazy(() =>
  import("../features/workflow").then((module) => ({
    default: module.GlobalFlowsView,
  })),
);
const OverviewView = lazy(() =>
  import("../features/workflow").then((module) => ({
    default: module.OverviewView,
  })),
);
const FlowsView = lazy(() =>
  import("../features/workflow").then((module) => ({
    default: module.FlowsView,
  })),
);
const DocumentsView = lazy(() =>
  import("../features/context").then((module) => ({
    default: module.DocumentsView,
  })),
);
const ProposalsView = lazy(() =>
  import("../features/context").then((module) => ({
    default: module.ProposalsView,
  })),
);
const RevisionsView = lazy(() =>
  import("../features/context").then((module) => ({
    default: module.RevisionsView,
  })),
);
const DeliveryView = lazy(() =>
  import("../features/context").then((module) => ({
    default: module.DeliveryView,
  })),
);
const HistoryView = lazy(() =>
  import("../features/context").then((module) => ({
    default: module.HistoryView,
  })),
);
const MachinesView = lazy(() =>
  import("../features/remote").then((module) => ({
    default: module.MachinesView,
  })),
);
const SessionsView = lazy(() =>
  import("../features/remote").then((module) => ({
    default: module.SessionsView,
  })),
);
const RunsView = lazy(() =>
  import("../features/remote").then((module) => ({ default: module.RunsView })),
);
function RemoteUpdates({ projectIds }: { projectIds: string[] }) {
  const online = useRemoteEvents(projectIds);
  const { t } = useTranslation("remote");
  return (
    <p role="status" className="mb-4 text-xs text-slate-500">
      {t(online ? "connected" : "disconnected")}
    </p>
  );
}
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15000 },
    mutations: { retry: false },
  },
});
let bootstrapPending:
  | Promise<{ principal: Principal | null; sso: boolean }>
  | undefined;
async function bootstrap() {
  if (!bootstrapPending)
    bootstrapPending = (async () => {
      try {
        return {
          principal: (await getJson<{ principal: Principal }>("/session"))
            .principal,
          sso: false,
        };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const config = await getJson<{ cloudflareAccessEnabled: boolean }>(
          "/auth/config",
        );
        if (!config.cloudflareAccessEnabled)
          return { principal: null, sso: false };
        return {
          principal: (
            await postJson<{ principal: Principal }>("/session/cloudflare", {})
          ).principal,
          sso: true,
        };
      }
    })().finally(() => {
      bootstrapPending = undefined;
    });
  return bootstrapPending;
}
const icons: Record<Tab, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  flows: GitBranch,
  work: Layers,
  documents: BookOpen,
  proposals: MessageSquare,
  code: Code2,
  delivery: Send,
  history: History,
  machines: Monitor,
  sessions: MessagesSquare,
  runs: Play,
};
function Locale() {
  const { i18n, t } = useTranslation("common");
  return (
    <div
      className="inline-flex rounded-lg border border-slate-200 bg-white p-1"
      role="group"
      aria-label={t("language")}
    >
      {(["ru", "en"] as const).map((lang) => (
        <button
          key={lang}
          type="button"
          aria-pressed={i18n.language === lang}
          onClick={() => void i18n.changeLanguage(lang)}
          className={
            "rounded-md px-2 py-1 text-xs font-bold focus-visible:outline-2 focus-visible:outline-emerald-700 " +
            (i18n.language === lang
              ? "bg-emerald-800 text-white"
              : "text-slate-500 hover:bg-slate-100")
          }
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">K</span>
      <span>
        Keryx <small>Team Hub</small>
      </span>
    </div>
  );
}
function Shell({
  principal,
  scopeKey,
  onRefresh,
  onLogout,
}: {
  principal: Principal;
  scopeKey: number;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation("common");
  const ru = i18n.language.startsWith("ru");
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [menu, setMenu] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const projects = useQuery({
    queryKey: [scopeKey, "projects"],
    queryFn: ({ signal }) =>
      getJson<{ projects: Project[] }>("/projects", signal),
  });
  const projectId = location.projectId;
  const active = projects.data?.projects.find((p) => p.id === projectId);
  const views: Record<Tab, React.ReactNode> = {
    overview: <OverviewView />,
    work: <ManagedWorkView />,
    flows: projectId ? <FlowsView /> : <GlobalFlowsView />,
    documents: <DocumentsView />,
    proposals: <ProposalsView />,
    code: <RevisionsView />,
    delivery: <DeliveryView />,
    history: <HistoryView />,
    machines: <MachinesView />,
    sessions: <SessionsView />,
    runs: <RunsView />,
  };
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const closeMenu = () => {
    setMenu(false);
    menuTrigger.current?.focus();
  };
  useEffect(() => {
    if (menu)
      navRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);
  const navTabs = projectId
    ? tabs
    : (["overview", "flows", "machines"] as Tab[]);
  const label = (tab: Tab) =>
    tab === "work"
      ? ru
        ? "Работа над проектом"
        : "Managed work"
      : ["machines", "sessions", "runs"].includes(tab)
        ? t(tab, { ns: "remote" })
        : t("nav." + tab);
  return (
    <HubContext.Provider
      value={{
        projectId,
        principal,
        scopeKey,
        location,
        navigate,
        refresh: onRefresh,
      }}
    >
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          {ru ? "К содержимому" : "Skip to content"}
        </a>
        <aside
          className={"sidebar " + (menu ? "sidebar-open" : "")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
            }
          }}
        >
          <div className="sidebar-brand">
            <Brand />
            <button
              type="button"
              className="mobile-menu"
              aria-label={ru ? "Закрыть навигацию" : "Close navigation"}
              onClick={closeMenu}
            >
              <X size={18} />
            </button>
          </div>
          <nav ref={navRef} className="nav-list" aria-label={t("appName")}>
            {navTabs.map((tab) => {
              const Icon = icons[tab];
              return (
                <button
                  type="button"
                  key={tab}
                  onClick={() => {
                    navigate({
                      tab,
                      documentId: undefined,
                      flowId: undefined,
                      revisionId: undefined,
                      sessionId: undefined,
                      runId: undefined,
                      machineId: undefined,
                    });
                    setMenu(false);
                    document.getElementById("main-content")?.focus();
                  }}
                  aria-current={location.tab === tab ? "page" : undefined}
                  className={
                    "nav-item " + (location.tab === tab ? "nav-active" : "")
                  }
                >
                  <Icon size={17} aria-hidden="true" />
                  {label(tab)}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-projects">
            <span>{t("projects")}</span>
            {projects.data?.projects.map((p) => (
              <button
                type="button"
                key={p.id}
                className={
                  "nav-item " + (projectId === p.id ? "project-active" : "")
                }
                onClick={() => {
                  navigate({ projectId: p.id, tab: "overview" });
                  setMenu(false);
                }}
              >
                <span className="project-initial">{p.name.slice(0, 1)}</span>
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
          <div className="identity">
            <p className="identity-kind">
              {t(
                principal.issuer && principal.subject && principal.email
                  ? "verifiedIdentity"
                  : "tokenIdentity",
              )}
            </p>
            <p className="identity-name">{principal.email ?? principal.id}</p>
            <p>
              {t(principal.kind)} · {t(principal.role)}
            </p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void action(onLogout)}
            >
              <LogOut size={14} />
              {t("signOut")}
            </Button>
          </div>
        </aside>
        <div className="workspace">
          <header className="workspace-header">
            <button
              ref={menuTrigger}
              type="button"
              className="mobile-menu"
              aria-label={ru ? "Открыть навигацию" : "Open navigation"}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Menu size={18} />
            </button>
            <div className="workspace-breadcrumb">
              <FolderKanban size={16} aria-hidden="true" />
              <button
                type="button"
                className="shrink-0 whitespace-nowrap"
                onClick={() => navigate({ projectId: null, tab: "overview" })}
              >
                {t("projects")}
              </button>
              {active && (
                <>
                  <span>/</span>
                  <span className="min-w-0 truncate" title={active.name}>
                    {active.name}
                  </span>
                </>
              )}
            </div>
            <div className="workspace-tools">
              <label className="sr-only" htmlFor="hub-project-selector">
                {t("project")}
              </label>
              <Select
                id="hub-project-selector"
                value={projectId ?? ""}
                onChange={(e) =>
                  navigate({
                    projectId: e.target.value || null,
                    tab:
                      location.tab === "machines" || location.tab === "flows"
                        ? location.tab
                        : "overview",
                  })
                }
              >
                <option value="">
                  {ru ? "Hub · все проекты" : "Hub · all projects"}
                </option>
                {projects.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <ThemeSelect />
              <Locale />
              <Button
                variant="secondary"
                aria-label={t("refresh")}
                disabled={busy}
                onClick={() => void action(onRefresh)}
              >
                <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
              </Button>
            </div>
          </header>
          <main id="main-content" tabIndex={-1} className="workspace-main">
            <Suspense fallback={<EmptyState>{t("loading")}</EmptyState>}>
              {error != null && (
                <Notice tone="error">{errorMessage(error, t)}</Notice>
              )}
              {projects.isPending ? (
                <EmptyState>{t("loading")}</EmptyState>
              ) : projects.error ? (
                <Notice tone="error">
                  {errorMessage(projects.error, t)}{" "}
                  <Button
                    variant="secondary"
                    onClick={() => void projects.refetch()}
                  >
                    {t("retry")}
                  </Button>
                </Notice>
              ) : projectId && !active ? (
                <EmptyState>
                  {t("errors.not-found")}{" "}
                  <Button
                    onClick={() =>
                      navigate({ projectId: null, tab: "overview" })
                    }
                  >
                    {t("projects")}
                  </Button>
                </EmptyState>
              ) : !projectId &&
                !["flows", "machines"].includes(location.tab) ? (
                <ProjectsView />
              ) : (
                <div
                  key={
                    scopeKey + ":" + (projectId ?? "hub") + ":" + location.tab
                  }
                >
                  <RemoteUpdates
                    projectIds={
                      projects.data?.projects.map((project) => project.id) ?? []
                    }
                  />
                  {views[location.tab]}
                </div>
              )}
            </Suspense>
          </main>
        </div>
      </div>
    </HubContext.Provider>
  );
}
export function App() {
  const { t } = useTranslation("common");
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [scopeKey, setScope] = useState(0);
  const [mode, setMode] = useState<"loading" | "sso" | "token">("loading");
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const principalRef = useRef(principal);
  principalRef.current = principal;
  const clear = () => {
    resetClient();
    void queryClient.cancelQueries();
    queryClient.clear();
    useDraftStore.getState().clearAll();
    resetNavigation();
    setPrincipal(null);
    setToken("");
    setScope((s) => s + 1);
  };
  const begin = async () => {
    setMode("loading");
    setError(null);
    try {
      const result = await bootstrap();
      setPrincipal(result.principal);
      setMode(result.sso ? "sso" : "token");
    } catch (e) {
      setError(e);
      setMode("sso");
    }
  };
  useEffect(() => {
    setAuthLossHandler((e) => {
      if (principalRef.current) {
        clear();
        setError(e);
        setMode("sso");
      }
    });
    void begin();
    return () => setAuthLossHandler(() => undefined);
  }, []);
  const refresh = async () => {
    const next = (await getJson<{ principal: Principal }>("/session"))
      .principal;
    if (next.id !== principalRef.current?.id) {
      clear();
      setPrincipal(next);
    } else setPrincipal(next);
    await queryClient.invalidateQueries();
  };
  const logout = async () => {
    const result = await deleteJson<{ ok: true; logoutUrl?: string }>(
      "/session",
    );
    clear();
    setMode("sso");
    if (result.logoutUrl) {
      const target = new URL(result.logoutUrl, window.location.origin);
      if (
        target.origin !== window.location.origin ||
        target.pathname !== "/cdn-cgi/access/logout" ||
        target.search ||
        target.hash
      )
        throw new ApiError(400, "invalid-logout", t("auth.safeLogout"));
      window.location.assign(target.href);
    }
  };
  const tokenLogin = async () => {
    setPending(true);
    setError(null);
    try {
      setPrincipal(
        (await postJson<{ principal: Principal }>("/session", { token }))
          .principal,
      );
      setToken("");
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <QueryClientProvider client={queryClient}>
      {principal ? (
        <Shell
          principal={principal}
          scopeKey={scopeKey}
          onRefresh={refresh}
          onLogout={logout}
        />
      ) : (
        <div className="min-h-screen bg-stone-50 p-5 sm:p-10">
          <div className="mx-auto flex max-w-6xl justify-between gap-4">
            <Brand />
            <div className="flex items-center gap-2">
              <ThemeSelect />
              <Locale />
            </div>
          </div>
          <main className="mx-auto mt-16 max-w-xl rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:mt-24 sm:p-12">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-800">
              {t("tagline")}
            </p>
            <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              {t("auth.title")}
            </h1>
            <p className="mb-7 mt-4 text-sm leading-relaxed text-slate-500">
              {t("auth.subtitle")}
            </p>
            {error != null && (
              <div className="mb-5">
                <Notice tone="error">{errorMessage(error, t)}</Notice>
              </div>
            )}
            {mode === "loading" ? (
              <p role="status" className="text-sm text-slate-500">
                {t("auth.checking")}
              </p>
            ) : mode === "token" ? (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (token.trim()) void tokenLogin();
                }}
                className="space-y-4"
              >
                <Field label={t("auth.token")} hint={t("auth.tokenHelp")}>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={pending || !token.trim()}>
                  {t("auth.signIn")}
                </Button>
              </form>
            ) : (
              <div className="space-y-4">
                <Button onClick={() => void begin()}>{t("retry")}</Button>
                <Button
                  variant="secondary"
                  onClick={() => window.location.assign(window.location.href)}
                >
                  {t("auth.reload")}
                </Button>
                <p className="text-xs leading-relaxed text-slate-500">
                  {t("auth.recovery")}
                </p>
              </div>
            )}
          </main>
        </div>
      )}
    </QueryClientProvider>
  );
}
