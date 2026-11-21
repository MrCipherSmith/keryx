import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { lookupWithRetry } from "../lib/repoLookup";
import { BrandMark } from "../components/BrandMark";
import { createPortal } from "react-dom";
import type { PlanEntry } from "../acp/types";
import { errMessage, formatTokens } from "../lib/format";
import { setPrefs, usePrefs, MOD, SESSION_SIDEBAR_MIN } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Dialog, Kbd, Spinner } from "../components/ui";
import { Composer, type ComposerHandle } from "./Composer";
import { ActivityPanel, type ActivityTab } from "./ActivityPanel";
import { runningSubagents } from "./activity";
import { isRunning } from "../acp/providers";
import { setActivityRunning, useSlot } from "../panels/sideSlots";
import { clearPicks, onPicksChange, pickLabel, picksBlock, picksOf, removePick } from "../panels/elementPicks";
import { GitStatus } from "./GitStatus";
import { SessionInfoPanel } from "./SessionInfoPanel";
import { SessionSidebar } from "./SessionSidebar";
import { SubagentArchive } from "./SubagentArchive";
import { Transcript } from "./Transcript";
import type { LocalAttachment } from "./chatImages";
import { textWithLineComments, type LineComment } from "./lineComments";
import { ChangesPanel } from "../panels/ChangesPanel";
import { userPromptContext, type UserPromptContext } from "./userPrompt";
import { findCommand } from "../acp/commands";
import { commitChatAttachments, discardChatAttachment, gitRepository, openPullRequest, pickFolder, projectFiles, saveChatFile, saveChatImage } from "../platform/commands";
import { isTauri } from "../platform/backend";
import { browserOpen } from "../platform/panels";
import type { PrLinks } from "../components/prLinks";
import { lostText, type QueuedPrompt, type Usage } from "./reducer";
import { desktopReviewRequest, resolveMode, resolveModel, type UiActions } from "./commandRunner";
import { modelOption, type useAcpSession } from "./useAcpSession";
import type { ProjectGitHubAccount } from "../platform/githubAccounts";
import { reviewSessionTitle, type ReviewComposerTarget, type SessionReviewLink } from "../review/sessionReview";
import { ProjectGitHubAccountButton } from "../project/GitHubSettings";

type Session = ReturnType<typeof useAcpSession>;

interface Props {
  s: Session;
  cwd: string;
  projectName: string;
  onGoFlows: () => void;
  onGoSettings: () => void;
  githubAccount?: ProjectGitHubAccount;
  onProjectSettings?: () => void;
  narrow: boolean;
  reviewActivity?: ReactNode;
  reviewComposer?: ReviewComposerTarget | undefined;
  reviewLinks?: readonly SessionReviewLink[];
  /** Open the Providers dialog (`/connect`, `/search-provider`). */
  onProviders: (name: string, args: string) => void;
}

const SUGGESTIONS = [
  { icon: "file" as const, text: "Give me a short tour of this project: what it does and where the main entry points are." },
  { icon: "history" as const, text: "What changed in the last few commits, and is anything half-finished?" },
  { icon: "search" as const, text: "Find TODO and FIXME comments and group them by area." },
];

