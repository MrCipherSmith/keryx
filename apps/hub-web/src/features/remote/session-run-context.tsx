import { useTranslation } from "react-i18next";
import type {
  ApprovalProjection,
  FrameOf,
  RunRecord,
} from "../../../../../src/remote-control/protocol";
import type { Control } from "../../api/remote";
import { remoteProject } from "../../api/remote";
import { useRemoteQuery } from "../../api/remote-hooks";
import { useHub } from "../../app/hub-context";
import { Button, EmptyState, Notice, Panel } from "../../components/ui";
import { ApprovalCard } from "./runs";
import {
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
};
/** Mount one instance per workspace; changing mode preserves its bounded event accumulator. */
export function SessionRunContext({ record, control, mode }: Props) {
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
  if (!record.activeRunId) {
    if (mode === "attention") return null;
    return (
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
    );
  }
  return (
    <div className="session-run-context">
      <Feedback query={query} />
      {query.data && (
        <LoadedRun
          key={query.data.runId}
          run={query.data}
          record={record}
          control={control}
          mode={mode}
        />
      )}
    </div>
  );
}
function LoadedRun({ run, record, control, mode }: Props & { run: RunRecord }) {
  const hub = useHub();
  const { t, i18n } = useTranslation("remote");
  const copy = sessionRunCopy[i18n.language.startsWith("ru") ? "ru" : "en"];
  const { timeline, query } = useRunTimeline(run);
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
  const approvalCards = [...approvals.values()].map((approval) => (
    <ApprovalCard
      key={approval.approvalId}
      approval={approval}
      run={run}
      session={record}
      control={control}
      safe={safe}
      outcome={timeline.events.find(
        (
          event,
        ): event is Extract<
          FrameOf<"run-event">["payload"],
          { kind: "approval-outcome" }
        > =>
          event.kind === "approval-outcome" &&
          event.approvalId === approval.approvalId,
      )}
    />
  ));
  if (mode === "attention") return <>{approvalCards}</>;
  return (
    <>
      {approvalCards}
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
