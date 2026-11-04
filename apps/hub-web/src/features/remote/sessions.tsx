import { getJson } from '../../api/client';
import type { HubFlow } from '../../api/types';
import { digestCriteria } from './shared';
import { Textarea } from '../../components/ui';
import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { remoteGet } from "../../api/remote";
import { formatDate } from "../../i18n/format";
import { Markdown } from "../../components/Markdown";
import { SessionWorkspace, useWorkspaceCopy } from "./session-workspace";
import { useTranslation } from "react-i18next";
import type { MachineSummary } from "../../../../../src/remote-control/protocol";
import type { Control } from "../../api/remote";
import { remoteProject } from "../../api/remote";
import {
  sessionPath,
  useRemoteAction,
  useAppliedReceipt,
  useRemoteQuery,
} from "../../api/remote-hooks";
import { useHub } from "../../app/hub-context";
import { useDraft, useDraftStore } from "../../state/drafts";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeading,
  Panel,
  Select,
} from "../../components/ui";
import {
  ActionFeedback,
  Definition,
  Feedback,
  useController,
  useOperator,
} from "./shared";
import { MessageComposer, QueueControls, messageDraftKey, prepareFlowMessageDraft } from "./work";
import { ForkSession } from "./fork";
import { Settings } from "./settings";
import { historyQueryKey, mergeTimeline, type CommandEntry, type CommandOutcomeListener } from "./session-timeline";
export function SessionsView() {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const [create, setCreate] = useState(false);
  // Set when the form is opened from the rejected-opening recovery, which unmounts the focused button.
  const [focusForm, setFocusForm] = useState(false);
  const sessions = useRemoteQuery<Control["SessionPage"]>(
    ["sessions"],
    remoteProject(hub.projectId ?? "") + "/sessions",
  );
  const machines = useRemoteQuery<{ machines: MachineSummary[] }>(
    ["machines"], "/machines?projectId=" + encodeURIComponent(hub.projectId ?? ""),
  );
  if (hub.location.sessionId)
    return (
      <SessionDetail
        key={hub.projectId + ":" + hub.location.sessionId}
        sessionId={hub.location.sessionId}
        onNewSession={() => { setCreate(true); setFocusForm(true); hub.navigate({ tab: "sessions", sessionId: undefined }); }}
      />
    );
  return (
    <div className="space-y-5">
      <PageHeading
        title={t("sessions")}
        description={t("description")}
        action={
          <Button onClick={() => { setFocusForm(false); setCreate(!create); }}>{t("newSession")}</Button>
        }
      />
      {create && <CreateSession focusOnOpen={focusForm} />}
      <Feedback query={sessions} />
      {sessions.data?.sessions.length === 0 && (
        <EmptyState>{t("empty")}</EmptyState>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {sessions.data?.sessions.map((s) => (
          <Panel
            key={s.sessionId}
            title={s.title}
            description={t("states." + s.state, { defaultValue: s.state })}
          >
            <dl className="space-y-3">
              <Definition label={t("machine")}>
                {machines.data?.machines.find(machine => machine.machineId === s.machineId)?.displayName ?? s.machineId}
              </Definition>
              <Definition label={t("checkout")}>{s.checkoutId}</Definition>
              <Definition label={t("controller")}>
                {s.controller?.actorId ?? "—"}
              </Definition>
            </dl>
            <Button
              variant="secondary"
              onClick={() =>
                hub.navigate({ tab: "sessions", sessionId: s.sessionId })
              }
            >
              {t("details")}
            </Button>
          </Panel>
        ))}
      </div>
    </div>
  );
}
/** The first launch requirement that is not met, in the order the operator should fix them. */
function firstUnmetLaunchCondition({ operator, targetReady, hasTitle, flowsState, flowGone }: { operator: boolean; targetReady: boolean; hasTitle: boolean; flowsState: "ready" | "loading" | "failed"; flowGone: boolean }) {
  if (!operator) return "sessionLaunchOperatorOnly";
  if (!targetReady) return "sessionLaunchRequirements";
  if (!hasTitle) return "sessionLaunchEnterTitle";
  if (flowsState === "loading") return "sessionLaunchFlowsLoading";
  if (flowsState === "failed") return "sessionLaunchFlowsFailed";
  if (flowGone) return "sessionLaunchFlowGone";
  return null;
}
function CreateSession({ focusOnOpen = false }: { focusOnOpen?: boolean }) {
  const hub = useHub();
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnOpen) form.current?.querySelector("select")?.focus();
  }, [focusOnOpen]);
  const { t } = useTranslation("remote");
  const operator = useOperator();
  const machines = useRemoteQuery<{ machines: MachineSummary[] }>(
    ["machines"],
    "/machines?projectId=" + encodeURIComponent(hub.projectId ?? ""),
  );
  const action = useRemoteAction<Control["SessionOperationReceipt"]>();
  const [draft, setDraft, clearDraft] = useDraft(
    `remote-create:${hub.scopeKey}:${hub.projectId}`,
    { machineId: "", checkoutId: "", profileId: "", title: "", flowId: "", firstMessage: "" },
  );
  const m = machines.data?.machines.find(
    (m) => m.machineId === draft.machineId,
  );
  const c = m?.inventory?.checkouts.find(
    (c) => c.projectId === hub.projectId && c.checkoutId === draft.checkoutId,
  );
  const profile = c?.agentProfiles.find((p) => p.profileId === draft.profileId);
  const flows = useQuery({
    queryKey: [hub.scopeKey, hub.projectId, "flows"],
    queryFn: ({ signal }) => getJson<{ flows: HubFlow[] }>(remoteProject(hub.projectId ?? "") + "/flows", signal),
  });
  const eligible = flows.data?.flows.filter(flow => flow.status === "in-progress") ?? [];
  const selectedFlow = eligible.find(flow => flow.id === draft.flowId);
  const targetReady =
    m?.connected &&
    !m.revoked &&
    !m.recoveryRequired &&
    c?.available &&
    c.clean &&
    !c.busy &&
    profile?.adapter === "keryx-native-v1" &&
    profile.readiness === "ready";
  // A chosen Flow cannot be checked until the Flows are known: name that instead of blaming the Flow.
  const flowsState = !draft.flowId || flows.data ? "ready" : flows.isError ? "failed" : "loading";
  const flowGone = !!draft.flowId && !!flows.data && !selectedFlow;
  const blocker = firstUnmetLaunchCondition({ operator, targetReady: !!targetReady, hasTitle: !!draft.title.trim(), flowsState, flowGone });
  const ready = blocker === null;
  function submit() {
    if (!ready || !m?.inventory || !c || !profile || !hub.projectId) return;
    action.mutate(
      {
        path: remoteProject(hub.projectId) + "/sessions",
        body: {
          machineId: m.machineId,
          checkoutId: c.checkoutId,
          agentProfileId: profile.profileId,
          expectedInventoryVersion: m.inventory.inventoryVersion,
          expectedHeadSha: c.headSha,
          capabilityDigest: profile.capabilityDigest,
          policyDigest: profile.policyDigest,
          title: draft.title.trim(),
        } satisfies Control["SessionCreate"],
      },
      {
        onSuccess: async (receipt) => {
          if (selectedFlow) {
            const criteriaDigest = await digestCriteria(selectedFlow.criteria);
            useDraftStore.getState().put(
              messageDraftKey(hub.scopeKey, hub.projectId, receipt.sessionId),
              prepareFlowMessageDraft(selectedFlow, criteriaDigest, draft.firstMessage),
            );
          }
          // The next New session starts from a clean form, not from this session's Flow and first message.
          clearDraft();
          hub.navigate({ tab: "sessions", sessionId: receipt.sessionId });
        },
      },
    );
  }
  return (
    <div ref={form} className="contents">
    <Panel title={t("newSession")}>
      <Field label={t("machine")}>
        <Select
          value={draft.machineId}
          onChange={(e) =>
            setDraft({
              ...draft,
              machineId: e.target.value,
              checkoutId: "",
              profileId: "",
            })
          }
        >
          <option value="">{t("choose")}</option>
          {machines.data?.machines.map((m) => (
            <option
              key={m.machineId}
              value={m.machineId}
              disabled={!m.connected || m.revoked || m.recoveryRequired}
            >
              {m.displayName} · {t(m.connected ? "online" : "offline")}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("checkout")}>
        <Select
          value={draft.checkoutId}
          onChange={(e) =>
            setDraft({ ...draft, checkoutId: e.target.value, profileId: "" })
          }
        >
          <option value="">{t("choose")}</option>
          {m?.inventory?.checkouts
            .filter((c) => c.projectId === hub.projectId)
            .map((c) => (
              <option
                key={c.checkoutId}
                value={c.checkoutId}
                disabled={!c.available || !c.clean || c.busy}
              >
                {c.label} · {c.clean ? "" : t("dirty")}{" "}
                {c.busy ? t("busy") : ""}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={t("profile")}>
        <Select
          value={draft.profileId}
          onChange={(e) => setDraft({ ...draft, profileId: e.target.value })}
        >
          <option value="">{t("choose")}</option>
          {c?.agentProfiles.map((p) => (
            <option
              key={p.profileId}
              value={p.profileId}
              disabled={
                p.adapter !== "keryx-native-v1" || p.readiness !== "ready"
              }
            >
              {p.profileId} · {p.readiness} · {p.reason}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("title")}>
        <Input
          value={draft.title}
          maxLength={200}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <Field label={t("launchFlow")}>
        <Select value={draft.flowId} onChange={event => setDraft({ ...draft, flowId: event.target.value })}>
          <option value="">{t("choose")}</option>
          {draft.flowId && !selectedFlow && <option value={draft.flowId} disabled>{flows.data
            ? t("launchFlowGone", { title: flows.data.flows.find(flow => flow.id === draft.flowId)?.title ?? draft.flowId })
            : t("launchFlowUnchecked", { id: draft.flowId })}</option>}
          {eligible.map(flow => <option key={flow.id} value={flow.id}>{flow.title} · v{flow.version}</option>)}
        </Select>
      </Field>
      {selectedFlow && <Field label={t("launchMessage")}>
        <Textarea value={draft.firstMessage} maxLength={32768} onChange={event => setDraft({ ...draft, firstMessage: event.target.value })}/>
      </Field>}
      {c && (
        <dl className="space-y-2">
          <Definition label={t("head")}>{c.headSha}</Definition>
          <Definition label={t("policy")}>
            {profile?.policyDigest ?? "—"}
          </Definition>
          <Definition label={t("capability")}>
            {profile?.capabilityDigest ?? "—"}
          </Definition>
        </dl>
      )}
      <Feedback query={machines} />
      <Feedback query={flows} />
      <ActionFeedback action={action} />
      {blocker && <p className="text-sm text-slate-500">{t(blocker)}</p>}
      <Button disabled={!ready || action.isPending} onClick={submit}>
        {t("createSession")}
      </Button>
    </Panel>
    </div>
  );
}
export function SessionDetail({ sessionId, onNewSession }: { sessionId: string; onNewSession?: () => void }) {
  const hub = useHub();
  const { t } = useTranslation("remote");
  const query = useRemoteQuery<Control["SessionRecord"]>(
    ["session", sessionId],
    sessionPath(hub.projectId ?? "", sessionId),
  );
  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        onClick={() => hub.navigate({ sessionId: undefined })}
      >
        ← {t("back")}
      </Button>
      <Feedback query={query} />
      {query.data && <SessionSurface key={query.data.sessionId} record={query.data} onNewSession={onNewSession} />}
    </div>
  );
}
export function SessionSurface({
  record,
  onNewSession,
}: {
  record: Control["SessionRecord"];
  onNewSession?: () => void;
}) {
  const { t } = useTranslation("remote");
  const control = useController(record);
  const action = useRemoteAction();
  const path = sessionPath(record.projectId, record.sessionId);
  // Command outcomes are tab-local (the history endpoint carries only messages). Each keeps its
  // invocation time for display and the history cursor at invocation for placement; the first report
  // of an operation fixes both, later reports only refresh the outcome.
  const [outcomes, setOutcomes] = useState<CommandEntry[]>([]);
  const recordOutcome = useCallback<CommandOutcomeListener>((outcome, invokedAt, anchor) => {
    setOutcomes(previous => {
      const index = previous.findIndex(item => item.outcome.operationId === outcome.operationId);
      if (index < 0) return [...previous, { outcome, invokedAt, anchor: anchor ?? Number.POSITIVE_INFINITY }];
      return previous.map((item, at) => at === index ? { ...item, outcome } : item);
    });
  }, []);
  const opening = useRemoteQuery<{ errorCode: string | null }>(
    ["opening-status",record.sessionId],path+"/opening-status",record.state==="opening",
  );
  const openingError = record.state === "opening" ? opening.data?.errorCode : null;
  return (
    <>
    {openingError && (
      <Notice tone="error">
        {t("sessionOpeningRejected")} {t("sessionOpeningNextStep")}
        {onNewSession && <Button variant="secondary" onClick={onNewSession}>{t("sessionOpeningCreateNew")}</Button>}
        <details>
          <summary>{t("sessionOpeningDetails")}</summary>
          <code>{openingError}</code>
        </details>
      </Notice>
    )}
    <SessionWorkspace
      openingRejected={!!openingError}
      record={record}
      control={control}
      history={<History record={record} outcomes={outcomes} />}
      composer={
        <MessageComposer record={record} control={control} onCommandOutcome={recordOutcome} />
      }
      queue={<QueueControls record={record} control={control} />}
      settings={<Settings record={record} control={control} />}
      operations={
        <>
          {" "}
          <Panel title={t("versions")}>
            <dl className="grid grid-cols-2 gap-3">
              <Definition label={t("sessionVersion")}>
                {record.version}
              </Definition>
              <Definition label={t("configVersion")}>
                {record.config.configVersion}
              </Definition>
              <Definition label={t("historyVersion")}>
                {record.historyVersion}
              </Definition>
              <Definition label={t("queueVersion")}>
                {record.queueVersion}
              </Definition>
            </dl>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={
                  !control.active || action.isPending || record.state === "busy"
                }
                onClick={() =>
                  control.binding &&
                  action.mutate({
                    path: path + "/resume",
                    body: {
                      expectedSessionVersion: record.version,
                      controller: control.binding,
                      expectedHistoryVersion: record.historyVersion,
                      expectedWorkspaceBaseline: record.workspaceBaseline,
                    } satisfies Control["SessionResume"],
                  })
                }
              >
                {t("resume")}
              </Button>
              <Button
                variant="secondary"
                disabled={!control.active || action.isPending}
                onClick={() =>
                  control.binding &&
                  action.mutate({
                    path: path + "/close",
                    body: {
                      expectedSessionVersion: record.version,
                      controller: control.binding,
                      mode: "when-idle",
                    } satisfies Control["SessionClose"],
                  })
                }
              >
                {t("close")}
              </Button>
            </div>
            <ActionFeedback action={action} />
          </Panel>
          <ForkSession record={record} control={control} />
        </>
      }
    />
    </>
  );
}

function History({ record, outcomes }: { record: Control["SessionRecord"]; outcomes: CommandEntry[] }) {
  const { t } = useTranslation("remote");
  const hub = useHub();
  const query = useInfiniteQuery({
    queryKey: historyQueryKey(hub.scopeKey, record.projectId, record.sessionId),
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      remoteGet<Control["HistoryPage"]>(
        sessionPath(record.projectId, record.sessionId) +
          "/history?after=" +
          pageParam,
        signal,
      ),
    getNextPageParam: (page) => (page.hasMore ? page.cursor : undefined),
  });
  const messages = new Map<string, Control["SessionMessage"]>();
  query.data?.pages.forEach((page) =>
    page.messages.forEach((message) =>
      messages.set(message.messageId, message),
    ),
  );
  const ordered = [...messages.values()].sort(
    (a, b) => a.historyCursor - b.historyCursor,
  );
  const timeline = mergeTimeline(ordered, outcomes);
  return (
    <section className="session-transcript" aria-label={t("history")}>
      <header className="session-transcript-header">
        <h2>{t("history")}</h2>
        <span>{record.agentProfileId}</span>
      </header>
      <div className="session-transcript-body">
        <Feedback query={query} />
        {query.data?.pages.some((page) => page.gap) && (
          <Notice>{t("gap")}</Notice>
        )}
        <ol>
          {timeline.map((entry) => entry.kind === "outcome"
            ? <OutcomeItem key={entry.item.outcome.operationId} record={record} item={entry.item} />
            : <MessageItem key={entry.message.messageId} message={entry.message} />)}
        </ol>
        {query.data && !ordered.length && !outcomes.length && <EmptyState>{t("empty")}</EmptyState>}
      </div>
      {query.hasNextPage && (
        <footer className="session-history-pages">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("more")}
          </Button>
        </footer>
      )}
    </section>
  );
}

function formatResult(result: unknown) {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
const isSettled = (status: Control["CommandOutcome"]["status"]) => status === "applied" || status === "rejected";
/** One command outcome, followed through its own operation so it moves from queued to applied or rejected. */
function OutcomeItem({ record, item }: { record: Control["SessionRecord"]; item: CommandEntry }) {
  const { t, i18n } = useTranslation("remote");
  // Follow the operation only until it settles: an applied or rejected record cannot change, and a live
  // query per outcome would be refetched on every invalidation for the tab's lifetime.
  const followed = useAppliedReceipt<Control["CommandOutcome"]>(record, item.outcome, receipt => isSettled(receipt.status));
  const outcome = followed.data ?? item.outcome;
  return (
    <li className="session-message system">
      <span className="session-avatar" aria-hidden="true">/</span>
      <div>
        <div className="session-message-header">
          <strong>/{outcome.commandName}</strong>
          <time dateTime={item.invokedAt}>{formatDate(item.invokedAt, i18n.language)}</time>
        </div>
        <div className="session-message-content">
          <p>{t("receiptStatuses." + outcome.status, { defaultValue: outcome.status })}</p>
          {outcome.errorCode && <p>{outcome.errorCode}</p>}
          {outcome.result !== null && <pre className="whitespace-pre-wrap break-all">{formatResult(outcome.result)}</pre>}
        </div>
      </div>
    </li>
  );
}
function MessageItem({ message }: { message: Control["SessionMessage"] }) {
  const { i18n } = useTranslation("remote");
  const hub = useHub();
  const words = useWorkspaceCopy();
  return (
    <li className={"session-message " + message.role}>
      <span className="session-avatar" aria-hidden="true">
        {message.role === "human" ? "H" : message.role === "assistant" ? "K" : "↳"}
      </span>
      <div>
        <div className="session-message-header">
          <strong>{words.role[message.role]}</strong>
          <time dateTime={message.createdAt}>{formatDate(message.createdAt, i18n.language)}</time>
        </div>
        <div className="session-message-content">
          {message.role === "assistant" ? <Markdown content={message.text} /> : <pre>{message.text}</pre>}
        </div>
        {message.role === "assistant" && message.runId && (
          <Button
            variant="ghost"
            onClick={() => hub.navigate({ tab: "runs", runId: message.runId ?? undefined, sessionId: undefined })}
          >
            {i18n.language.startsWith("ru") ? "Открыть запуск" : "Open run"}
          </Button>
        )}
      </div>
    </li>
  );
}
