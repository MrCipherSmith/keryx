import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ellipsis, MessageSquare, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  liveShellLimits,
  type LiveShellDelivery,
  type LiveShellDetail,
  type LiveShellSummary,
} from "../../../../../src/remote-control/live-shell";
import { ApiError, errorMessage } from "../../api/client";
import { remoteGet, remoteMutate, remoteProject } from "../../api/remote";
import { useHub } from "../../app/hub-context";
import { Markdown } from "../../components/Markdown";
import { Button, Field, Input, Notice, Panel, Textarea } from "../../components/ui";
import { useDraft } from "../../state/drafts";
import { Feedback, useOperator } from "./shared";
import { ChatAction, ChatComposerFrame, ChatConversation, ChatModelPicker, ChatToolbar, ChatUsage } from "./chat-composer";
import { ChatTranscript, type ChatTranscriptEntry } from "./session-transcript";
import "./session-workspace.css";

export function LiveShells({ projectId, before, after }: {
  projectId: string;
  before?: ReactNode;
  after?: ReactNode;
}) {
  const { scopeKey, location, navigate } = useHub();
  const { t } = useTranslation("remote");
  const selected = location.liveShellId;
  const returnFocus = useRef<string | null>(null);
  const path = remoteProject(projectId) + "/live-shells";
  const list = useQuery({
    queryKey: [scopeKey, projectId, "remote", "live-shells"],
    queryFn: ({ signal }) => remoteGet<{ shells: LiveShellSummary[] }>(path, signal),
    enabled: !selected,
    refetchInterval: 5_000,
    retry: false,
  });
  if (selected) {
    return <LiveShellPane key={selected} projectId={projectId} id={selected}
      path={path + "/" + encodeURIComponent(selected)} onDetach={() => navigate({ liveShellId: undefined })} />;
  }
  const supported = !(list.error instanceof ApiError && list.error.status === 404);
  return <>
    {before}
    {supported && <Panel title={t("liveShells.title")}>
      <p className="text-sm text-slate-500">
        {t("liveShells.discovery")} <code>/remote-control hub on</code>
      </p>
      {list.error && <Feedback query={list} />}
      {list.data?.shells?.length === 0 && <p className="text-sm text-slate-500">{t("liveShells.empty")}</p>}
      {list.data?.shells?.length ? (
        <ul className="space-y-2">
          {list.data.shells.map(shell => (
            <li key={shell.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <div className="min-w-0 break-words">
                <p className="font-medium">{shell.title}</p>
                <p className="text-xs text-slate-500">{shell.machineName} · {shell.checkoutId} · {t(shell.busy ? "states.busy" : "states.idle")}</p>
              </div>
              <Button variant="secondary" aria-label={t("liveShells.openNamed", { title: shell.title })}
                ref={button => {
                  if (button && returnFocus.current === shell.id) {
                    button.focus({ preventScroll: true });
                    returnFocus.current = null;
                  }
                }}
                onClick={() => {
                  returnFocus.current = shell.id;
                  navigate({ tab: "sessions", sessionId: undefined, liveShellId: shell.id });
                }}>{t("liveShells.open")}</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>}
    {after}
  </>;
}

type Attempt = ({
  kind: "message";
  text: string;
} | {
  kind: "stop";
  turnId: string;
} | {
  kind: "invoke";
  name: string;
  anchor: number;
} | {
  kind: "select-model";
  candidateId: string;
} | {
  kind: "answer-approval";
  approvalId: string;
  decision: "allow" | "deny";
}) & {
  key: string;
  operationId?: string;
  uncertain?: boolean;
};
type CommandResult = { id: string; name: string; output: string; anchor: number };
type LiveDraft = {
  text: string;
  clientId: string;
  attempt: Attempt | null;
  lastDelivery?: LiveShellDelivery["status"];
  commandResults?: CommandResult[];
};

function liveCommandBody(request: Attempt, clientId: string) {
  switch (request.kind) {
    case "message": return { clientId, text: request.text };
    case "stop": return { clientId, turnId: request.turnId };
    case "invoke": return { clientId, name: request.name };
    case "select-model": return { clientId, candidateId: request.candidateId };
    case "answer-approval": return { clientId, approvalId: request.approvalId, decision: request.decision };
  }
}

function isUncertain(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

function LiveShellPane({ projectId, id, path, onDetach }: {
  projectId: string;
  id: string;
  path: string;
  onDetach: () => void;
}) {
  const { scopeKey } = useHub();
  const { t } = useTranslation("remote");
  const operator = useOperator();
  const [initialDraft] = useState<LiveDraft>(() => ({ text: "", clientId: crypto.randomUUID(), attempt: null }));
  const [draft, setDraft] = useDraft(`live-shell:${scopeKey}:${projectId}:${id}`, initialDraft);
  const { clientId, attempt } = draft;
  const operationId = attempt?.operationId;
  const detailPath = operationId ? path + "?operationId=" + encodeURIComponent(operationId) : path;
  const detail = useQuery({
    queryKey: [scopeKey, projectId, "remote", "live-shells", id, operationId],
    queryFn: ({ signal }) => remoteGet<LiveShellDetail>(detailPath, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 1_000,
    gcTime: 0,
    retry: false,
  });
  const shell = detail.data?.shell;
  const delivery = detail.data?.delivery;
  const context = detail.data?.context;
  const approval = context?.approval;
  const commands = context?.commands ?? [];
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const commandTrigger = useRef<HTMLButtonElement>(null);
  const slashOpened = useRef(false);
  const commandsId = useId();
  useEffect(() => { if (commandsOpen) searchInput.current?.focus(); }, [commandsOpen]);
  const [leaseUntil, setLeaseUntil] = useState(0);
  const [renewalError, setRenewalError] = useState<unknown>();
  const renewal = useRef<Promise<unknown> | null>(null);
  const control = useMutation({
    mutationFn: async (action: "claim" | "release") => {
      if (action === "release") {
        setLeaseUntil(0);
        await renewal.current?.catch(() => undefined);
      }
      const requestedAt = Date.now();
      await remoteMutate<{ ok: true }>("POST", path + "/" + action, { clientId });
      return action === "claim" ? requestedAt + liveShellLimits.controlMs : 0;
    },
    onSuccess: (until) => {
      setDraft(current => ({ ...current, clientId }));
      setLeaseUntil(until);
      setRenewalError(undefined);
      void detail.refetch();
    },
    retry: false,
  });

  useEffect(() => {
    if (!operator || !leaseUntil) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    function renew() {
      const requestedAt = Date.now();
      if (requestedAt >= leaseUntil) {
        setLeaseUntil(0);
        return;
      }
      const task = remoteMutate("POST", path + "/renew", { clientId });
      renewal.current = task;
      void task.then(() => {
        if (active) {
          setLeaseUntil(requestedAt + liveShellLimits.controlMs);
          setRenewalError(undefined);
        }
      }, error => {
        if (!active) return;
        if (isUncertain(error)) {
          timer = setTimeout(renew, Math.max(0, Math.min(2_000, leaseUntil - Date.now())));
        } else {
          setLeaseUntil(0);
          setRenewalError(error);
        }
      }).finally(() => {
        if (renewal.current === task) renewal.current = null;
      });
    }
    timer = setTimeout(renew, Math.max(0, leaseUntil - liveShellLimits.controlMs + 10_000 - Date.now()));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [clientId, leaseUntil, operator, path]);

  useEffect(() => {
    if (!attempt?.operationId || delivery?.id !== attempt.operationId || delivery.status === "pending" || delivery.status === "unconfirmed") return;
    setDraft(current => {
      if (current.attempt?.operationId !== delivery.id) return current;
      return {
        ...current,
        attempt: null,
        lastDelivery: delivery.status,
        ...(attempt.kind === "invoke" && delivery.status === "applied" && delivery.output
          ? { commandResults: [...(current.commandResults ?? []), {
            id: delivery.id, name: attempt.name, output: delivery.output, anchor: attempt.anchor,
          }].slice(-30) } : {}),
        text: delivery.status === "applied" && attempt.kind === "message" && current.text === attempt.text
          ? "" : current.text,
      };
    });
  }, [attempt, delivery, setDraft]);

  const command = useMutation({
    mutationFn: (request: Attempt) => remoteMutate<{ operationId: string }>(
      "POST", path + "/" + request.kind,
      liveCommandBody(request, clientId),
      { operationId: request.key },
    ),
    onSuccess: ({ operationId }, request) => {
      setDraft(current => ({
        ...current, attempt: { ...request, operationId, uncertain: false },
      }));
      void detail.refetch();
    },
    onError: (error, request) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setDraft(current => ({ ...current, attempt: isUncertain(error) ? { ...request, uncertain: true } : null }));
      if (error instanceof ApiError && ["controller-conflict", "controller-expired"].includes(error.code)) setLeaseUntil(0);
    },
    retry: false,
  });
  const ended = detail.error instanceof ApiError && detail.error.status === 404;
  const owns = operator && leaseUntil > Date.now() && !ended;
  const stopTurnId = shell?.stopTurnId;
  const canCommand = !!shell && owns && !detail.error && !control.isPending && !command.isPending;
  const reviewDelivery = !!operationId && !detail.isPlaceholderData && !!detail.data &&
    (!delivery || delivery.status === "unconfirmed");
  const deliveryStatus = reviewDelivery ? "unconfirmed"
    : (delivery?.id === operationId ? delivery?.status : undefined) ?? draft.lastDelivery;
  const messageFits = new TextEncoder().encode(draft.text).byteLength <= liveShellLimits.messageBytes;
  const submitting = useRef(false);

  function submit(request: Attempt) {
    if (!canCommand || submitting.current) return;
    submitting.current = true;
    setDraft(current => ({ ...current, lastDelivery: undefined, attempt: { ...request, uncertain: false } }));
    void command.mutateAsync(request).catch(() => undefined).finally(() => { submitting.current = false; });
  }

  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (shell?.id) title.current?.focus({ preventScroll: true });
  }, [shell?.id]);

  function detach() {
    if (owns) void control.mutateAsync("release").catch(() => undefined);
    onDetach();
  }

  function openCommands(fromSlash = false) {
    slashOpened.current = fromSlash;
    setSearch("");
    setCommandsOpen(true);
  }
  function closeCommands(useSlash = false) {
    if (useSlash && slashOpened.current && !draft.text) {
      setDraft(current => ({ ...current, text: "/" }));
      input.current?.focus();
    } else {
      commandTrigger.current?.focus();
    }
    slashOpened.current = false;
    setCommandsOpen(false);
  }

  const canSend = canCommand && !attempt && !shell?.busy && !!draft.text.trim() && messageFits;
  function send() {
    if (canSend) submit({ key: crypto.randomUUID(), kind: "message", text: draft.text });
  }
  const messages = detail.data?.messages ?? [];
  const entries: ChatTranscriptEntry[] = messages.map((message, index) => ({
    message: { id: "shell:" + index, role: message.role, content: message.text },
    render: () => <li className={"session-message " + (message.role === "user" ? "human" : "assistant")}>
      <span className="session-avatar" aria-hidden="true">{message.role === "assistant" ? "K" : "H"}</span>
      <div className="min-w-0">
        <div className="session-message-header"><strong>{message.role === "assistant" ? "Keryx" : t("liveShells.human")}</strong></div>
        <div className="session-message-content">
          {message.role === "assistant" ? <Markdown content={message.text} /> : <pre>{message.text}</pre>}
        </div>
      </div>
    </li>,
  }));
  let priorResults = 0;
  for (const result of draft.commandResults ?? []) {
    entries.splice(Math.min(result.anchor + priorResults, entries.length), 0, {
      message: { id: result.id, role: "system", content: result.output },
      render: () => <li className="session-message tool-summary">
        <span className="session-avatar" aria-hidden="true">/</span>
        <div className="min-w-0">
          <div className="session-message-header"><strong>/{result.name}</strong></div>
          <pre className="session-message-content">{result.output}</pre>
        </div>
      </li>,
    });
    priorResults++;
  }
  const matches = commands.filter(command =>
    (command.name + " " + command.description).toLowerCase().includes(search.trim().replace(/^\//, "").toLowerCase()));
  const stop = stopTurnId && owns
    ? <ChatAction kind="stop" label={t("liveShells.stop")} disabled={!canCommand || !!attempt}
        onClick={() => submit({ key: crypto.randomUUID(), kind: "stop", turnId: stopTurnId })} />
    : <ChatAction kind="send" label={t("send")} type="submit" disabled={!canSend} />;
  return (
    <section className="session-workbench chat-shell session-chat-page">
      <Button className="session-back" variant="ghost" disabled={control.isPending} onClick={detach}>
        <span aria-hidden="true">←</span> {t("chatBackToSessions")}
      </Button>
      <header className="session-workbench-header">
        <div className="session-identity">
          <MessageSquare size={18} />
          <div>
            <h1 ref={title} tabIndex={-1}>{shell?.title ?? t("liveShells.title")}</h1>
            <div className="session-header-meta">
              <span>{t("liveShells.connectedShell")}</span>
              {shell && <span role="status">{context?.phase ? t("liveShells.phases." + context.phase) : t(shell.busy ? "states.busy" : "states.idle")}</span>}
            </div>
          </div>
        </div>
        <div className="chat-shell-actions">
          {operator && shell && !detail.error && !owns &&
            <Button disabled={control.isPending || !!detail.data?.controllerHeld} onClick={() => control.mutate("claim")}>{t("claim")}</Button>}
          <details className="chat-header-menu" onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary aria-label={t("chatActions")} title={t("chatActions")}><Ellipsis size={20} aria-hidden="true" /></summary>
            <div className="chat-header-menu-options">
              {owns && <Button variant="ghost" disabled={control.isPending} onClick={() => control.mutate("release")}>{t("release")}</Button>}
              <Button variant="ghost" disabled={control.isPending} onClick={detach}>{t("liveShells.detach")}</Button>
            </div>
          </details>
        </div>
      </header>
      {shell && <div className="session-location"><Monitor size={13} /><span>{shell.machineName}</span><span>/</span><span>{shell.checkoutId}</span></div>}
      {ended ? <Notice>{t("liveShells.ended")}</Notice> : <Feedback query={detail} />}
      {(control.error || renewalError) ? <Notice tone="error">{errorMessage(control.error ?? renewalError, t)}</Notice> : null}
      {shell && <>
        {!owns && !ended && <p className="chat-control-status">
          {t(!operator ? "liveShells.readOnly" : detail.data?.controllerHeld ? "liveShells.held" : "liveShells.observing")}
        </p>}
        <ChatConversation transcript={<section className="session-transcript" aria-label={t("history")}>
          <header className="session-transcript-header"><h2>{t("history")}</h2></header>
          <ChatTranscript entries={entries}>
            {!entries.length && <p className="chat-empty">{t("liveShells.noHistory")}</p>}
          </ChatTranscript>
        </section>}
        approval={approval ? <div className="chat-approval-slot" data-chat-approval="waiting">
          <Panel title={t("approval")}>
            <p><code>{approval.tool}</code></p>
            {approval.summary && <pre className="chat-approval-summary" dir="ltr">{approval.summary}</pre>}
            {approval.reason && <p className="chat-control-status">{approval.reason}</p>}
            {approval.canAnswer ? <div className="flex flex-wrap gap-2">
              <Button disabled={!canCommand || !!attempt}
                onClick={() => submit({ key: crypto.randomUUID(), kind: "answer-approval", approvalId: approval.id, decision: "allow" })}>{t("allowOnce")}</Button>
              <Button variant="danger" disabled={!canCommand || !!attempt}
                onClick={() => submit({ key: crypto.randomUUID(), kind: "answer-approval", approvalId: approval.id, decision: "deny" })}>{t("deny")}</Button>
            </div> : <Notice>{t("chatApprovalLocal")}</Notice>}
          </Panel>
        </div> : context?.phase === "waiting-input" && <Notice>{t("chatApprovalLocal")}</Notice>}
        composer={<ChatComposerFrame title={t("message")}>
          <form className="chat-shell-composer" onSubmit={event => { event.preventDefault(); send(); }}>
            {deliveryStatus && <p role="status" className="session-delivery-status">{t("liveShells.delivery." + deliveryStatus)}</p>}
            {operator && <Field label={<span className="sr-only">{t("message")}</span>} hint={messageFits ? undefined : t("liveShells.tooLong")}>
              <Textarea ref={input} rows={2} value={draft.text} maxLength={liveShellLimits.messageBytes}
                readOnly={!!attempt} placeholder={t("messagePlaceholder")}
                onChange={event => setDraft(current => ({ ...current, text: event.target.value }))}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
                  if (event.key === "/" && commands.length > 0 && !draft.text && !attempt) {
                    event.preventDefault();
                    openCommands(true);
                  }
                  if (event.key === "Enter" && !event.shiftKey && canSend &&
                      !window.matchMedia?.("(max-width: 767px), (pointer: coarse)").matches) {
                    event.preventDefault();
                    send();
                  }
                }} />
            </Field>}
            <ChatToolbar commands={commands.length > 0 && <Button ref={commandTrigger} variant="secondary" aria-label={t("commands")}
              aria-controls={commandsOpen ? commandsId : undefined} aria-expanded={commandsOpen}
              onClick={() => commandsOpen ? closeCommands() : openCommands()}>/</Button>}
              model={context?.model && <ChatModelPicker value={context.model.currentId} candidates={context.model.candidates}
                disabled={!canCommand || !!attempt || shell.busy}
                onSelect={candidateId => submit({ key: crypto.randomUUID(), kind: "select-model", candidateId })} />}
              usage={<ChatUsage usage={context?.usage} unavailable={!context} />}
              action={operator ? stop : null} />
            {commandsOpen && <div className="chat-command-picker" id={commandsId}
              onPointerDownCapture={() => { slashOpened.current = false; }}
              onChangeCapture={() => { slashOpened.current = false; }}
              onKeyDown={event => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeCommands(true);
                } else {
                  slashOpened.current = false;
                }
              }}>
              <Field label={t("searchCommands")}><Input ref={searchInput} type="search" value={search}
                onChange={event => setSearch(event.target.value)} /></Field>
              {matches.length === 0 ? <p>{t("noCommandsFound")}</p> : <ul>
                {matches.map(item => <li key={item.name}><Button variant="ghost" disabled={!canCommand || !!attempt || shell.busy}
                  onClick={() => {
                    closeCommands();
                    submit({ key: crypto.randomUUID(), kind: "invoke", name: item.name, anchor: messages.length });
                  }}><strong>/{item.name}</strong><span>{item.description}</span></Button></li>)}
              </ul>}
            </div>}
            {operator && <div className="chat-delivery-actions">
              {attempt?.uncertain && <Button variant="secondary" disabled={!canCommand}
                onClick={() => submit(attempt)}>{t("liveShells.retry")}</Button>}
              {reviewDelivery && <Button variant="secondary" onClick={() => setDraft(current => ({ ...current, attempt: null }))}>
                {t("liveShells.reviewed")}
              </Button>}
            </div>}
            {command.error && <Notice tone="error">{attempt?.uncertain ? t("liveShells.uncertain") : errorMessage(command.error, t)}</Notice>}
          </form>
        </ChatComposerFrame>} />
      </>}
    </section>
  );
}
