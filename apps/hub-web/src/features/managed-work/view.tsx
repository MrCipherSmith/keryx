import { FlowList, IntentColumn } from "./work-lists";
import { WorkBadge, IntentApproval, FlowSummary } from "./work-panels";
import { AttemptDetail, DecisionHistory } from "./attempt-detail";
import { DecisionForm } from "./decision-form";
import { CreateFlow } from "./create-flow";
import { indexWorkRecords } from "./record-index";
import type { PreparedAction } from "./work-types";
import "./work-identifiers.css";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  RefreshCw} from "lucide-react";
import { useHub } from "../../app/hub-context";
import { ApiError } from "../../api/client";
import {
  Button,
  EmptyState,
  Notice,
  PageHeading} from "../../components/ui";
import { liveWorkAdapter, type WorkAdapter } from "./adapter";
import { demoWorkAdapter } from "./demo";
import {
  recordOf,
  recordsOf} from "./model";
import type {
  WorkCapabilities} from "./types";
import { WorkOperationStatus } from "./operation";
import { ContributionPanel} from "./contribute";
import { LegacyConversion } from "./legacy";
import { RevisionReview} from "./revision-review";
import { AmendmentsPanel } from "./amendments";
import { WorkAttention, useWorkEvents } from "./updates";
import { FlowReview } from "./flow-review";
import "./work.css";

