import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { Button, Notice } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { ResultSubject } from "./types";
import { useWorkOperation } from "./operation";

export function GitObservations({
  adapter,
  subject,
  versions,
  enabled,
  canObserve,
  onDone,
}: {
  adapter: WorkAdapter;
  subject: ResultSubject;
  versions: Record<string, number>;
  enabled: boolean;
  canObserve: boolean;
  onDone: () => void;
}) {
  const hub = useHub();
  const { t } = useTranslation("work");
  const client = useQueryClient();
  const key = [
    hub.scopeKey,
    hub.projectId,
    "work",
    adapter.mode,
    "observations",
    subject.id,
  ];
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      adapter.observations(subject.id, pageParam || undefined, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const { run, blocked } = useWorkOperation(adapter, () => {
    void client.invalidateQueries({ queryKey: key });
    onDone();
  });
  const observations = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.observations) ?? []).map((o) => [
        o.id,
        o,
      ]),
    ).values(),
  ].sort((a, b) => b.generation - a.generation);
  const availability = (value: string) =>
    t(
      value === "available"
        ? "available"
        : value === "unavailable"
          ? "unavailableObject"
          : value === "identity-mismatch"
            ? "identityMismatch"
            : "notConfigured",
    );
  return (
    <section className="work-observations">
      <h3>{t("gitObservations")}</h3>
      <p>{t("observationHelp")}</p>
      <Button
        variant="secondary"
        disabled={blocked || !enabled || !canObserve}
        onClick={() =>
          void run({
            command: "subject.observe",
            expectedVersions: versions,
            payload: {
              subjectId: subject.id,
              subjectDigest: subject.contentDigest,
            },
          })
        }
      >
        {t("observeGit")}
      </Button>
      {!enabled && <p>{t("observerDisabled")}</p>}
      {query.error ? (
        <Notice tone="error">{t("observationError")}</Notice>
      ) : !observations.length ? (
        <p>{t("noObservations")}</p>
      ) : (
        observations.map((observation) => (
          <details
            key={observation.id}
            open={observation.id === observations[0]?.id}
          >
            <summary>
              {t("generation")} {observation.generation} ·{" "}
              {observation.observedAt}
            </summary>
            <div className="work-pin">
              <code>{observation.subjectDigest}</code>
              <span>{observation.createdBy}</span>
            </div>
            {observation.artifacts.map((artifact, index) => (
              <article key={artifact.repositoryId + ":" + index}>
                <strong>{artifact.repositoryId}</strong>
                <p>
                  {t("availability")}: {availability(artifact.availability)}
                </p>
                <code>{artifact.commitOid}</code>
                {artifact.pullRequest && (
                  <>
                    <p>
                      PR #{artifact.pullRequest.number} ·{" "}
                      <code>{artifact.pullRequest.headOid}</code>
                    </p>
                    {artifact.pullRequest.headOid !== artifact.commitOid && (
                      <Notice tone="error">{t("prDrift")}</Notice>
                    )}
                  </>
                )}
                <p>CI: {availability(artifact.ci.availability)}</p>
                {artifact.ci.runs.map((run) => (
                  <div
                    className="work-ci-run"
                    key={run.runId + ":" + run.runAttempt}
                  >
                    <strong>
                      {run.trusted ? t("trustedCi") : t("untrustedCi")}
                    </strong>
                    <span>{run.workflowPath}</span>
                    <span>
                      {run.status} · {run.conclusion ?? "—"}
                    </span>
                    <code>{run.headOid}</code>
                  </div>
                ))}
              </article>
            ))}
          </details>
        ))
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("loadMore")}
        </Button>
      )}
    </section>
  );
}
