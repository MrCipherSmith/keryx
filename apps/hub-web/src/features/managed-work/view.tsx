import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  GitBranch,
  CheckCircle2,
  Layers,
  RefreshCw,
} from "lucide-react";
import { useHub } from "../../app/hub-context";
import { ApiError } from "../../api/client";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeading,
  Select,
  Textarea,
} from "../../components/ui";
import { useDraft } from "../../state/drafts";
import { liveWorkAdapter, type WorkAdapter } from "./adapter";
import { demoWorkAdapter } from "./demo";
import {
  aggregateVersions,
  exactPassingCoverage,
  criterionHasExactPassingEvidence,
  pendingAmendments,
  flowStartReady,
  recordOf,
  recordsOf,
  requirementDrift,
} from "./model";
import type {
  Attempt,
  Criterion,
  WorkCapabilities,
  WorkCommand,
  WorkFlow,
  WorkIntent,
  WorkRecord,
} from "./types";
import { useWorkOperation, WorkOperationStatus } from "./operation";
import { ContributionPanel, SubmissionForm } from "./contribute";
import { LegacyConversion } from "./legacy";
import { RevisionReview, ExactDocument } from "./revision-review";
import { AmendmentsPanel } from "./amendments";
import { GitObservations } from "./observations";
import { WorkAttention, useWorkEvents } from "./updates";
import { FlowReview } from "./flow-review";
import "./work.css";

