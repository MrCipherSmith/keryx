import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { Button, Notice } from "../../components/ui";
import { recordOf } from "./model";
import type { WorkAdapter } from "./adapter";
import type {
  DocumentRef,
  FlowRevision,
  IntentRevision,
  WorkRecord,
} from "./types";

export function ExactDocument({
  adapter,
  reference,
}: {
  adapter: WorkAdapter;
  reference: DocumentRef;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: [
      hub.scopeKey,
      hub.projectId,
      "work",
      adapter.mode,
      "document",
      reference.documentId,
      reference.version,
      reference.contentDigest,
    ],
    queryFn: ({ signal }) => adapter.document(reference, signal),
    enabled: open,
    retry: false,
  });
  return (
    <div className="work-exact-document">
      <Button variant="ghost" onClick={() => setOpen(!open)}>
        {t("exactDocumentView")} · {reference.documentId} · v{reference.version}
      </Button>
      <code>{reference.contentDigest}</code>
      {open &&
        (query.isPending ? (
          <p>{t("loading")}</p>
        ) : query.error ? (
          <Notice tone="error">{t("exactDocumentUnavailable")}</Notice>
        ) : query.data ? (
          <article>
            <strong>{query.data.path}</strong>
            <pre>{query.data.content}</pre>
          </article>
        ) : null)}
    </div>
  );
}

export function RevisionReview({
  adapter,
  revision,
  records,
  expanded = false,
}: {
  adapter: WorkAdapter;
  revision: FlowRevision | IntentRevision;
  records: WorkRecord[];
  expanded?: boolean;
}) {
  const { t } = useTranslation("work");
  const parent =
    revision.kind === "intent-revision"
      ? recordOf(records, "flow-revision", revision.flowRevisionId)
      : undefined;
  const fields: { label: string; value: string }[] =
    revision.kind === "flow-revision"
      ? [
          { label: "problem", value: revision.problem },
          { label: "outcome", value: revision.expectedOutcome },
          { label: "scope", value: revision.scope },
          { label: "outOfScope", value: revision.outOfScope },
        ]
      : [
          { label: "deliverable", value: revision.deliverable },
          { label: "approach", value: revision.approach },
          { label: "outOfScope", value: revision.outOfScope },
        ];
  const content = (
    <>
      <div className="work-pin">
        <span>
          {t("revision")} {revision.revision}
        </span>
        <code>{revision.id}</code>
        <code>{revision.contentDigest}</code>
      </div>
      <dl>
        {fields.map((field) => (
          <div key={field.label}>
            <dt>{t(field.label)}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      {revision.kind === "flow-revision" ? (
        <>
          <h4>{t("specification")}</h4>
          {revision.specification ? (
            <ExactDocument
              adapter={adapter}
              reference={revision.specification}
            />
          ) : (
            <p>{t("noSpecification")}</p>
          )}
          <h4>{t("requiredIntents")}</h4>
          <ul>
            {revision.requiredIntentIds.map((id) => (
              <li key={id}>
                {recordOf(records, "intent", id)?.title ?? id} ·{" "}
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h4>{t("parentFlowRevision")}</h4>
          <code>{revision.flowRevisionId}</code>
          <code>{parent?.contentDigest ?? "—"}</code>
          <h4>{t("criterionMapping")}</h4>
          <ul>
            {revision.criterionMappings.map((m) => (
              <li key={m.intentCriterionId + ":" + m.flowCriterionId}>
                <strong>
                  {revision.criteria.find(
                    (c) => c.criterionId === m.intentCriterionId,
                  )?.text ?? m.intentCriterionId}
                </strong>{" "}
                →{" "}
                {parent?.criteria.find(
                  (c) => c.criterionId === m.flowCriterionId,
                )?.text ?? m.flowCriterionId}
                <code>
                  {m.intentCriterionId} → {m.flowCriterionId}
                </code>
              </li>
            ))}
          </ul>
          <h4>{t("flowCriterionIds")}</h4>
          {revision.flowCriterionIds.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </>
      )}
      <h4>{t("criteria")}</h4>
      <ul>
        {revision.criteria.map((c) => (
          <li key={c.criterionId}>
            <strong>{c.text}</strong>
            <code>{c.criterionId}</code>
            <small>{t(c.waivable ? "allowWaivers" : "unwaivable")}</small>
          </li>
        ))}
      </ul>
    </>
  );
  return expanded ? (
    <section
      className="work-revision-review"
      aria-label={t("fullRequirements")}
    >
      <h3>{t("fullRequirements")}</h3>
      {content}
    </section>
  ) : (
    <details className="work-revision-review">
      <summary>
        {t("fullRequirements")} · v{revision.revision}
      </summary>
      {content}
    </details>
  );
}
