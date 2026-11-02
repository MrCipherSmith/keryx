import {useMemo} from "react";
import {useTranslation} from "react-i18next";
import {GitBranch} from "lucide-react";
import {WorkBadge} from "./work-panels";
import type {Criterion, EvidenceRecord, ResultSubject} from "./types";
export function AttemptResult({subject}:{subject?:ResultSubject}) {
 const {t}=useTranslation("work");
 return (      <section>
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
      </section>);
}
export function AttemptEvidence({criteria,evidence}:{criteria:Criterion[];evidence:EvidenceRecord[]}) {
 const {t}=useTranslation("work");
  const evidenceByCriterion = useMemo(() => {
    const index = new Map<string, typeof evidence>();
    for (const item of evidence) for (const criterionId of item.criterionIds) {
      const items = index.get(criterionId) ?? []; items.push(item); index.set(criterionId, items);
    }
    return index;
  }, [evidence]);
 return (      <section>
        <h3>{t("evidence")}</h3>
        {criteria.map((criterion) => {
          const matches = evidenceByCriterion.get(criterion.criterionId) ?? [];
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
      </section>);
}