export const SessionView = forwardRef<ComposerHandle, Props>(function SessionView({ s, cwd, projectName, onGoFlows, onGoSettings, githubAccount, onProjectSettings, narrow, onProviders, reviewActivity, reviewComposer, reviewLinks }, composerRef) {
  const { state } = s;
  const reviewBySession = useMemo(() => new Map((reviewLinks ?? []).map(link => [link.sessionId, link])), [reviewLinks]);
  const prefs = usePrefs();
  const sidebarOpen = prefs.sessionSidebar && !narrow;
  // The sidebar floats over the conversation when it is not docked: opened by the Sessions button
  // ("pinned", stays until dismissed) or by the pointer reaching the window's left edge ("hover",
  // closes when the pointer leaves it), as the Claude app does.
  const [floating, setFloating] = useState<"pinned" | "hover" | null>(null);
  const narrowSidebar = floating !== null;
  const setNarrowSidebar = useCallback((open: boolean) => setFloating(open ? "pinned" : null), []);
  // Activity lives in the window's side panel (a tab beside Terminal and Browser); what it shows is kept here.
  const [activity, setActivity] = useState<{ tab: ActivityTab; subagentId: string | null }>({ tab: "subagents", subagentId: null });
  const activityOpen = prefs.sidePanel === "activity";
  const openActivity = useCallback(() => setPrefs({ sidePanel: "activity" }), []);
  const activitySlot = useSlot("activity");
  const infoSlot = useSlot("info");
  const changesSlot = useSlot("changes");
  const sessionControls = useSlot("sessionControls");
  // A sidebar click on another session's subagent loads that session first; the panel opens on it once it is shown.
  const pendingSubagent = useRef<{ sessionId: string; id: string } | null>(null);
  useEffect(() => {
    const p = pendingSubagent.current;
    if (p && p.sessionId === state.sessionId) {
      pendingSubagent.current = null;
      setActivity({ tab: "subagents", subagentId: p.id });
      openActivity();
    } else setActivity((a) => (a.subagentId === null ? a : { ...a, subagentId: null }));
  }, [state.sessionId]);
  const activityApi = useMemo(() => ({ request: s.rpc, extensions: s.extensions }), [s.rpc, s.extensions]);
  const activityRunning = runningSubagents(state.subagents) + state.tasks.filter(isRunning).length;
  useEffect(() => {
    setActivityRunning(activityRunning);
    return () => setActivityRunning(0);
  }, [activityRunning]);
  // A subagent's entry opens the side panel on Activity; a `/delegate` run's detail has an "Open terminal" button.
  const showSubagent = useCallback(
    (id: string) => {
      setActivity({ tab: "subagents", subagentId: id });
      openActivity();
    },
    [openActivity],
  );
  const refreshTasks = useCallback(() => {
    if (state.sessionId) void s.refreshTasks(state.sessionId);
  }, [s, state.sessionId]);
  const ready = state.phase === "ready" && state.sessionId !== null && state.held;
  const incompatible = s.fatal?.kind === "incompatible" || s.fatal?.kind === "noShell";

  const replyTarget = reviewComposer?.sessionId === state.sessionId ? reviewComposer : undefined;
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
                : replyTarget?.disabledReason ?? null;

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

  // One confirmation at a time: a command answered with a draft to confirm (`confirmAction`).
  const [ask, setAsk] = useState<{ label: string; confirm: string; resolve: (yes: boolean) => void } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  const confirm = useCallback(
    (q: { label: string; confirm: string }) =>
      new Promise<boolean>((resolve) => {
        askRef.current?.resolve(false);
        setAsk({ ...q, resolve });
      }),
    [],
  );
  const answer = (yes: boolean) => {
    askRef.current?.resolve(yes);
    setAsk(null);
  };

  const ui: UiActions = {
    confirm,
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
  const toast = useToast();
  const [repo, setRepo] = useState<{ cwd: string; name: string | null } | null>(null);
  // Only a real answer is remembered: a rejection (for example "busy") is retried with jitter and, if it never
  // succeeds, the repository simply stays unknown rather than being cached as "no GitHub remote".
  useEffect(() => lookupWithRetry(() => gitRepository(cwd), (name) => setRepo({ cwd, name })), [cwd]);
  const prLinks = useMemo<PrLinks>(() => ({
    repository: repo?.cwd === cwd ? repo.name ?? undefined : undefined,
    openExternal: (url) => void openPullRequest(url).catch((e) =>
      toast({ level: "error", title: "Could not open pull request", body: errMessage(e) })),
    openInternal: isTauri() ? (url) => void browserOpen(cwd, url).then(
      () => setPrefs({ sidePanel: "browser" }),
      (e) => toast({ level: "error", title: "Could not open Keryx Browser", body: errMessage(e) }),
    ) : undefined,
  }), [cwd, repo, toast]);
  // Page elements picked in the browser panel go out with the next message (not with a command line).
  const picks = useSyncExternalStore(onPicksChange, () => picksOf(cwd));
  const attachments = useMemo(() => picks.map((p) => ({ key: p.key, label: pickLabel(p), title: `${p.selector}\n${p.url}` })), [picks]);
  const send = async (text: string, imagePaths: readonly string[], local: readonly LocalAttachment[], lineComments: readonly LineComment[] = []) => {
    const hasLocal = imagePaths.length > 0 || local.length > 0 || lineComments.length > 0;
    if (replyTarget) {
      if (hasLocal || picks.length) {
        toast({ level: "info", title: "Send review context as text", body: "Remove the attachments before sending the reply." });
        return false;
      }
      return replyTarget.send(text);
    }
    // An unrecognized slash line never sends and never clears staged page picks.
    const reviewRequest = desktopReviewRequest(text);
    if ((text.startsWith("/") || reviewRequest) && !hasLocal) return run(text);
    const command = findCommand(state.commands, text);
    if ((command || reviewRequest) && hasLocal) {
      toast({ level: "info", title: "Commands cannot carry attachments", body: "Remove the attachments or send a normal chat message." });
      return false;
    }
    if (!picks.length && !hasLocal) return run(text);
    // The picks travel as their own block, marked untrusted, never as the user's text. While a turn
    // runs this returns false and the draft and picks stay for the next send.
    const sent = picks;
    // Line comments are plain text of the message itself: no resource block, nothing marked untrusted.
    const context = userPromptContext(imagePaths, local, sent.length ? { count: sent.length, block: picksBlock(sent) } : undefined);
    const ok = s.sendPrompt(textWithLineComments(text, lineComments), undefined, context, true);
    if (ok && sent.length) clearPicks(cwd, sent);
    else if (!ok && state.busy) toast({ level: "info", title: "Attachments wait for this turn", body: "Send again when keryx finishes; your draft is kept." });
    return ok;
  };

  const sendPrompt = s.sendPrompt;
  const editMessage = useCallback(
    (text: string, context?: UserPromptContext, replaces?: number) => {
      const ok = sendPrompt(text, undefined, context, true, replaces);
      if (!ok) toast({ level: "error", title: "Could not send the edited message" });
      else {
        // After the row's own focus handling has run (it returns focus to its Edit button), the composer takes it.
        const composer = composerRef && typeof composerRef !== "function" ? composerRef : null;
        requestAnimationFrame(() => composer?.current?.focus());
      }
      return ok;
    },
    [sendPrompt, toast, composerRef],
  );

  const empty = (
    <div className="session-empty">
      <BrandMark className="session-empty-mark" />
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

  /** Drag the docked sidebar's edge: its width follows the pointer, between 200 px and a fifth of the window. */
  const startSidebarResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = (target.parentElement?.offsetWidth ?? prefs.sessionSidebarWidth);
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const max = Math.max(SESSION_SIDEBAR_MIN, Math.floor(window.innerWidth / 5));
      setPrefs({ sessionSidebarWidth: Math.round(Math.min(max, Math.max(SESSION_SIDEBAR_MIN, startW + ev.clientX - startX))) });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }, [prefs.sessionSidebarWidth]);

  const showSessions = useRef<HTMLButtonElement>(null);
  const [archive, setArchive] = useState<{ cwd: string; id: string; title: string } | null>(null);
  useEffect(() => setArchive(null), [cwd]);
  function openArchive(id: string, title: string) {
    // Its row disappears with the floating sidebar. Give the dialog a mounted focus return target.
    if (!sidebarOpen) showSessions.current?.focus();
    setArchive({ cwd, id, title });
    setNarrowSidebar(false);
    if (!s.marks[id]?.held) void s.loadSession(id);
  }
  const sidebar = (
    <SessionSidebar
      sessions={state.sessions.map(session => {
        const title = reviewSessionTitle(session.title, reviewBySession.get(session.sessionId));
        return title === session.title ? session : { ...session, title };
      })}
      marks={Object.fromEntries(Object.entries(s.marks).map(([sessionId, mark]) => {
        const title = reviewSessionTitle(mark.title, reviewBySession.get(sessionId)) ?? mark.title;
        return [sessionId, title === mark.title ? mark : { ...mark, title }];
      }))}
      loadingIds={state.loadingIds}
      currentId={state.sessionId}
      ready={state.phase === "ready" && !incompatible}
      canOrganize={state.canOrganize}
      onNew={() => void s.newSession()}
      onLoad={(id) => {
        setNarrowSidebar(false);
        void s.loadSession(id);
      }}
      onOpenArchive={openArchive}
      onShowSubagent={(sessionId, id) => {
        setNarrowSidebar(false);
        if (sessionId === state.sessionId) showSubagent(id);
        else {
          pendingSubagent.current = { sessionId, id };
          void s.loadSession(sessionId);
        }
      }}
      onCollapse={() => (sidebarOpen ? setPrefs({ sessionSidebar: false }) : setNarrowSidebar(false))}
      {...(sidebarOpen ? { onResizeStart: startSidebarResize } : {})}
      onSetFlags={(id, change) => void s.setFlags(id, change)}
      onTrash={s.trashSession}
    />
  );

  return (
    <div
      className={`session-view${sidebarOpen ? " with-sidebar" : ""}${narrow ? " is-narrow" : ""}`}
      style={{ "--sidebar-w": `${prefs.sessionSidebarWidth}px` } as React.CSSProperties}>
      {archive?.cwd === cwd && <SubagentArchive key={archive.id} title={archive.title}
        subagents={s.marks[archive.id]?.subagents ?? []} loading={state.loadingIds.includes(archive.id)}
        unavailable={!s.marks[archive.id]?.held} onRetry={() => void s.loadSession(archive.id)} onClose={() => setArchive(null)} />}
      {sidebarOpen ? sidebar : null}
      {!sidebarOpen && floating === null ? (
        <div className="sidebar-hover-zone" aria-hidden="true" onMouseEnter={() => setFloating("hover")} />
      ) : null}
      {!sidebarOpen && narrowSidebar ? (
        <div
          className={`sidebar-float${floating === "hover" ? " is-hover" : ""}`}
          onMouseDown={(e) => e.target === e.currentTarget && setNarrowSidebar(false)}
        >
          <div className="sidebar-float-panel" onMouseLeave={() => floating === "hover" && setFloating(null)}>
            {sidebar}
          </div>
        </div>
      ) : null}
      <section className="session-main" aria-label="Conversation">
        {sessionControls && createPortal(<>
          {!sidebarOpen ? (
            <button
              className="icon-btn titlebar-toggle"
              onClick={() => (narrow ? setNarrowSidebar(true) : (setFloating(null), setPrefs({ sessionSidebar: true })))}
              ref={showSessions}
              aria-label="Show sessions"
              title="Show sessions"
            >
              <Icon name="list" size={15} />
            </button>
          ) : null}
        </>, sessionControls)}

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
          reviewActivity={reviewActivity}
          onRunCommand={(line, o) => run(line, o)}
          prLinks={prLinks}
          onEditMessage={disabledReason === null && !state.busy ? editMessage : undefined}
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
            replyPlaceholder={replyTarget?.placeholder}
            replyDraftKey={replyTarget?.draftKey}
            commands={state.commands}
            modes={state.modes}
            model={modelOption(state.configOptions)}
            sendKey={prefs.sendKey}
            onSend={send}
            saveImage={saveChatImage}
            saveFile={saveChatFile}
            discardFile={discardChatAttachment}
            onAttachmentsSent={(paths) => void commitChatAttachments([...paths]).catch(() =>
              toast({ level: "error", title: "Attachments may not be kept", body: "Sent files could not be saved for later; previews may disappear after you close this window." }))}
            pickAttachmentFolder={() => pickFolder("Add folder to message")}
            searchFiles={(q) => projectFiles(cwd, q).then((r) => r.files.slice(0, 200))}
            attachments={attachments}
            onRemoveAttachment={(key) => removePick(cwd, key)}
            onStop={s.cancel}
            onMode={(id) => void s.setMode(id)}
            onModel={(c, v) => void s.setModel(c, v)}
            onProviders={() => onProviders("connect", "")}
            usage={state.usage}
            onCompact={() => void run("/compact")}
            onDetails={() => setPrefs({ sidePanel: "info" })}
          />
          <UsageFooter githubAccount={githubAccount} onAccountClick={onProjectSettings} usage={state.usage} version={state.agentVersion} cwd={cwd} busy={state.busy} />
        </div>
      </section>
      {ask ? (
        <Dialog
          title="Confirm"
          icon="alert"
          tone="warn"
          onClose={() => answer(false)}
          footer={
            <>
              <button className="btn" onClick={() => answer(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" data-autofocus onClick={() => answer(true)}>
                {ask.label}
              </button>
            </>
          }
        >
          <pre className="out-pre command-out">{ask.confirm}</pre>
        </Dialog>
      ) : null}
      {activityOpen && activitySlot && state.sessionId
        ? createPortal(
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
              githubAccount={githubAccount}
              onProjectSettings={onProjectSettings}
            />,
            activitySlot,
          )
        : null}
      {prefs.sidePanel === "changes" && changesSlot ? createPortal(
        <ChangesPanel cwd={cwd} busy={state.busy} canComment={ready} onComment={(c) => handle()?.addLineComment(c) ?? false} />, changesSlot) : null}
      {prefs.sidePanel === "info" && infoSlot ? createPortal(<SessionInfoPanel state={state} cwd={cwd} projectName={projectName} />, infoSlot) : null}
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

function UsageFooter({ usage, version, cwd, busy, githubAccount, onAccountClick }: {
  usage: Usage | null; version: string | null; cwd: string; busy: boolean;
  githubAccount?: ProjectGitHubAccount; onAccountClick?: () => void;
}) {
  const ctx = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
  const turnTitle = usage?.turn ? `This turn: ${pairText(usage.turn)}` : undefined;
  return (
    <div className="usage-footer">
      {usage && ctx !== null ? (
        <span className="usage-ctx" title={`Last model call used ${formatTokens(usage.used)} of a ${formatTokens(usage.size)} token context window`}>
          <span className="usage-meter" aria-hidden>
            <span style={{ width: `${ctx}%` }} />
          </span>
          {ctx}% context
        </span>
      ) : null}
      {usage && (usage.session ? <span title={turnTitle}>Session {pairText(usage.session)}</span> : <span title={turnTitle}>{formatTokens(usage.used)} tokens last call</span>)}
      {usage?.cost ? (
        <span>
          {usage.cost.amount.toFixed(4)} {usage.cost.currency}
        </span>
      ) : null}
      <GitStatus cwd={cwd} busy={busy} />
      {githubAccount && <ProjectGitHubAccountButton account={githubAccount} onOpen={onAccountClick} />}
      <span className="grow" />
      {version ? <span>keryx {version}</span> : null}
    </div>
  );
}
