import { useTranslation } from "react-i18next";
import {
  Button,
  Notice} from "../../components/ui";
import { type WorkAdapter } from "./adapter";
import {
  activeRequiredIntents,
  aggregateVersions,
  flowStartReady,
  pendingAmendments,
  recordOf,
} from "./model";
import type {
  WorkFlow,
  WorkIntent,
  WorkRecord} from "./types";
import { RevisionReview} from "./revision-review";

import type { PreparedAction } from "./work-types";

export function WorkBadge({ value }: { value: string }) {
  const { t } = useTranslation("work");
  return (
    <span className={"work-badge work-state-" + value}>
      {t("states." + value, { defaultValue: value })}
    </span>
  );
}
export function IntentApproval({
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
export function FlowSummary({
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
  const required = activeRequiredIntents(records,flow.id);
  const exactSet =
    required.length > 0 &&
    required.length === revision?.requiredIntentIds.length &&
    required.every((i) => revision?.requiredIntentIds.includes(i.id));
  const fastStart = human && can("flow.approve-and-start") &&
    (flow.state === "draft" || flow.state === "ready");
  const results = required
    .filter((intent) => flow.state === "draft" || revision?.requiredIntentIds.includes(intent.id))
    .map((intent) => ({ intent, revision: recordOf(records, "intent-revision", intent.currentRevisionId) }));
  const mapped = new Set(results.flatMap((result) =>
    result.revision?.criterionMappings.map((mapping) => mapping.flowCriterionId) ?? []));
  const missing = results.length
    ? revision?.criteria.filter((criterion) => !mapped.has(criterion.criterionId)) ?? []
    : [];
  const planBlocked = pendingAmendments(records, flow.id).length > 0 ||
    (flow.state === "ready" && (flow.approvedRevisionId !== revision?.id ||
      !results.length || results.length !== revision?.requiredIntentIds.length)) ||
    results.some((result) => !result.revision ||
      (!!result.intent.approvedRevisionId && (result.intent.approvedRevisionId !== result.revision.id ||
        result.revision.flowRevisionId !== revision?.id)) ||
      result.revision.flowCriterionIds.some((id) => !revision?.criteria.some((criterion) => criterion.criterionId === id)));
  const startPlan = () => {
    if (!revision || planBlocked || missing.length) return;
    const reviewed = results.flatMap(({ intent, revision: result }) => result
      ? [{ intent, result }]
      : []);
    prepare({
      title: t("approveAndStart"),
      help: t("approveAndStartHelp"),
      command: "flow.approve-and-start",
      expectedVersions: {
        ...aggregateVersions(flow),
        ...Object.fromEntries(reviewed.map(({ intent }) => [intent.id, intent.version])),
      },
      payload: {
        flowId: flow.id,
        flowRevisionDigest: revision.contentDigest,
        intents: reviewed.map(({ intent, result }) => ({
          intentId: intent.id,
          revisionId: result.id,
          revisionDigest: result.contentDigest,
        })),
      },
      plan: {
        criteria: revision.criteria.map((criterion) => criterion.text),
        results: reviewed.length
          ? reviewed.map(({ intent, result }) => ({
              title: intent.title,
              deliverable: result.deliverable,
              criteria: result.criteria.map((criterion) => criterion.text),
            }))
          : [{ title: flow.title, deliverable: revision.expectedOutcome, criteria: [] }],
      },
    });
  };
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
            expanded={!fastStart && flow.state === "draft"}
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
          {fastStart && (
            <>
              {planBlocked && <Notice>{t("startPlanBlocked")}</Notice>}
              {missing.length > 0 && (
                <Notice>
                  {t("startCoverageMissing")}
                  <ul>{missing.map((criterion) => <li key={criterion.criterionId}>{criterion.text}</li>)}</ul>
                </Notice>
              )}
              <Button disabled={planBlocked || missing.length > 0} onClick={startPlan}>
                {t("approveAndStart")}
              </Button>
            </>
          )}
          {!fastStart && flow.state === "draft" && (
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
          {!fastStart && flow.state === "ready" && (
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
