import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../../components/Markdown";
import { pendingAssistantText } from "./session-timeline";
import { useTranslation } from "react-i18next";
import type {
  ApprovalProjection,
  FrameOf,
  RunRecord,
} from "../../../../../src/remote-control/protocol";
import type { Control } from "../../api/remote";
import { remoteProject } from "../../api/remote";
import { useRemoteAction, useRemoteQuery } from "../../api/remote-hooks";
import { useHub } from "../../app/hub-context";
import { Button, EmptyState, Notice, Panel } from "../../components/ui";
import { ApprovalCard } from "./runs";
import { ChatAction } from "./chat-composer";
import {
  ActionFeedback,
  Definition,
  Feedback,
  TechnicalDetails,
  type Controller,
} from "./shared";
import { useRunTimeline } from "./use-run-timeline";
import { sessionRunCopy } from "./session-run-copy";
import "./session-run-context.css";

export type SessionRunMode = "context" | "changes" | "checks" | "attention";
type Props = {
  record: Control["SessionRecord"];
  control: Controller;
  mode: SessionRunMode;
  conversation?: HTMLDivElement | null;
  approvalDock?: HTMLDivElement | null;
  stopDock?: HTMLSpanElement | null;
  messages?: Control["SessionMessage"][];
};
/** Mount one instance per workspace; changing mode preserves its bounded event accumulator. */
export function SessionRunContext({ record, control, mode, conversation, approvalDock, stopDock, messages }: Props) {
  const hub = useHub();
  const { i18n } = useTranslation();
  const copy = sessionRunCopy[i18n.language.startsWith("ru") ? "ru" : "en"];
  const query = useRemoteQuery<RunRecord>(
    ["run", record.activeRunId],
    remoteProject(record.projectId) +
      "/runs/" +
      encodeURIComponent(record.activeRunId ?? ""),
    !!record.activeRunId,
  );
  const lastRun = useRef<RunRecord | undefined>(undefined);
  useEffect(() => {
    if (query.data?.runId === record.activeRunId) lastRun.current = query.data;
  }, [query.data, record.activeRunId]);
  const live = Boolean(record.activeRunId);
  const historyBehind = (messages?.at(-1)?.historyCursor ?? 0) < record.historyCursor;
  const run = live ? query.data : historyBehind ? lastRun.current : undefined;
  return (
    <>
      {!live && mode !== "attention" && (
        <div className="session-run-empty">
          <EmptyState>
            <p>{copy.noActiveRun}</p>
            <p>{copy.noActiveRunHint}</p>
          </EmptyState>
          <Button
            variant="ghost"
            onClick={() =>
              hub.navigate({
                tab: "runs",
                sessionId: undefined,
                runId: undefined,
              })
            }
          >
            {copy.openRuns}
          </Button>
        </div>
      )}
      <div className="session-run-context">
        {live && <Feedback query={query} />}
        {run && (
          <LoadedRun
            key={run.runId}
            run={run}
            record={record}
            control={control}
            mode={mode}
            conversation={conversation}
            approvalDock={approvalDock}
            stopDock={stopDock}
            messages={messages}
            readOnly={!live}
          />
        )}
      </div>
    </>
  );
}

