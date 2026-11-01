import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Monitor,
  MessageSquare,
  ArrowUpRight,
  Circle,
} from "lucide-react";
import type {
  MachineSummary,
  RunRecord,
} from "../../../../../src/remote-control/protocol";
import type { Control } from "../../api/remote";
import { remoteGet, remoteProject } from "../../api/remote";
import { sessionPath, useRemoteQuery } from "../../api/remote-hooks";
import { useHub } from "../../app/hub-context";
import { Button, EmptyState, Input, Notice } from "../../components/ui";
import { ControllerPanel } from "./recovery";
import { Feedback, type Controller } from "./shared";
import { SessionRunContext } from "./session-run-context";
import "./session-workspace.css";

const copy = {
  en: {
    navigation: "Project sessions",
    search: "Find a session…",
    all: "All sessions",
    context: "Context",
    changes: "Changes",
    checks: "Checks",
    queue: "Queue",
    settings: "Settings",
    session: "Session",
    openRun: "Current run",
    attention: "Action required in the current run",
    noMatch: "No sessions match this search.",
    observer: "Observer",
    controlled: "You control",
    idle: "No current run",
    routing: "Baseline model",
    runModel: "Run model",
    stale: "Machine is offline. This is the last observed session state.",
    navigationPartial: "More sessions are available.",
    role: {
      human: "Human",
      assistant: "Keryx",
      "tool-summary": "Tool activity",
      "system-receipt": "System receipt",
    },
  },
  ru: {
    navigation: "Сессии проекта",
    search: "Найти сессию…",
    all: "Все сессии",
    context: "Контекст",
    changes: "Изменения",
    checks: "Проверки",
    queue: "Очередь",
    settings: "Настройки",
    session: "Сессия",
    openRun: "Текущий запуск",
    attention: "В текущем запуске требуется действие",
    noMatch: "По этому запросу сессий нет.",
    observer: "Наблюдение",
    controlled: "Вы управляете",
    idle: "Нет текущего запуска",
    routing: "Базовая модель",
    runModel: "Модель запуска",
    stale:
      "Машина не в сети. Показано последнее наблюдавшееся состояние сессии.",
    navigationPartial: "Есть ещё сессии.",
    role: {
      human: "Человек",
      assistant: "Keryx",
      "tool-summary": "Действия инструментов",
      "system-receipt": "Квитанция системы",
    },
  },
};
export function useWorkspaceCopy() {
  const { i18n } = useTranslation();
  return copy[i18n.language.startsWith("ru") ? "ru" : "en"];
}
export function SessionWorkspace({
  record,
  control,
  history,
  composer,
  queue,
  settings,
  operations,
}: {
  record: Control["SessionRecord"];
  control: Controller;
  history: ReactNode;
  composer: ReactNode;
  queue: ReactNode;
  settings: ReactNode;
  operations: ReactNode;
}) {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const words = useWorkspaceCopy();
  const [tab, setTab] = useState<
    "context" | "changes" | "checks" | "queue" | "settings"
  >("context");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [record.sessionId]);
  const machines = useRemoteQuery<{ machines: MachineSummary[] }>(
    ["machines"],
    "/machines?projectId=" + encodeURIComponent(record.projectId),
  );
  const machine = machines.data?.machines.find(
    (m) => m.machineId === record.machineId,
  );
  const checkout = machine?.inventory?.checkouts.find(
    (c) =>
      c.projectId === record.projectId && c.checkoutId === record.checkoutId,
  );
  const routing = useRemoteQuery<Control["RoutingAvailability"]>(
    ["routing", record.sessionId],
    sessionPath(record.projectId, record.sessionId) + "/routing",
  );
  const run = useRemoteQuery<RunRecord>(
    ["run", record.activeRunId],
    remoteProject(record.projectId) +
      "/runs/" +
      encodeURIComponent(record.activeRunId ?? ""),
    !!record.activeRunId,
  );
  const candidateId =
    run.data?.snapshot.effectiveCandidateId ??
    record.config.baselineCandidateId;
  const candidate = routing.data?.candidates.find(
    (c) => c.candidateId === candidateId,
  );
  const tabs = ["context", "changes", "checks", "queue", "settings"] as const;
  return (
    <section className="session-workbench">
      <header className="session-workbench-header">
        <div className="session-identity">
          <MessageSquare size={18} />
          <div>
            <h1 ref={titleRef} tabIndex={-1}>
              {record.title}
            </h1>
            <div className="session-header-meta">
              <span>
                {t("states." + record.state, { defaultValue: record.state })}
              </span>
              <span>{record.agentProfileId}</span>
              <span>{control.active ? words.controlled : words.observer}</span>
            </div>
          </div>
        </div>
        <div className="session-header-actions">
          <Button
            variant="secondary"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen(!navigationOpen)}
          >
            {words.navigation}
            <ChevronDown size={13} />
          </Button>
          {record.activeRunId && (
            <Button
              variant="ghost"
              onClick={() =>
                hub.navigate({
                  tab: "runs",
                  runId: record.activeRunId ?? undefined,
                  sessionId: undefined,
                })
              }
            >
              {words.openRun}
              <ArrowUpRight size={13} />
            </Button>
          )}
        </div>
      </header>
      <div className="session-location">
        <Monitor size={13} />
        <span>{machine?.displayName ?? record.machineId}</span>
        <span>/</span>
        <span>{checkout?.label ?? record.checkoutId}</span>
        <span className="session-model" title={candidateId}>
          {run.data ? words.runModel : words.routing}:{" "}
          {candidate
            ? candidate.providerId + " / " + candidate.modelId
            : candidateId.slice(0, 12)}
        </span>
      </div>
      {machine && !machine.connected && <Notice>{words.stale}</Notice>}
      {run.data?.state === "waiting-approval" && (
        <button
          type="button"
          className="session-attention"
          onClick={() => {
            setTab("context");
            document
              .getElementById(id + "-inspector")
              ?.scrollIntoView({ block: "start" });
            document.getElementById(id + "-context")?.focus();
          }}
        >
          {words.attention}
          <ArrowUpRight size={14} />
        </button>
      )}
      <div className="session-workbench-grid">
        <aside
          aria-label={words.navigation}
          className={
            "session-browser " + (navigationOpen ? "session-browser-open" : "")
          }
        >
          <SessionNavigator
            record={record}
            machines={machines.data?.machines ?? []}
            onPick={() => setNavigationOpen(false)}
          />
        </aside>
        <div className="session-conversation-column">
          {history}
          <div className="session-composer">{composer}</div>
        </div>
        <aside id={id + "-inspector"} className="session-context-column">
          <ControllerPanel record={record} control={control} />
          <div
            className="session-tabs"
            role="tablist"
            aria-label={words.session}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[role=tab]",
                ),
              ];
              const current = buttons.findIndex(
                (button) => button === document.activeElement,
              );
              if (current < 0) return;
              event.preventDefault();
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (current +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
              buttons[index]?.click();
              buttons[index]?.focus();
            }}
          >
            {tabs.map((value) => (
              <button
                type="button"
                key={value}
                id={id + "-" + value}
                role="tab"
                aria-selected={tab === value}
                aria-controls={
                  id +
                  "-panel-" +
                  (value === "context" ||
                  value === "changes" ||
                  value === "checks"
                    ? "run"
                    : value)
                }
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
              >
                {words[value]}
              </button>
            ))}
          </div>
          <div
            hidden={!["context", "changes", "checks"].includes(tab)}
            role="tabpanel"
            aria-labelledby={id + "-" + tab}
            id={id + "-panel-run"}
          >
            <SessionRunContext
              record={record}
              control={control}
              mode={tab === "changes" || tab === "checks" ? tab : "context"}
            />
          </div>
          <div
            hidden={tab !== "queue"}
            role="tabpanel"
            aria-labelledby={id + "-queue"}
            id={id + "-panel-queue"}
          >
            {queue}
          </div>
          <div
            hidden={tab !== "settings"}
            role="tabpanel"
            aria-labelledby={id + "-settings"}
            id={id + "-panel-settings"}
            className="session-configuration"
          >
            {settings}
            {operations}
          </div>
        </aside>
      </div>
    </section>
  );
}
function SessionNavigator({
  record,
  machines,
  onPick,
}: {
  record: Control["SessionRecord"];
  machines: MachineSummary[];
  onPick: () => void;
}) {
  const hub = useHub();
  const words = useWorkspaceCopy();
  const { t } = useTranslation("remote");
  const [search, setSearch] = useState("");
  const sessions = useInfiniteQuery({
    queryKey: [
      hub.scopeKey,
      record.projectId,
      "remote",
      "sessions",
      "navigator",
    ],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      remoteGet<Control["SessionPage"]>(
        remoteProject(record.projectId) + "/sessions?after=" + pageParam,
        signal,
      ),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
  });
  const unique = new Map<string, Control["SessionRecord"]>();
  sessions.data?.pages.forEach((page) =>
    page.sessions.forEach((s) => {
      const old = unique.get(s.sessionId);
      if (!old || old.version <= s.version) unique.set(s.sessionId, s);
    }),
  );
  unique.set(record.sessionId, record);
  const filtered = [...unique.values()].filter((s) =>
    s.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const groups = new Map<string, Control["SessionRecord"][]>();
  filtered.forEach((s) => {
    const key = s.machineId + ":" + s.checkoutId;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  });
  return (
    <>
      <div className="session-browser-title">
        <h2>{words.navigation}</h2>
        <Button
          variant="ghost"
          onClick={() =>
            hub.navigate({ tab: "sessions", sessionId: undefined })
          }
        >
          {words.all}
        </Button>
      </div>
      <Input
        type="search"
        aria-label={words.search}
        placeholder={words.search}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Feedback query={sessions} />
      {[...groups].map(([key, items]) => {
        const sample = items[0]!;
        const machine = machines.find((m) => m.machineId === sample.machineId);
        const checkout = machine?.inventory?.checkouts.find(
          (c) =>
            c.projectId === record.projectId &&
            c.checkoutId === sample.checkoutId,
        );
        return (
          <section key={key} className="session-browser-group">
            <h3>
              <Monitor size={12} />
              {machine?.displayName ?? sample.machineId}
              <span>{checkout?.label ?? sample.checkoutId}</span>
            </h3>
            {items.map((s) => (
              <button
                type="button"
                key={s.sessionId}
                aria-current={
                  s.sessionId === record.sessionId ? "page" : undefined
                }
                className={
                  "session-browser-item " +
                  (s.sessionId === record.sessionId ? "selected" : "")
                }
                onClick={() => {
                  hub.navigate({
                    projectId: s.projectId,
                    tab: "sessions",
                    sessionId: s.sessionId,
                    runId: undefined,
                  });
                  onPick();
                }}
              >
                <span>{s.title}</span>
                <small>
                  <Circle size={6} />
                  {t("states." + s.state, { defaultValue: s.state })}
                </small>
              </button>
            ))}
          </section>
        );
      })}
      {!filtered.length && !sessions.isPending && !sessions.error && (
        <EmptyState>{words.noMatch}</EmptyState>
      )}
      {sessions.hasNextPage && (
        <Button
          variant="secondary"
          disabled={sessions.isFetchingNextPage}
          onClick={() => void sessions.fetchNextPage()}
        >
          {t("more")}
        </Button>
      )}
    </>
  );
}