export function ManagedWorkView() {
  const { projectId, scopeKey } = useHub();
  const { t } = useTranslation("work");
  const [demo, setDemo] = useState(false);
  const adapter = useMemo(
    () =>
      projectId
        ? demo
          ? demoWorkAdapter(projectId)
          : liveWorkAdapter(projectId)
        : null,
    [projectId, demo],
  );
  const capabilities = useQuery({
    queryKey: [scopeKey, projectId, "work", adapter?.mode ?? "live", "capabilities"],
    queryFn: ({ signal }) => adapter!.capabilities(signal),
    enabled: !!adapter,
    retry: false,
  });
  if (!projectId || !adapter) return <EmptyState>{t("empty")}</EmptyState>;
  const unsupported =
    capabilities.error instanceof ApiError &&
    [404, 501].includes(capabilities.error.status);
  return (
    <div className="managed-work">
      <PageHeading
        title={t("title")}
        description={t("subtitle")}
        action={
          <Button variant="secondary" onClick={() => setDemo(!demo)}>
            {t(demo ? "leaveDemo" : "showDemo")}
          </Button>
        }
      />
      {(demo || capabilities.data?.enabled) && (
        <div
          className={"work-mode " + (demo ? "work-mode-demo" : "")}
          role="status"
        >
          {t(demo ? "demo" : "live")}
        </div>
      )}
      {capabilities.isPending ? (
        <EmptyState>{t("loading")}</EmptyState>
      ) : capabilities.error ? (
        <Notice tone={unsupported ? "info" : "error"}>
          {t(unsupported ? "unavailable" : "failed")}{" "}
          <Button
            variant="secondary"
            onClick={() => void capabilities.refetch()}
          >
            {t("retry")}
          </Button>
        </Notice>
      ) : capabilities.data?.enabled ? (
        <WorkBoard
          key={scopeKey + ":" + projectId + ":" + demo}
          adapter={adapter}
          capabilities={capabilities.data}
        />
      ) : (
        <EmptyState>{t("unavailable")}</EmptyState>
      )}
    </div>
  );
}
function WorkBoard({
  adapter,
  capabilities,
}: {
  adapter: WorkAdapter;
  capabilities: WorkCapabilities;
}) {
  const hub = useHub();
  const { t } = useTranslation("work");
  const flowId = hub.location.flowId ?? null;
  const setFlow = (id: string | null) =>
    hub.navigate({ tab: "work", flowId: id ?? undefined });
  const [intentId, setIntent] = useState<string | null>(
    hub.location.intentId ?? null,
  );
  const [attemptId, setAttempt] = useState<string | null>(
    hub.location.attemptId ?? null,
  );
  const [action, setAction] = useState<PreparedAction | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setIntent(hub.location.intentId ?? null);
    setAttempt(hub.location.attemptId ?? null);
    setAction(null);
    setCreating(false);
  }, [flowId, hub.location.intentId, hub.location.attemptId]);
  const snapshot = useQuery({
    queryKey: [hub.scopeKey, hub.projectId, "work", adapter.mode, "snapshot"],
    queryFn: ({ signal }) => adapter.snapshot(signal),
    retry: false,
    staleTime: Infinity,
  });
  const eventStatus = useWorkEvents(adapter, snapshot.data?.eventCursor);
  const records = snapshot.data?.records ?? [];
  const index = useMemo(() => indexWorkRecords(records), [records]);
  const flows = recordsOf(records, "flow");
  const selectedFlow = index.byId.get(flowId ?? "");
  const flow = selectedFlow?.kind === "flow" ? selectedFlow : undefined;
  const intents = flow
    ? (index.intentsByFlow.get(flow.id) ?? [])
    : [];
  const intent = intents.find((i) => i.id === intentId) ?? intents[0];
  const currentIntentRevision = recordOf(
    records,
    "intent-revision",
    intent?.currentRevisionId,
  );
  const attempts = intent
    ? (index.attemptsByIntent.get(intent.id) ?? [])
    : [];
  const attempt = attempts.find((a) => a.id === attemptId) ?? attempts[0];
  const can = (command: string) =>
    capabilities.allowedCommands.includes(command);
  const human = hub.principal.kind === "human";
  const refresh = () => undefined;
  return (
    <>
      {adapter.mode === "live" && (
        <small role="status">
          {t(
            eventStatus === "connected"
              ? "workConnected"
              : eventStatus === "retrying"
                ? "workRetrying"
                : "workWaiting",
          )}
        </small>
      )}
      <WorkAttention
        adapter={adapter}
        records={records}
        onSelect={(f, i, a) => {
          hub.navigate({ tab: "work", flowId: f, intentId: i, attemptId: a });
          setAction(null);
        }}
      />
      <WorkOperationStatus
        adapter={adapter}
        onCommitted={() => {
          setAction(null);
          void refresh();
        }}
      />
      <div className="work-toolbar">
        <div className="work-breadcrumb">
          <button
            onClick={() => {
              setFlow(null);
              setAction(null);
            }}
          >
            {t("flows")}
          </button>
          {flow && (
            <>
              <ArrowRight size={13} />
              <strong>{flow.title}</strong>
            </>
          )}
        </div>
        <div className="work-actions">
          <Button
            variant="secondary"
            disabled={snapshot.isFetching}
            onClick={() => void snapshot.refetch()}
          >
            <RefreshCw size={14} />
            {t("retry")}
          </Button>
          {can("flow.create") && (
            <Button onClick={() => setCreating(!creating)}>
              {t("newFlow")}
            </Button>
          )}
        </div>
      </div>
      {human &&
        adapter.mode === "live" &&
        capabilities.features.legacyConversion &&
        can("legacy.preview") &&
        can("legacy.convert") && (
          <LegacyConversion
            adapter={adapter}
            records={records}
            onDone={() => void refresh()}
          />
        )}
      {creating && (
        <CreateFlow
          adapter={adapter}
          onDone={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}
      {snapshot.error ? (
        <Notice tone="error">
          {t(
            snapshot.error instanceof ApiError &&
              snapshot.error.code === "invalid-response"
              ? "invalid"
              : "failed",
          )}
        </Notice>
      ) : snapshot.isPending ? (
        <EmptyState>{t("loading")}</EmptyState>
      ) : !flow ? (
        <FlowList flows={flows} intentsByFlow={index.intentsByFlow} onSelect={(id) => { setFlow(id); setIntent(null); setAttempt(null); }} />
      ) : (
        <>
          <ContributionPanel
            adapter={adapter}
            records={records}
            flow={flow}
            intent={intent}
            attempt={attempt}
            can={can}
            onDone={() => void refresh()}
          />
          <FlowSummary
            adapter={adapter}
            flow={flow}
            records={records}
            can={can}
            human={human}
            prepare={(next) => setAction({ ...next, scopeFlowId: flow.id })}
          />
          <div className="work-detail-grid">
            <IntentColumn intents={intents} selectedIntentId={intent?.id} onSelect={(id) => { setIntent(id); setAttempt(null); setAction(null); }} />
            <section className="work-attempts">
              {intent && (
                <>
                  <header className="work-section-heading">
                    <h2>{intent.title}</h2>
                    <span>
                      {t("attempts")} · {attempts.length}
                    </span>
                  </header>
                  {currentIntentRevision &&
                    intent.state !== "draft" &&
                    (!attempt ||
                      attempt.intentRevisionId !==
                        currentIntentRevision.id) && (
                      <RevisionReview
                        adapter={adapter}
                        revision={currentIntentRevision}
                        records={records}
                      />
                    )}
                  <div className="work-attempt-selector">
                    {attempts.map((a) => (
                      <button
                        key={a.id}
                        aria-pressed={a.id === attempt?.id}
                        onClick={() => {
                          hub.navigate({
                            tab: "work",
                            intentId: intent.id,
                            attemptId: a.id,
                          });
                          setAttempt(a.id);
                          setAction(null);
                        }}
                      >
                        <strong>{a.participantId}</strong>
                        <span>
                          {t("states." + a.method)} ·{" "}
                          <WorkBadge value={a.state} />
                        </span>
                        {a.submissionId &&
                          intent.selectedSubmissionId === a.submissionId && (
                            <small>
                              <CheckCircle2 size={12} />
                              {t("selected")}
                            </small>
                          )}
                      </button>
                    ))}
                  </div>
                  {intent.state === "draft" && !intent.approvedRevisionId && (
                    <IntentApproval
                      adapter={adapter}
                      flow={flow}
                      intent={intent}
                      records={records}
                      can={can}
                      human={human}
                      prepare={(next) =>
                        setAction({ ...next, scopeFlowId: flow.id })
                      }
                    />
                  )}{" "}
                  {attempt ? (
                    <AttemptDetail
                      capabilities={capabilities}
                      adapter={adapter}
                      refresh={() => void refresh()}
                      flow={flow}
                      intent={intent}
                      attempt={attempt}
                      records={records}
                      can={can}
                      human={human}
                      prepare={(next) =>
                        setAction({ ...next, scopeFlowId: flow.id })
                      }
                    />
                  ) : (
                    <EmptyState>{t("noAttempts")}</EmptyState>
                  )}
                </>
              )}
            </section>
          </div>
          {action && action.scopeFlowId === flowId && (
            <DecisionForm
              key={[
                hub.scopeKey,
                hub.projectId,
                flowId,
                JSON.stringify(action),
              ].join(":")}
              adapter={adapter}
              action={action}
              onCancel={() => setAction(null)}
              onDone={() => {
                setAction(null);
                void refresh();
              }}
            />
          )}
          <AmendmentsPanel
            adapter={adapter}
            records={records}
            flow={flow}
            can={can}
            onDone={() => void refresh()}
          />
          <FlowReview
            key={flow.id + ":" + flow.version}
            adapter={adapter}
            flow={flow}
            records={records}
            can={can}
            onDone={() => void refresh()}
          />
          <DecisionHistory records={records} flow={flow} />
        </>
      )}
      <Button
        variant="ghost"
        onClick={() => hub.navigate({ tab: "flows", flowId: undefined })}
      >
        <ArrowLeft size={13} />
        {t("legacy")}
      </Button>
    </>
  );
}
