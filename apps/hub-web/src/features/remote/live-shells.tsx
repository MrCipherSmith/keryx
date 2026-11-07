import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
import { Button, Field, Notice, Panel, Textarea } from "../../components/ui";
import { useDraft } from "../../state/drafts";
import { Feedback, useOperator } from "./shared";

export function LiveShells({ projectId }: { projectId: string }) {
  const { scopeKey } = useHub();
  const { t } = useTranslation("remote");
  const [selected, setSelected] = useState<string | null>(null);
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
      path={path + "/" + encodeURIComponent(selected)} onDetach={() => setSelected(null)} />;
  }
  if (list.error instanceof ApiError && list.error.status === 404) return null;
  return (
    <Panel title={t("liveShells.title")}>
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
                  setSelected(shell.id);
                }}>{t("liveShells.open")}</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

type Attempt = ({
  kind: "message";
  text: string;
} | {
  kind: "stop";
  turnId: string;
}) & {
  key: string;
  operationId?: string;
  uncertain?: boolean;
};
type LiveDraft = {
  text: string;
  clientId: string;
  attempt: Attempt | null;
  lastDelivery?: LiveShellDelivery["status"];
};

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
        text: delivery.status === "applied" && attempt.kind === "message" && current.text === attempt.text
          ? "" : current.text,
      };
    });
  }, [attempt, delivery, setDraft]);

  const command = useMutation({
    mutationFn: (request: Attempt) => remoteMutate<{ operationId: string }>(
      "POST", path + "/" + request.kind,
      request.kind === "message" ? { clientId, text: request.text } : { clientId, turnId: request.turnId },
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

  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    disconnectButton.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (scroll.current && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [detail.data?.messages]);

  async function detach() {
    if (owns) await control.mutateAsync("release").catch(() => undefined);
    onDetach();
  }

  return (
    <Panel title={shell?.title ?? t("liveShells.title")}
      description={shell && <>{shell.machineName} · {shell.checkoutId} · {t(shell.busy ? "states.busy" : "states.idle")}</>}>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={disconnectButton} variant="secondary" disabled={control.isPending}
          onClick={() => void detach()}>{t("liveShells.detach")}</Button>
        {operator && shell && !detail.error && (owns
          ? <Button variant="secondary" disabled={control.isPending} onClick={() => control.mutate("release")}>{t("release")}</Button>
          : <Button disabled={control.isPending || !!detail.data?.controllerHeld} onClick={() => control.mutate("claim")}>{t("claim")}</Button>)}
        {stopTurnId && owns && <Button variant="danger" disabled={!canCommand || !!attempt}
          onClick={() => submit({ key: crypto.randomUUID(), kind: "stop", turnId: stopTurnId })}>{t("liveShells.stop")}</Button>}
      </div>
      {ended ? <Notice>{t("liveShells.ended")}</Notice> : <Feedback query={detail} />}
      {(control.error || renewalError) ? <Notice tone="error">{errorMessage(control.error ?? renewalError, t)}</Notice> : null}
      {shell && <>
        {!owns && !ended && <p className="text-sm text-slate-500">
          {t(!operator ? "liveShells.readOnly" : detail.data?.controllerHeld ? "liveShells.held" : "liveShells.observing")}
        </p>}
        <div ref={scroll} className="session-transcript-body min-w-0" role="region" aria-label={t("history")}
          onScroll={event => {
            const element = event.currentTarget;
            follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 50;
          }}>
          {detail.data?.messages.length ? (
            <ol className="session-thread">
              {detail.data.messages.map((message, index) => (
                <li key={index} className={"session-message " + (message.role === "user" ? "human" : "assistant")}>
                  <span className="session-avatar" aria-hidden="true">{message.role === "assistant" ? "K" : "H"}</span>
                  <div className="min-w-0">
                    <div className="session-message-header"><strong>{message.role === "assistant" ? "Keryx" : t("liveShells.human")}</strong></div>
                    <div className="session-message-content">
                      {message.role === "assistant" ? <Markdown content={message.text} /> : <pre>{message.text}</pre>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-slate-500">{t("liveShells.noHistory")}</p>}
        </div>
        {deliveryStatus && <p role="status" className="session-delivery-status">
          {t("liveShells.delivery." + deliveryStatus)}
        </p>}
        {operator && <form className="min-w-0 space-y-2" onSubmit={event => {
          event.preventDefault();
          if (!attempt && !shell.busy && draft.text.trim() && messageFits)
            submit({ key: crypto.randomUUID(), kind: "message", text: draft.text });
        }}>
          <Field label={t("message")} hint={messageFits ? undefined : t("liveShells.tooLong")}>
            <Textarea value={draft.text} maxLength={liveShellLimits.messageBytes}
              readOnly={!!attempt} placeholder={t("messagePlaceholder")}
              onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!canCommand || shell.busy || !!attempt || !draft.text.trim() || !messageFits}>{t("send")}</Button>
            {attempt?.uncertain && <Button variant="secondary" disabled={!canCommand}
              onClick={() => submit(attempt)}>{t("liveShells.retry")}</Button>}
            {reviewDelivery && <Button variant="secondary" onClick={() => setDraft(current => ({ ...current, attempt: null }))}>
              {t("liveShells.reviewed")}
            </Button>}
          </div>
          {command.error && <Notice tone="error">{attempt?.uncertain ? t("liveShells.uncertain") : errorMessage(command.error, t)}</Notice>}
        </form>}
      </>}
    </Panel>
  );
}
