import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanEntry } from "../acp/types";
import { formatTokens } from "../lib/format";
import { setPrefs, usePrefs, MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Kbd, Spinner } from "../components/ui";
import { Composer, type ComposerHandle } from "./Composer";
import { ActivityPanel, type ActivityTab } from "./ActivityPanel";
import { runningSubagents } from "./activity";
import { isRunning } from "../acp/providers";
import { SessionInfoPanel } from "./SessionInfoPanel";
import { SessionSidebar } from "./SessionSidebar";
import { Transcript } from "./Transcript";
import { lostText, type QueuedPrompt, type Usage } from "./reducer";
import { resolveMode, resolveModel, type UiActions } from "./commandRunner";
import { modelOption, type useAcpSession } from "./useAcpSession";

type Session = ReturnType<typeof useAcpSession>;

interface Props {
  s: Session;
  cwd: string;
  projectName: string;
  onGoFlows: () => void;
  onGoSettings: () => void;
  narrow: boolean;
  /** Open the Providers dialog (`/connect`, `/search-provider`). */
  onProviders: (name: string, args: string) => void;
}

const SUGGESTIONS = [
  { icon: "file" as const, text: "Give me a short tour of this project: what it does and where the main entry points are." },
  { icon: "history" as const, text: "What changed in the last few commits, and is anything half-finished?" },
  { icon: "search" as const, text: "Find TODO and FIXME comments and group them by area." },
];

