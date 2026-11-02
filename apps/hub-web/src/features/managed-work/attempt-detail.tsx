import { CanonicalIntentReview } from "../acceptance/canonical";
import { AttemptResult, AttemptEvidence } from "./attempt-artifacts";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import {
  Button,
  Notice} from "../../components/ui";
import { type WorkAdapter } from "./adapter";
import {
  aggregateVersions,
  criterionHasExactPassingEvidence,
  pendingAmendments,
  recordOf,
  recordsOf,
  requirementDrift} from "./model";
import type {
  Attempt,
  WorkCapabilities,
  WorkFlow,
  WorkIntent,
  WorkRecord} from "./types";
import { SubmissionForm } from "./contribute";
import { RevisionReview, ExactDocument } from "./revision-review";
import { GitObservations } from "./observations";

import type { PreparedAction } from "./work-types";
import { WorkBadge } from "./work-panels";

export function AttemptDetail({
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
  const technical = (
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
      <AttemptResult subject={subject} />
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
      <AttemptEvidence criteria={revision?.criteria ?? []} evidence={evidence} />
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
      {submission && <section><h3>{t("knowledge")}</h3><code>{submission.contentDigest}</code><p>{submission.knowledgeFollowup.noUpdateReason??t("noKnowledge")}</p><Button variant="danger" disabled={!eligible||!selected||!can("review.decide")} onClick={()=>make("review.decide",t("reject"),"reject")}>{t("reject")}</Button></section>}
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
  if(submission&&subject&&revision&&(flow.state!=="in-review"||hub.location.intentId))return <CanonicalIntentReview adapter={adapter} flow={flow} intent={intent} attempt={attempt} submission={submission} records={records} can={can} refresh={refresh} technical={<>{technical}{evidence.map(item=><details key={item.id} id={"review-evidence-"+item.id}><summary>{item.method}</summary><p>{item.report}</p><code>{item.subjectDigest}</code></details>)}</>} selection={<Button variant="secondary" disabled={!eligible||!can("attempt.select")||selected||["active","unknown"].includes(attempt.executionOutcome)} onClick={()=>make("attempt.select",t("select"))}>{t(selected?"selected":"select")}</Button>}/>;
  return technical;

}
export function DecisionHistory({
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