type PreparedAction = Omit<WorkCommand, "operationId"> & {
  title: string;
  help: string;
  waiverCriteria?: Criterion[];
  scopeFlowId?: string;
};
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
function WorkBadge({ value }: { value: string }) {
  const { t } = useTranslation("work");
  return (
    <span className={"work-badge work-state-" + value}>
      {t("states." + value, { defaultValue: value })}
    </span>
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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
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
  const flows = recordsOf(records, "flow");
  const flow = recordOf(records, "flow", flowId);
  const intents = flow
    ? recordsOf(records, "intent").filter((i) => i.flowId === flow.id)
    : [];
  const intent = intents.find((i) => i.id === intentId) ?? intents[0];
  const currentIntentRevision = recordOf(
    records,
    "intent-revision",
    intent?.currentRevisionId,
  );
  const attempts = intent
    ? recordsOf(records, "attempt").filter((a) => a.intentId === intent.id)
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
        <>
          <div className="work-filters">
            <Input
              aria-label={t("search")}
              placeholder={t("search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label={t("all")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{t("all")}</option>
              {[
                "draft",
                "ready",
                "in-progress",
                "in-review",
                "accepted",
                "cancelled",
              ].map((state) => (
                <option key={state} value={state}>
                  {t("states." + state)}
                </option>
              ))}
            </Select>
          </div>
          {flows.length ? (
            <div className="work-flow-list">
              {flows
                .filter(
                  (f) =>
                    (!filter || f.state === filter) &&
                    f.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((f) => {
                  const children = recordsOf(records, "intent").filter(
                    (i) => i.flowId === f.id && i.required,
                  );
                  const accepted = children.filter(
                    (i) =>
                      i.state === "accepted" &&
                      i.currentRevisionId === i.approvedRevisionId,
                  ).length;
                  return (
                    <button
                      className="work-flow-row"
                      key={f.id}
                      onClick={() => {
                        setFlow(f.id);
                        setIntent(null);
                        setAttempt(null);
                      }}
                    >
                      <GitBranch size={18} />
                      <span>
                        <strong>{f.title}</strong>
                        <small>
                          {t("owner")}: {f.ownerId ?? "—"}
                        </small>
                      </span>
                      <WorkBadge value={f.state} />
                      <span className="work-progress">
                        <span>
                          {t("progress", { accepted, total: children.length })}
                        </span>
                        <progress
                          aria-label={t("progress", {
                            accepted,
                            total: children.length,
                          })}
                          max={Math.max(children.length, 1)}
                          value={accepted}
                        />
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  );
                })}
            </div>
          ) : (
            <EmptyState>{t("empty")}</EmptyState>
          )}
        </>
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
            <section className="work-intents">
              <h2>
                <Layers size={16} />
                {t("intents")} <span>{intents.length}</span>
              </h2>
              {intents.map((i) => (
                <button
                  key={i.id}
                  className={
                    "work-intent " + (i.id === intent?.id ? "is-selected" : "")
                  }
                  onClick={() => {
                    setIntent(i.id);
                    setAttempt(null);
                    setAction(null);
                  }}
                >
                  <span className="work-intent-title">{i.title}</span>
                  <WorkBadge value={i.state} />
                  <small>
                    {t(i.required ? "required" : "optional")} ·{" "}
                    {i.ownerId ?? "—"}
                  </small>
                </button>
              ))}
            </section>
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
function IntentApproval({
  adapter,
  flow,
  intent,
  records,
  can,
  human,
  prepare,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  intent: WorkIntent;
  records: WorkRecord[];
  can: (c: string) => boolean;
  human: boolean;
  prepare: (a: PreparedAction) => void;
}) {
  const { t } = useTranslation("work");
  const revision = recordOf(
    records,
    "intent-revision",
    intent.currentRevisionId,
  );
  if (!revision) return null;
  return (
    <div className="work-review">
      <RevisionReview
        adapter={adapter}
        revision={revision}
        records={records}
        expanded
      />
      <ul>
        {revision.criteria.map((c) => (
          <li key={c.criterionId}>{c.text}</li>
        ))}
      </ul>
      <Button
        disabled={
          !human ||
          !can("requirements.approve") ||
          revision.flowRevisionId !== flow.approvedRevisionId
        }
        onClick={() =>
          prepare({
            title: t("approve"),
            help: t("approveHelp"),
            command: "requirements.approve",
            expectedVersions: aggregateVersions(flow, intent),
            payload: {
              targetType: "intent-revision",
              revisionId: revision.id,
              revisionDigest: revision.contentDigest,
              flowRevisionId: revision.flowRevisionId,
            },
          })
        }
      >
        {t("approve")}
      </Button>
    </div>
  );
}
function FlowSummary({
  adapter,
  flow,
  records,
  can,
  human,
  prepare,
}: {
  adapter: WorkAdapter;
  flow: WorkFlow;
  records: WorkRecord[];
  can: (c: string) => boolean;
  human: boolean;
  prepare: (a: PreparedAction) => void;
}) {
  const { t } = useTranslation("work");
  const revision = recordOf(records, "flow-revision", flow.currentRevisionId);
  const required = recordsOf(records, "intent").filter(
    (i) => i.flowId === flow.id && i.required,
  );
  const exactSet =
    required.length > 0 &&
    required.length === revision?.requiredIntentIds.length &&
    required.every((i) => revision?.requiredIntentIds.includes(i.id));
  return (
    <section className="work-flow-summary">
      <div className="work-section-heading">
        <h2>{flow.title}</h2>
        <WorkBadge value={flow.state} />
      </div>
      {revision && (
        <>
          {flow.approvedRevisionId &&
            flow.approvedRevisionId !== revision.id && (
              <Notice>{t("proposedNotApproved")}</Notice>
            )}
          <p>{revision.expectedOutcome}</p>
          <RevisionReview
            adapter={adapter}
            revision={revision}
            records={records}
            expanded={flow.state === "draft"}
          />
          {flow.approvedRevisionId &&
            flow.approvedRevisionId !== revision.id &&
            (() => {
              const approved = recordOf(
                records,
                "flow-revision",
                flow.approvedRevisionId,
              );
              return approved ? (
                <div>
                  <h4>{t("approvedRequirements")}</h4>
                  <RevisionReview
                    adapter={adapter}
                    revision={approved}
                    records={records}
                  />
                </div>
              ) : null;
            })()}
          <div className="work-pin">
            <span>
              {t("revision")} {revision.revision}
            </span>
            <code>{revision.contentDigest}</code>
          </div>
          <details>
            <summary>
              {t("criteria")} · {revision.criteria.length}
            </summary>
            <ul>
              {revision.criteria.map((c) => (
                <li key={c.criterionId}>{c.text}</li>
              ))}
            </ul>
          </details>
          {flow.state === "draft" && (
            <Button
              disabled={!human || !can("requirements.approve") || !exactSet}
              title={
                !human
                  ? t("humanOnly")
                  : !can("requirements.approve")
                    ? t("noPermission")
                    : undefined
              }
              onClick={() =>
                prepare({
                  title: t("approve"),
                  help: t("approveHelp"),
                  command: "requirements.approve",
                  expectedVersions: aggregateVersions(flow),
                  payload: {
                    targetType: "flow-revision",
                    revisionId: revision.id,
                    revisionDigest: revision.contentDigest,
                    flowRevisionId: revision.id,
                  },
                })
              }
            >
              {t("approve")}
            </Button>
          )}
          {flow.state === "ready" && (
            <Button
              disabled={!can("flow.start") || !flowStartReady(records, flow)}
              onClick={() =>
                prepare({
                  title: t("start"),
                  help: revision.expectedOutcome,
                  command: "flow.start",
                  expectedVersions: {
                    ...aggregateVersions(flow),
                    ...Object.fromEntries(
                      required.map((i) => [i.id, i.version]),
                    ),
                  },
                  payload: {
                    flowId: flow.id,
                    flowRevisionDigest: revision.contentDigest,
                  },
                })
              }
            >
              {t("start")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
function AttemptDetail({
  capabilities,
  adapter,
  refresh,
  flow,
  intent,
  attempt,
  records,
  can,
  human,
  prepare,
}: {
  capabilities: WorkCapabilities;
  adapter: WorkAdapter;
  refresh: () => void;
  flow: WorkFlow;
  intent: WorkIntent;
  attempt: Attempt;
  records: WorkRecord[];
  can: (c: string) => boolean;
  human: boolean;
  prepare: (a: PreparedAction) => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const submission = recordOf(records, "submission", attempt.submissionId);
  const subject =
    recordOf(records, "subject", submission?.subjectId) ??
    recordsOf(records, "subject").filter((subject) => subject.attemptId === attempt.id).at(-1);
  const context = recordOf(records, "context", attempt.contextSnapshotId);
  const links = recordsOf(records, "execution-link").filter(
    (l) => l.attemptId === attempt.id,
  );
  const evidence = recordsOf(records, "evidence").filter(
    (e) =>
      e.subjectId === subject?.id && e.subjectDigest === subject?.contentDigest,
  );
  const revision = recordOf(
    records,
    "intent-revision",
    attempt.intentRevisionId,
  );
  const pendingAmendment = pendingAmendments(records, flow.id).length > 0;
  const drift = requirementDrift(flow, intent, attempt);
  const sealed =
    !!submission && submission.subjectDigest === subject?.contentDigest;
  const eligible =
    human &&
    !drift &&
    !pendingAmendment &&
    sealed &&
    attempt.state === "submitted" &&
    intent.state === "in-review" &&
    !["accepted", "cancelled"].includes(flow.state);
  const selected = intent.selectedSubmissionId === submission?.id;
  const make = (command: string, title: string, decision?: string) => {
    if (!submission) return;
    prepare({
      command,
      title,
      waiverCriteria:
        decision === "accept"
          ? revision?.criteria.filter(
              (c) =>
                c.waivable &&
                !criterionHasExactPassingEvidence(
                  records,
                  submission,
                  c.criterionId,
                ),
            )
          : undefined,
      help: t(command === "attempt.select" ? "selectionHelp" : "acceptHelp"),
      expectedVersions: aggregateVersions(flow, intent, attempt),
      payload:
        command === "attempt.select"
          ? {
              intentId: intent.id,
              attemptId: attempt.id,
              submissionId: submission.id,
              submissionDigest: submission.contentDigest,
            }
          : {
              targetType: "intent-review",
              targetId: intent.id,
              submissionId: submission.id,
              submissionDigest: submission.contentDigest,
              decision,
              waivers: [],
            },
    });
  };
  return (
    <div className="work-attempt-detail">
      {drift && <Notice>{t("stale")}</Notice>}
      {pendingAmendment && <Notice>{t("pendingAmendment")}</Notice>}

      {revision && (
        <RevisionReview
          adapter={adapter}
          revision={revision}
          records={records}
        />
      )}
      <p>{attempt.summary}</p>
      <div className="work-meta">
        <span>
          {t("contributor")}: <strong>{attempt.participantId}</strong>
        </span>
        <WorkBadge value={attempt.method} />
        {sealed && <span>{t("sealed")}</span>}
      </div>
      <section>
        <h3>{t("result")}</h3>
        {subject ? (
          <>
            <p>{subject.report}</p>
            {subject.artifacts.map((artifact, index) => (
              <div className="work-artifact" key={index}>
                {artifact.kind === "git" ? (
                  <>
                    <GitBranch size={14} />
                    <strong>{artifact.repositoryId}</strong>
                    <code>{artifact.commitOid}</code>
                    <WorkBadge value={artifact.verification} />
                    {artifact.pullRequest && (
                      <span>PR #{artifact.pullRequest.number}</span>
                    )}
                  </>
                ) : artifact.kind === "document" ? (
                  <>
                    <strong>{artifact.reference.documentId}</strong>
                    <span>
                      {t("revision")} {artifact.reference.version}
                    </span>
                    <code>{artifact.reference.contentDigest}</code>
                  </>
                ) : artifact.kind === "report" ? (
                  <p>{artifact.text}</p>
                ) : (
                  <code>{artifact.revisionId}</code>
                )}
              </div>
            ))}
            <div className="work-pin">
              <span>{t("subjectDigest")}</span>
              <code>{subject.contentDigest}</code>
            </div>
          </>
        ) : (
          <p>{t("resultMissing")}</p>
        )}
      </section>
      {subject?.artifacts.some((a) => a.kind === "git") && (
        <GitObservations
          adapter={adapter}
          subject={subject}
          versions={aggregateVersions(flow, intent, attempt)}
          enabled={capabilities.features.gitObserver}
          canObserve={can("subject.create")}
          onDone={refresh}
        />
      )}
      <section>
        <h3>{t("evidence")}</h3>
        {revision?.criteria.map((criterion) => {
          const matches = evidence.filter((e) =>
            e.criterionIds.includes(criterion.criterionId),
          );
          return (
            <div className="work-criterion" key={criterion.criterionId}>
              <strong>{criterion.text}</strong>
              {matches.length ? (
                matches.map((e) => (
                  <details key={e.id}>
                    <summary>
                      <WorkBadge value={e.result} />
                      <span>{e.method}</span>
                      <small>
                        {e.source === "contributor-report"
                          ? t("selfReport")
                          : e.source}
                      </small>
                    </summary>
                    <p>{e.report}</p>
                    <small>
                      {e.source === "contributor-report"
                        ? t("selfReport")
                        : e.source}{" "}
                      · {e.createdBy}
                    </small>
                    <code>{e.subjectDigest}</code>
                  </details>
                ))
              ) : (
                <WorkBadge value="missing" />
              )}
            </div>
          );
        })}
        {!evidence.length && <p>{t("noEvidence")}</p>}
      </section>
      {!submission &&
        can("attempt.submit") &&
        ["draft", "running", "blocked"].includes(attempt.state) && (
          <SubmissionForm
            adapter={adapter}
            records={records}
            flow={flow}
            intent={intent}
            attempt={attempt}
            onDone={refresh}
          />
        )}
      {submission && (
        <section className="work-review">
          <h3>
            {t(
              intent.state === "accepted"
                ? "states.accepted"
                : attempt.state === "submitted"
                  ? "needsReview"
                  : "states." + attempt.state,
            )}
          </h3>
          <div className="work-pin">
            <span>{t("submissionDigest")}</span>
            <code>{submission.contentDigest}</code>
          </div>
          <p>{t("selectionHelp")}</p>
          <div className="work-actions">
            <Button
              variant="secondary"
              disabled={!eligible || !can("attempt.select") || selected}
              onClick={() => make("attempt.select", t("select"))}
            >
              {t(selected ? "selected" : "select")}
            </Button>
            <Button
              disabled={
                !eligible ||
                !selected ||
                !can("review.decide") ||
                !exactPassingCoverage(
                  records,
                  submission,
                  revision?.criteria
                    .filter((c) => c.waivable)
                    .map((c) => c.criterionId) ?? [],
                )
              }
              onClick={() => make("review.decide", t("accept"), "accept")}
            >
              {t("accept")}
            </Button>
            <Button
              variant="secondary"
              disabled={!eligible || !selected || !can("review.decide")}
              onClick={() =>
                make("review.decide", t("requestChanges"), "request-changes")
              }
            >
              {t("requestChanges")}
            </Button>
            <Button
              variant="danger"
              disabled={!eligible || !selected || !can("review.decide")}
              onClick={() => make("review.decide", t("reject"), "reject")}
            >
              {t("reject")}
            </Button>
          </div>
          {!human && <small>{t("humanOnly")}</small>}
          <p className="work-muted">{t("acceptHelp")}</p>
          <h4>{t("knowledge")}</h4>
          <p>
            {submission.knowledgeFollowup.noUpdateReason ?? t("noKnowledge")}
          </p>
          {submission.knowledgeFollowup.proposalIds.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </section>
      )}
      <details>
        <summary>{t("context")}</summary>
        <div className="work-pin">
          <span>{t("pinned")}</span>
          <code>
            {attempt.flowRevisionId} / {attempt.intentRevisionId}
          </code>
        </div>
        {context ? (
          <>
            <code>{context.contentDigest}</code>
            {context.entries.map((entry) => (
              <div key={entry.entryId} className="work-meta">
                {entry.role} · {entry.reference?.documentId ?? "—"} ·{" "}
                {entry.reference?.version ?? "—"} · {entry.resolution} ·{" "}
                {entry.provenance}
                {entry.reference && (
                  <ExactDocument
                    adapter={adapter}
                    reference={entry.reference}
                  />
                )}
              </div>
            ))}
          </>
        ) : (
          <p>{t("noContext")}</p>
        )}
        <p>{t("unverified")}</p>
      </details>
      <details>
        <summary>
          {t("runs")} · {links.length}
        </summary>
        {attempt.method === "human" && <p>{t("manual")}</p>}
        {!links.length && <p>{t("noRuns")}</p>}
        {links.map((link) => (
          <div className="work-linked-run" key={link.id}>
            <strong>
              {link.machineId} · {link.checkoutId}
            </strong>
            <code>{link.runId}</code>
            <span>{link.contextObservation}</span>
            <Button
              variant="secondary"
              onClick={() =>
                hub.navigate({
                  tab: "sessions",
                  sessionId: link.sessionId,
                  runId: link.runId,
                  machineId: link.machineId,
                })
              }
            >
              {t("session")}
            </Button>
          </div>
        ))}
      </details>
    </div>
  );
}
function DecisionHistory({
  records,
  flow,
}: {
  records: WorkRecord[];
  flow: WorkFlow;
}) {
  const { t } = useTranslation("work");
  const ids = new Set([
    flow.id,
    ...recordsOf(records, "intent")
      .filter((i) => i.flowId === flow.id)
      .map((i) => i.id),
  ]);
  for (const r of records) {
    if (r.kind === "amendment" && r.flowId === flow.id) ids.add(r.id);
    if (r.kind === "flow-revision" && r.flowId === flow.id) ids.add(r.id);
    if (r.kind === "intent-revision" && ids.has(r.intentId)) {
      ids.add(r.id);
      r.criteria.forEach((c) => ids.add(c.criterionId));
    }
  }
  const decisions = recordsOf(records, "decision").filter((d) =>
    ids.has(d.targetId),
  );
  return (
    <section className="work-history">
      <h2>{t("decisions")}</h2>
      {decisions.length ? (
        decisions.map((d) => (
          <article key={d.id}>
            <WorkBadge value={d.decision} />
            <strong>{d.createdBy}</strong>
            <time>{new Date(d.createdAt).toLocaleString()}</time>
            <p>{d.reason}</p>
            <code>{d.targetDigest}</code>
          </article>
        ))
      ) : (
        <p>{t("noDecision")}</p>
      )}
    </section>
  );
}
function DecisionForm({
  adapter,
  action,
  onCancel,
  onDone,
}: {
  adapter: WorkAdapter;
  action: PreparedAction;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [reason, setReason] = useDraft(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      action.command,
      JSON.stringify(action.payload),
      "work-reason",
    ].join(":"),
    "",
  );
  const [waivers, setWaivers] = useDraft<Record<string, string>>(
    [
      hub.scopeKey,
      hub.projectId,
      adapter.mode,
      action.command,
      JSON.stringify(action.payload),
      "work-waivers",
    ].join(":"),
    {},
  );
  const waiverCriteria = action.waiverCriteria ?? [];
  const completeWaivers = waiverCriteria.every(
    (c) =>
      typeof waivers[c.criterionId] === "string" &&
      waivers[c.criterionId].trim().length > 0,
  );
  const { blocked, run } = useWorkOperation(adapter, onDone);
  return (
    <form
      className="work-decision-form"
      aria-label={action.title}
      onSubmit={(e) => {
        e.preventDefault();
        if (action.scopeFlowId !== hub.location.flowId) return;
        void run({
          command: action.command,
          expectedVersions: action.expectedVersions,
          payload: {
            ...action.payload,
            ...(action.command === "review.decide" &&
            action.payload.decision === "accept"
              ? {
                  waivers: waiverCriteria.map((c) => ({
                    criterionId: c.criterionId,
                    reason: waivers[c.criterionId]?.trim() ?? "",
                  })),
                }
              : {}),
            ...(action.command === "flow.start"
              ? {}
              : { reason: reason.trim() }),
          },
        });
      }}
    >
      <h2>{action.title}</h2>
      <p>{action.help}</p>
      {typeof action.payload.submissionDigest === "string" && (
        <code>{action.payload.submissionDigest}</code>
      )}
      {typeof action.payload.revisionDigest === "string" && (
        <code>{action.payload.revisionDigest}</code>
      )}
      {action.command !== "flow.start" && (
        <Field label={t("reason")}>
          <Textarea
            autoFocus
            value={reason}
            maxLength={4000}
            required
            disabled={blocked}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      {waiverCriteria.length > 0 && (
        <fieldset className="work-waivers">
          <legend>{t("waiver")}</legend>
          <p>{t("waiverHelp")}</p>
          {waiverCriteria.map((criterion) => (
            <div key={criterion.criterionId}>
              <label>
                <input
                  type="checkbox"
                  checked={criterion.criterionId in waivers}
                  disabled={blocked}
                  onChange={(e) => {
                    const next = { ...waivers };
                    if (e.target.checked) next[criterion.criterionId] = "";
                    else delete next[criterion.criterionId];
                    setWaivers(next);
                  }}
                />{" "}
                {criterion.text}
              </label>
              {criterion.criterionId in waivers && (
                <Field label={t("waiverReason") + " · " + criterion.text}>
                  <Textarea
                    required
                    maxLength={4000}
                    disabled={blocked}
                    value={waivers[criterion.criterionId]}
                    onChange={(e) =>
                      setWaivers({
                        ...waivers,
                        [criterion.criterionId]: e.target.value,
                      })
                    }
                  />
                </Field>
              )}
            </div>
          ))}
        </fieldset>
      )}
      <div className="work-actions">
        <Button
          type="submit"
          disabled={
            blocked ||
            !completeWaivers ||
            (action.command !== "flow.start" && !reason.trim())
          }
        >
          {t("confirm")}
        </Button>
        <Button variant="secondary" disabled={blocked} onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

function CreateFlow({
  adapter,
  onDone,
}: {
  adapter: WorkAdapter;
  onDone: () => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [draft, setDraft] = useDraft(
    hub.scopeKey + ":" + hub.projectId + ":work-create",
    {
      title: "",
      problem: "",
      expectedOutcome: "",
      scope: "",
      outOfScope: "",
      criteria: "",
      allowWaivers: false,
    },
  );
  const { blocked, run } = useWorkOperation(adapter, onDone);
  return (
    <form
      className="work-create"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          expectedVersions: {},
          command: "flow.create",
          payload: {
            title: draft.title.trim(),
            problem: draft.problem.trim(),
            expectedOutcome: draft.expectedOutcome.trim(),
            scope: draft.scope.trim(),
            outOfScope: draft.outOfScope.trim(),
            ownerId: hub.principal.id,
            specification: null,
            criteria: draft.criteria
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => ({
                criterionId: crypto.randomUUID(),
                text: line.trim(),
                waivable: draft.allowWaivers,
              })),
          },
        });
      }}
    >
      <h2>{t("newFlow")}</h2>
      <p>{t("createHelp")}</p>
      {(
        [
          "title",
          "problem",
          "expectedOutcome",
          "scope",
          "outOfScope",
          "criteria",
        ] as const
      ).map((key) => (
        <Field
          key={key}
          label={t(
            {
              title: "flowTitle",
              problem: "problem",
              expectedOutcome: "outcome",
              scope: "scope",
              outOfScope: "outOfScope",
              criteria: "criteriaInput",
            }[key],
          )}
        >
          {key === "title" ? (
            <Input
              required
              maxLength={500}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          ) : (
            <Textarea
              required
              maxLength={key === "criteria" ? 8000 : 10000}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <label className="work-checkbox">
        <input
          type="checkbox"
          checked={draft.allowWaivers}
          onChange={(e) =>
            setDraft({ ...draft, allowWaivers: e.target.checked })
          }
        />{" "}
        {t("allowWaivers")}
      </label>
      <Button type="submit" disabled={blocked}>
        {t("create")}
      </Button>
    </form>
  );
}
