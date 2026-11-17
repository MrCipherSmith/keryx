import { forwardRef, useMemo, useState } from "react";
import type { PlanEntry } from "../acp/types";
import { formatTokens } from "../lib/format";
import { setPrefs, usePrefs, MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Kbd, Spinner } from "../components/ui";
import { Composer, type ComposerHandle } from "./Composer";
import { SessionSidebar } from "./SessionSidebar";
import { Transcript } from "./Transcript";
import type { Usage } from "./reducer";
import { modelOption, type useAcpSession } from "./useAcpSession";

type Session = ReturnType<typeof useAcpSession>;

interface Props {
  s: Session;
  projectName: string;
  onGoFlows: () => void;
  narrow: boolean;
}

const SUGGESTIONS = [
  { icon: "file" as const, text: "Give me a short tour of this project: what it does and where the main entry points are." },
  { icon: "history" as const, text: "What changed in the last few commits, and is anything half-finished?" },
  { icon: "search" as const, text: "Find TODO and FIXME comments and group them by area." },
];

export const SessionView = forwardRef<ComposerHandle, Props>(function SessionView({ s, projectName, onGoFlows, narrow }, composerRef) {
  const { state } = s;
  const prefs = usePrefs();
  const sidebarOpen = prefs.sessionSidebar && !narrow;
  const [narrowSidebar, setNarrowSidebar] = useState(false);
  const ready = state.phase === "ready" && state.sessionId !== null && state.held;
  const incompatible = s.fatal?.kind === "incompatible" || s.fatal?.kind === "noShell";

  const disabledReason =
    state.phase === "starting"
      ? "Starting keryx…"
      : state.phase === "exited"
        ? "keryx is not running. Restart it to continue."
        : incompatible
          ? "This keryx is not compatible with the app."
          : state.replaying
            ? "Loading session…"
            : !state.sessionId
              ? state.opening
                ? "Opening a session…"
                : "No session. Start a new one to continue."
              : !state.held
                ? "keryx closed this idle session to save memory. Reopen it to continue."
                : null;

  const fill = (text: string) => {
    const handle = composerRef && typeof composerRef !== "function" ? composerRef.current : null;
    handle?.setText(text);
  };

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
      onNew={() => void s.newSession()}
      onLoad={(id) => {
        setNarrowSidebar(false);
        void s.loadSession(id);
      }}
      onCollapse={() => (narrow ? setNarrowSidebar(false) : setPrefs({ sessionSidebar: false }))}
    />
  );

  return (
    <div className={`session-view${sidebarOpen ? " with-sidebar" : ""}`}>
      {sidebarOpen ? sidebar : null}
      {narrow && narrowSidebar ? (
        <div className="sidebar-float" onMouseDown={(e) => e.target === e.currentTarget && setNarrowSidebar(false)}>
          {sidebar}
        </div>
      ) : null}
      <section className="session-main" aria-label="Conversation">
        {!sidebarOpen ? (
          <div className="session-topbar">
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => (narrow ? setNarrowSidebar(true) : setPrefs({ sessionSidebar: true }))}
              title="Show sessions"
            >
              <Icon name="list" size={14} /> Sessions
              {state.sessions.length ? <span className="tab-count">{state.sessions.length}</span> : null}
            </button>
          </div>
        ) : null}

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
              <span>keryx closed this idle session to save memory. What you see is its last state.</span>
              <button className="btn btn-sm btn-primary" onClick={s.reopen}>
                <Icon name="refresh" size={13} /> Reopen
              </button>
            </div>
          </div>
        ) : null}
        {state.phase === "starting" ? (
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
          replaying={state.replaying || (state.sessionId === null && state.opening)}
          empty={state.phase === "ready" ? empty : null}
        />

        <div className="composer-dock">
          {state.plan.length > 0 ? <PlanCard plan={state.plan} /> : null}
          <Composer
            ref={composerRef}
            busy={state.busy}
            disabledReason={disabledReason}
            commands={state.commands}
            modes={state.modes}
            model={modelOption(state.configOptions)}
            sendKey={prefs.sendKey}
            onSend={(t) => s.sendPrompt(t)}
            onStop={s.cancel}
            onMode={(id) => void s.setMode(id)}
            onModel={(c, v) => void s.setModel(c, v)}
          />
          <UsageFooter usage={state.usage} version={state.agentVersion} />
        </div>
      </section>
    </div>
  );
});

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