function LoadedRun({ run, record, control, mode, conversation, approvalDock, stopDock, messages, readOnly }: Props & { run: RunRecord; readOnly: boolean }) {
  const hub = useHub();
  const { t, i18n } = useTranslation("remote");
  const copy = sessionRunCopy[i18n.language.startsWith("ru") ? "ru" : "en"];
  const { timeline, query } = useRunTimeline(run);
  const cancel = useRemoteAction();
  const reply = pendingAssistantText(run.runId, timeline.events, messages ?? []);
  // Keep only already visible text when the run has ended but history has not caught up.
  if (readOnly) return conversation && reply
    ? createPortal(<div className="session-live"><Markdown content={reply} /></div>, conversation)
    : null;
  const toolLog = timeline.events.flatMap(event => event.kind === "log" && event.stream !== "assistant" ? [event] : []);
  const terminal = ["succeeded", "failed", "cancelled", "rejected", "lost", "unknown"].includes(run.state);
  const safe =
    !query.isPending &&
    !query.error &&
    !timeline.conflict &&
    !timeline.overflow;
  const approvals = new Map<string, ApprovalProjection>();
  for (const event of timeline.events)
    if (event.kind === "approval-request")
      approvals.set(event.approvalId, { ...event, status: "waiting" });
  for (const projection of run.approvals ?? [])
    approvals.set(projection.approvalId, projection);
  const flowId =
    run.association.mode === "flow" ? run.association.flowId : null;
  const openRun = () =>
    hub.navigate({ tab: "runs", runId: run.runId, sessionId: undefined });
  const openFlow = () => {
    if (flowId)
      hub.navigate({
        projectId: run.projectId,
        tab: "flows",
        flowId,
        runId: undefined,
        sessionId: undefined,
      });
  };
  const approvalCards = [...approvals.values()].map(approval => {
    const outcome = timeline.events.find(
      (event): event is Extract<FrameOf<"run-event">["payload"], { kind: "approval-outcome" }> =>
        event.kind === "approval-outcome" && event.approvalId === approval.approvalId,
    );
    const pending = !outcome && ["waiting", "recorded", "delivered"].includes(approval.status) && run.state === "waiting-approval";
    const card = <div key={approval.approvalId} data-chat-approval={pending ? "waiting" : undefined} tabIndex={pending ? -1 : undefined}>
      <ApprovalCard approval={approval} run={run} session={record} control={control} safe={safe} outcome={outcome} compact={pending && !!approvalDock} />
    </div>;
    return { pending, card };
  });
  const stop = !terminal && <ChatAction kind="stop" label={t("chatStop")}
    disabled={!run.connected || !control.active || timeline.conflict || timeline.overflow || cancel.isPending || cancel.isSuccess || !!run.cancelRequested}
    onClick={() => {
      if (!control.binding) return;
      cancel.mutate({
        path: remoteProject(run.projectId) + "/runs/" + encodeURIComponent(run.runId) + "/cancel",
        body: {
          expectedRunVersion: run.version,
          expectedSessionVersion: record.version,
          reason: t("cancel"),
          controller: control.binding,
        } satisfies Control["CancelRequest"],
      });
    }} />;
  if (mode === "attention") return <>{approvalCards.map(item => item.card)}</>;
  const activeCards = approvalCards.filter(item => item.pending).map(item => item.card);
  const historyCards = approvalCards.filter(item => !approvalDock || !item.pending).map(item => item.card);
  return (
    <>
      {approvalDock && activeCards.length > 0 && createPortal(activeCards, approvalDock)}
      {stopDock && stop && createPortal(stop, stopDock)}
      {conversation ? createPortal(
        <div className="session-live">
          {reply && <Markdown content={reply} />}
          {!terminal && <div className="session-live-controls">
            <span role="status">{run.cancelRequested || cancel.isSuccess
              ? t("receiptStatuses.requested")
              : t("states." + run.state, { defaultValue: run.state })}</span>
            {!stopDock && stop}
          </div>}
          <ActionFeedback action={cancel} />
          {toolLog.length > 0 && <details className="session-tool-log">
            <summary>{t("output")}</summary>
            {toolLog.map(event => <pre key={event.localSeq}>{event.text}</pre>)}
          </details>}
          {historyCards}
        </div>, conversation) : historyCards}
      {mode === "context" && (
        <>
          <Panel title={copy.currentRun}>
            <div className="session-run-summary">
              <span className="session-run-state">
                {t("states." + run.state, { defaultValue: run.state })}
              </span>
              <Button variant="ghost" onClick={openRun}>
                {copy.openRun}
              </Button>
            </div>
            {flowId ? (
              <Button variant="ghost" onClick={openFlow}>
                {copy.flow}: {flowId}
              </Button>
            ) : (
              <p className="session-run-hint">{copy.adHoc}</p>
            )}
            {!run.connected && <Notice>{t("offline")}</Notice>}
            {run.partial && <Notice>{copy.incomplete}</Notice>}
            <TechnicalDetails
              value={{
                runId: run.runId,
                turnId: run.turnId,
                association: run.association,
                snapshot: run.snapshot,
              }}
            />
          </Panel>
          <Feedback query={query} />
          {timeline.gap && <Notice>{t("gap")}</Notice>}
          {timeline.conflict && (
            <Notice tone="error">{t("replayConflict")}</Notice>
          )}
          {timeline.overflow && (
            <Notice tone="error">{t("timelineOverflow")}</Notice>
          )}
        </>
      )}
      {mode === "changes" && (
        <Panel title={copy.changes}>
          {run.result ? (
            <>
              <Definition label={copy.resultRevision}>
                <code className="session-result-id">
                  {run.result.revisionId}
                </code>
              </Definition>
              {run.result.partial && <Notice>{copy.incomplete}</Notice>}
              <Button
                onClick={() =>
                  hub.navigate({
                    projectId: run.projectId,
                    tab: "code",
                    revisionId: run.result!.revisionId,
                    runId: undefined,
                    sessionId: undefined,
                  })
                }
              >
                {copy.viewChanges}
              </Button>
              <TechnicalDetails value={run.result} />
            </>
          ) : (
            <>
              <EmptyState>{copy.noResult}</EmptyState>
              <Button variant="ghost" onClick={openRun}>
                {copy.openRun}
              </Button>
            </>
          )}
        </Panel>
      )}
      {mode === "checks" && (
        <Panel title={copy.checks}>
          {run.result ? (
            <>
              <Notice>{copy.selfReported}</Notice>
              <Definition label={copy.checks}>
                {run.result.checksKind === "FlowEvidence"
                  ? copy.flowEvidence
                  : copy.runChecks}
              </Definition>
              <Definition label={copy.receipt}>
                {run.result.receiptId}
              </Definition>
              {run.result.evidenceId && (
                <Definition label={copy.evidence}>
                  {run.result.evidenceId}
                </Definition>
              )}
              {run.result.flowId && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    hub.navigate({
                      projectId: run.projectId,
                      tab: "flows",
                      flowId: run.result!.flowId!,
                      runId: undefined,
                      sessionId: undefined,
                    })
                  }
                >
                  {copy.viewFlow}
                </Button>
              )}
              <Button variant="ghost" onClick={openRun}>
                {copy.openRun}
              </Button>
            </>
          ) : (
            <EmptyState>{copy.noChecks}</EmptyState>
          )}
        </Panel>
      )}
    </>
  );
}
