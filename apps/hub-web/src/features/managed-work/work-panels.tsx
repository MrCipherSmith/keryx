import { useTranslation } from "react-i18next";
import {
  Button,
  Notice} from "../../components/ui";
import { type WorkAdapter } from "./adapter";
import {
  aggregateVersions,
  flowStartReady,
  recordOf,
  recordsOf} from "./model";
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