export const SessionView = forwardRef<ComposerHandle, Props>(function SessionView({ s, cwd, projectName, onGoFlows, onGoSettings, narrow, onProviders }, composerRef) {
  const { state } = s;
  const prefs = usePrefs();
  const sidebarOpen = prefs.sessionSidebar && !narrow;
  const [narrowSidebar, setNarrowSidebar] = useState(false);
  const [activity, setActivity] = useState<{ open: boolean; tab: ActivityTab; subagentId: string | null }>({ open: false, tab: "subagents", subagentId: null });
  // A sidebar click on another session's subagent loads that session first; the panel opens on it once it is shown.
  const pendingSubagent = useRef<{ sessionId: string; id: string } | null>(null);
  useEffect(() => {
    const p = pendingSubagent.current;
    if (p && p.sessionId === state.sessionId) {
      pendingSubagent.current = null;
      setActivity({ open: true, tab: "subagents", subagentId: p.id });
    } else setActivity((a) => (a.subagentId === null ? a : { ...a, subagentId: null }));
  }, [state.sessionId]);
  const activityApi = useMemo(() => ({ request: s.rpc, extensions: s.extensions }), [s.rpc, s.extensions]);
  const activityRunning = runningSubagents(state.subagents) + state.tasks.filter(isRunning).length;
  const showSubagent = useCallback((id: string) => setActivity({ open: true, tab: "subagents", subagentId: id }), []);
  const refreshTasks = useCallback(() => {
    if (state.sessionId) void s.refreshTasks(state.sessionId);
  }, [s, state.sessionId]);
  // The Activity panel and the info panel share the right column; an open Activity panel hides the info panel.
  // The side panel (D-13) takes the info dock's place while it is open.
  const infoOpen = prefs.infoPanel && !activity.open && !prefs.sidePanel;
  const ready = state.phase === "ready" && state.sessionId !== null && state.held;
  const incompatible = s.fatal?.kind === "incompatible" || s.fatal?.kind === "noShell";

  const disabledReason =
    incompatible
      ? "This keryx is not compatible with the app."
      : state.phase === "starting"
      ? "Starting keryx…"
      : state.phase === "exited"
        ? "keryx is not running. Restart it to continue."
        : state.replaying
            ? "Loading session…"
            : !state.sessionId
              ? state.opening
                ? "Opening a session…"
                : "No session. Start a new one to continue."
              : !state.held
                ? `${lostText(state.lostReason)}. Reopen it to continue.`
                : null;

  const fill = (text: string) => {
    const handle = composerRef && typeof composerRef !== "function" ? composerRef.current : null;
    handle?.setText(text);
  };

  const handle = () => (composerRef && typeof composerRef !== "function" ? composerRef.current : null);
  const focusSessions = useCallback(() => {
    if (narrow) setNarrowSidebar(true);
    else if (!prefs.sessionSidebar) setPrefs({ sessionSidebar: true });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-sidebar .session-item.is-current, .session-sidebar .session-item")?.focus());
  }, [narrow, prefs.sessionSidebar]);

  const ui: UiActions = {
    focusSessions,
    fillComposer: fill,
    openProviders: onProviders,
    mode: (arg) => {
      if (!arg) return handle()?.openMenu("mode");
      const id = resolveMode(state.modes, arg);
      if (id) void s.setMode(id);
      else s.notify("warn", `No mode named "${arg}". Modes: ${(state.modes?.availableModes ?? []).map((m) => m.id).join(", ")}.`);
    },
    model: (arg) => {
      const option = modelOption(state.configOptions);
      if (!arg) return handle()?.openMenu("model");
      const value = resolveModel(option, arg);
      if (option && value) void s.setModel(option.id, value);
      else s.notify("warn", `No model named "${arg}".`);
    },
  };
  const run = (line: string, opts: { display?: string; replaceId?: number } = {}) => s.runCommand(line, ui, opts);

  const empty = (
    <div className="session-empty">
      <div className="session-empty-mark" aria-hidden>
        k
      </div>
      <h1>What should we work on in {projectName}?</h1>
      <p>keryx reads the project, runs tools with your approval, and keeps sessions you can come back to.</p>
      <div className="suggestions">
        {SUGGESTIONS.map((sg) => (
          <button key={sg.text} className="suggestion" onClick={() => fill(sg.text)} disabled={!ready}>
            <Icon name={sg.icon} size={15} />
            <span>{sg.text}</span>
          </button>
        ))}
        <button className="suggestion" onClick={onGoFlows}>
          <Icon name="board" size={15} />
          <span>Pick up a flow from the board</span>
        </button>
      </div>
      <div className="shortcut-row">
        <span>
          <Kbd>{MOD}K</Kbd> commands
        </span>
        <span>
          <Kbd>{MOD}N</Kbd> new session
        </span>
        <span>
          <Kbd>/</Kbd> slash commands
        </span>
      </div>
    </div>
  );

  const sidebar = (
    <SessionSidebar
      sessions={state.sessions}
      marks={s.marks}
      loadingIds={state.loadingIds}
      currentId={state.sessionId}
      ready={state.phase === "ready" && !incompatible}
      canOrganize={state.canOrganize}
      onNew={() => void s.newSession()}
      onLoad={(id) => {
        setNarrowSidebar(false);
        void s.loadSession(id);
      }}
      onShowSubagent={(sessionId, id) => {
        setNarrowSidebar(false);
        if (sessionId === state.sessionId) showSubagent(id);
        else {
          pendingSubagent.current = { sessionId, id };
          void s.loadSession(sessionId);
        }
      }}
      onCollapse={() => (narrow ? setNarrowSidebar(false) : setPrefs({ sessionSidebar: false }))}
      onSetFlags={(id, change) => void s.setFlags(id, change)}
      onTrash={s.trashSession}
    />
  );

  return (
    <div className={`session-view${sidebarOpen ? " with-sidebar" : ""}${activity.open ? " with-activity" : ""}${infoOpen && !narrow ? " with-info" : ""}${narrow ? " is-narrow" : ""}`}>
      {sidebarOpen ? sidebar : null}
      {narrow && narrowSidebar ? (
        <div className="sidebar-float" onMouseDown={(e) => e.target === e.currentTarget && setNarrowSidebar(false)}>
          {sidebar}
        </div>
      ) : null}
      <section className="session-main" aria-label="Conversation">
        <div className="session-topbar">
          {!sidebarOpen ? (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => (narrow ? setNarrowSidebar(true) : setPrefs({ sessionSidebar: true }))}
              title="Show sessions"
            >
              <Icon name="list" size={14} /> Sessions
              {state.sessions.length ? <span className="tab-count">{state.sessions.length}</span> : null}
            </button>
          ) : null}
          <span className="grow" />
          {state.sessionId ? (
            <button
              className="btn btn-sm btn-ghost activity-toggle"
              onClick={() => setActivity((a) => ({ ...a, open: !a.open }))}
              aria-pressed={activity.open}
              title="Subagents and background tasks"
            >
              <Icon name="checklist" size={14} /> Activity
              {activityRunning > 0 ? <span className="tab-count" title="Running">{activityRunning}</span> : null}
            </button>
          ) : null}
        </div>

        {state.banners.length > 0 ? (
          <div className="session-banners">
            {state.banners.map((b) => (
              <div key={b.id} className={`inline-banner tone-${b.level === "error" ? "danger" : b.level === "warn" ? "warn" : "neutral"}`}>
                <Icon name={b.level === "info" ? "info" : "alert"} size={14} />
                <span>{b.text}</span>
                <button className="icon-btn icon-btn-sm" onClick={() => s.dismissBanner(b.id)} aria-label="Dismiss" title="Dismiss">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {state.phase === "exited" ? <ExitBanner exit={state.exit} onRestart={s.restart} /> : null}
        {state.phase === "ready" && state.sessionId && !state.held && !state.loadingIds.includes(state.sessionId) ? (
          <div className="session-banners">
            <div className="inline-banner tone-neutral">
              <Icon name="info" size={14} />
              <span>{lostText(state.lostReason)}. What you see is its last state.</span>
              <button className="btn btn-sm btn-primary" onClick={s.reopen}>
                <Icon name="refresh" size={13} /> Reopen
              </button>
            </div>
          </div>
        ) : null}
        {s.fatal && s.fatal.kind !== "leased" ? (
          <div className="session-banners">
            <div className="inline-banner tone-warn" role="alert">
              <Icon name="alert" size={14} />
              <span>
                {s.fatal.kind === "incompatible"
                  ? `This keryx (${s.fatal.found}) is older than the ${s.fatal.required} the app needs.`
                  : s.fatal.reason === "no-profile"
                    ? "This keryx has no shell profile, which the app runs on."
                    : "This keryx closes a session whenever another one opens, so the app cannot use it."}{" "}
                Nothing works until you pick another keryx.
              </span>
              <button className="btn btn-sm" onClick={onGoSettings}>
                Choose keryx
              </button>
              <button className="btn btn-sm btn-primary" onClick={s.restart}>
                <Icon name="refresh" size={13} /> Restart
              </button>
            </div>
          </div>
        ) : null}
        {state.phase === "starting" && !incompatible ? (
          <div className="session-banners">
            <div className="inline-banner tone-neutral">
              <Spinner size={13} />
              <span>Starting keryx in {projectName}…</span>
            </div>
          </div>
        ) : null}

        {/* Keyed by session: item ids restart in every session, so rows must not carry state across. */}
        <Transcript
          key={state.sessionId ?? ""}
          items={state.items}
          busy={state.busy}
          onRunCommand={(line, o) => run(line, o)}
          subagents={state.subagents}
          onShowSubagent={showSubagent}
          replaying={state.replaying || (state.sessionId === null && state.opening)}
          empty={state.phase === "ready" ? empty : null}
        />

        <div className="composer-dock">
          {state.plan.length > 0 ? <PlanCard plan={state.plan} /> : null}
          <QueueChips queue={state.queue} onRemove={s.removeQueued} />
          <Composer
            ref={composerRef}
            sessionId={state.sessionId}
            busy={state.busy}
            disabledReason={disabledReason}
            commands={state.commands}
            modes={state.modes}
            model={modelOption(state.configOptions)}
            sendKey={prefs.sendKey}
            onSend={(t) => run(t)}
            onStop={s.cancel}
            onMode={(id) => void s.setMode(id)}
            onModel={(c, v) => void s.setModel(c, v)}
            onProviders={() => onProviders("connect", "")}
          />
          <UsageFooter usage={state.usage} version={state.agentVersion} />
        </div>
      </section>
      {activity.open && state.sessionId ? (
        <ActivityPanel
          sessionId={state.sessionId}
          subagents={state.subagents}
          tasks={state.tasks}
          api={activityApi}
          tab={activity.tab}
          onTab={(tab) => setActivity((a) => ({ ...a, tab }))}
          subagentId={activity.subagentId}
          onSubagent={(subagentId) => setActivity((a) => ({ ...a, subagentId }))}
          onRefreshTasks={refreshTasks}
          onClose={() => setActivity((a) => ({ ...a, open: false }))}
        />
      ) : infoOpen ? (
        <div className={narrow ? "info-float" : "info-dock"}>
          <SessionInfoPanel state={state} cwd={cwd} projectName={projectName} onClose={() => setPrefs({ infoPanel: false })} />
        </div>
      ) : null}
    </div>
  );
});

function QueueChips({ queue, onRemove }: { queue: QueuedPrompt[]; onRemove: (index: number) => void }) {
  if (queue.length === 0) return null;
  return (
    <ul className="queue-chips" aria-label="Queued prompts">
      {queue.map((q, i) => (
        <li key={q.id} className="queue-chip" title={q.text}>
          <span className="queue-chip-n">{i + 1}</span>
          <span className="queue-chip-text truncate">{q.text}</span>
          <button className="icon-btn icon-btn-sm" onClick={() => onRemove(i)} aria-label={`Remove queued prompt ${i + 1}`} title="Remove">
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ExitBanner({ exit, onRestart }: { exit: { code: number | null; stderrTail: string } | null; onRestart: () => void }) {
  const [open, setOpen] = useState(false);
  const tail = exit?.stderrTail.trim() ?? "";
  return (
    <div className="session-banners">
      <div className="exit-banner" role="alert">
        <div className="exit-row">
          <Icon name="alert" size={15} />
          <span className="exit-text">
            <strong>keryx stopped</strong>
            {exit?.code != null ? <> with exit code {exit.code}</> : null}. Your sessions are saved.
          </span>
          {tail ? (
            <button className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide output" : "Show output"}
            </button>
          ) : null}
          <button className="btn btn-sm btn-primary" onClick={onRestart}>
            <Icon name="refresh" size={13} /> Restart
          </button>
        </div>
        {open && tail ? <pre className="exit-tail">{tail.split("\n").slice(-30).join("\n")}</pre> : null}
      </div>
    </div>
  );
}

const PLAN_ICON = { pending: "circle", in_progress: "circleDot", completed: "circleCheck" } as const;

function PlanCard({ plan }: { plan: PlanEntry[] }) {
  const [open, setOpen] = useState(true);
  const done = plan.filter((p) => p.status === "completed").length;
  const current = plan.find((p) => p.status === "in_progress");
  return (
    <div className={`plan-card${open ? " is-open" : ""}`}>
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="checklist" size={14} />
        <span className="plan-title">Plan</span>
        <span className="plan-count">
          {done}/{plan.length}
        </span>
        {!open && current ? <span className="plan-current truncate">{current.content}</span> : null}
        <span className="grow" />
        <Icon name={open ? "chevronDown" : "chevronUp"} size={13} />
      </button>
      {open ? (
        <ol className="plan-list">
          {plan.map((p, i) => (
            <li key={p._meta?.keryx?.id ?? i} className={`plan-item plan-${p.status}`}>
              <Icon name={PLAN_ICON[p.status] ?? "circle"} size={14} />
              <span>{p.content}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function pairText(p: { inputTokens: number; outputTokens: number }): string {
  return `${formatTokens(p.inputTokens)} in · ${formatTokens(p.outputTokens)} out`;
}

function UsageFooter({ usage, version }: { usage: Usage | null; version: string | null }) {
  const parts = useMemo(() => {
    if (!usage) return null;
    const ctx = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
    return { ctx };
  }, [usage]);
  if (!usage || !parts) return <div className="usage-footer">{version ? <span>keryx {version}</span> : null}</div>;
  const turnTitle = usage.turn ? `This turn: ${pairText(usage.turn)}` : undefined;
  return (
    <div className="usage-footer">
      {parts.ctx !== null ? (
        <span className="usage-ctx" title={`Last model call used ${formatTokens(usage.used)} of a ${formatTokens(usage.size)} token context window`}>
          <span className="usage-meter" aria-hidden>
            <span style={{ width: `${parts.ctx}%` }} />
          </span>
          {parts.ctx}% context
        </span>
      ) : null}
      {usage.session ? <span title={turnTitle}>Session {pairText(usage.session)}</span> : <span title={turnTitle}>{formatTokens(usage.used)} tokens last call</span>}
      {usage.cost ? (
        <span>
          {usage.cost.amount.toFixed(4)} {usage.cost.currency}
        </span>
      ) : null}
      <span className="grow" />
      {version ? <span>keryx {version}</span> : null}
    </div>
  );
}
