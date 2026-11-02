import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getJson } from "../api/client";
import type { CodeRevisionSummary } from "../api/types";
import { useHub } from "../app/hub-context";
import { Button } from "../components/ui";

type RevisionPage = { revisions: CodeRevisionSummary[]; nextCursor?: string };
export function useRevisionPages(projectOverride?: string) {
  const hub = useHub();
  const projectId = projectOverride ?? hub.projectId;
  const query = useInfiniteQuery({
    queryKey: [hub.scopeKey, projectId, "revisions", "pages"],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => getJson<RevisionPage>(`/projects/${encodeURIComponent(projectId ?? "")}/revisions?summary=1${pageParam ? "&afterId=" + encodeURIComponent(pageParam) : ""}`, signal),
    getNextPageParam: page => page.nextCursor || undefined,
    enabled: !!projectId,
  });
  return { ...query, data: query.data ? { revisions: [...new Map(query.data.pages.flatMap(page => page.revisions).map(row => [row.id, row])).values()] } : undefined };
}
export function useRevisionSummary(id: string | null | undefined, enabled = true) {
  const hub = useHub();
  return useQuery({
    queryKey: [hub.scopeKey, hub.projectId, "revision-summary", id],
    queryFn: ({ signal }) => getJson<CodeRevisionSummary>(`/projects/${encodeURIComponent(hub.projectId ?? "")}/revisions/${encodeURIComponent(id ?? "")}?summary=1`, signal),
    enabled: enabled && !!hub.projectId && !!id,
  });
}
export function MoreRevisions({ query }: { query: ReturnType<typeof useRevisionPages> }) {
  const { t } = useTranslation("context");
  return query.hasNextPage ? <Button type="button" variant="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t("loadMoreRevisions")}</Button> : null;
}
