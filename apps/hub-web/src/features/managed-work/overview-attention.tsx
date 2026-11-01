import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHub } from "../../app/hub-context";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui";
import { liveWorkAdapter } from "./adapter";
import { useWorkEvents } from "./updates";
import "./work.css";

export function ManagedAttentionOverview({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const { t } = useTranslation("work");
  const [page, setPage] = useState(0);
  const pageSize = 8;
  const visible = projects.slice(page * pageSize, (page + 1) * pageSize);
  if (!projects.length) return null;
  return (
    <section
      className="managed-attention-overview"
      aria-label={t("managedAttention")}
    >
      <header>
        <h2>{t("managedAttention")}</h2>
        <small>
          {t("projectsShown", {
            count: visible.length,
            total: projects.length,
          })}
        </small>
      </header>
      {visible.map((project) => (
        <ProjectAttention key={project.id} project={project} />
      ))}
      {projects.length > pageSize && (
        <div className="work-actions">
          <Button
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t("previousProjects")}
          </Button>
          <Button
            variant="secondary"
            disabled={(page + 1) * pageSize >= projects.length}
            onClick={() => setPage(page + 1)}
          >
            {t("nextProjects")}
          </Button>
        </div>
      )}
    </section>
  );
}
function ProjectAttention({
  project,
}: {
  project: { id: string; name: string };
}) {
  const hub = useHub();
  const { t } = useTranslation("work");
  const adapter = useMemo(() => liveWorkAdapter(project.id), [project.id]);
  const [shown, setShown] = useState(10);
  const capabilities = useQuery({
    queryKey: [hub.scopeKey, project.id, "work", "live", "capabilities"],
    queryFn: async ({ signal }) => {
      try {
        return await adapter.capabilities(signal);
      } catch (error) {
        if (error instanceof ApiError && [404, 501].includes(error.status))
          return null;
        throw error;
      }
    },
    retry: false,
  });
  const attention = useInfiniteQuery({
    queryKey: [hub.scopeKey, project.id, "work", "live", "attention"],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      adapter.attention(pageParam || undefined, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: capabilities.data?.enabled === true,
    retry: false,
  });
  useWorkEvents(adapter, attention.data?.pages.at(-1)?.eventCursor, project.id);
  const items = [
    ...new Map(
      (attention.data?.pages.flatMap((p) => p.records) ?? []).map((r) => [
        r.id,
        r,
      ]),
    ).values(),
  ];
  if (capabilities.isPending)
    return (
      <p className="work-muted">
        {project.name} · {t("loading")}
      </p>
    );
  if (capabilities.error || attention.error)
    return (
      <p className="work-muted">
        {project.name} · {t("attentionError")}
      </p>
    );
  if (!capabilities.data?.enabled || !items.length) return null;
  return (
    <div className="managed-project-attention">
      <strong>{project.name}</strong>
      <div className="work-attention-items">
        {items.slice(0, shown).map((item) => {
          const flowId =
            item.kind === "flow"
              ? item.id
              : "flowId" in item
                ? item.flowId
                : null;
          if (!flowId) return null;
          return (
            <button
              key={item.id}
              onClick={() =>
                hub.navigate({
                  projectId: project.id,
                  tab: "work",
                  flowId,
                  intentId:
                    item.kind === "intent"
                      ? item.id
                      : item.kind === "attempt"
                        ? item.intentId
                        : undefined,
                  attemptId: item.kind === "attempt" ? item.id : undefined,
                })
              }
            >
              <strong>
                {"title" in item
                  ? item.title
                  : "summary" in item
                    ? item.summary
                    : item.id}
              </strong>
              <small>
                {"state" in item ? t("states." + item.state) : ""} · Flow{" "}
                <code>{flowId}</code>
              </small>
            </button>
          );
        })}
      </div>
      <small>{t("itemsShown", { count: Math.min(shown, items.length) })}</small>
      {(items.length > shown || attention.hasNextPage) && (
        <Button
          variant="ghost"
          disabled={attention.isFetchingNextPage}
          onClick={() => {
            setShown(shown + 10);
            if (shown + 10 > items.length && attention.hasNextPage)
              void attention.fetchNextPage();
          }}
        >
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}
