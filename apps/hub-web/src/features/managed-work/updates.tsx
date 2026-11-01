import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { Button } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord } from "./types";

/** Work cursors are opaque and independent from document/machine cursors. */
export function useWorkEvents(
  adapter: WorkAdapter,
  eventCursor: string | undefined,
  projectOverride?: string,
) {
  const hub = useHub();
  const client = useQueryClient();
  const projectId = projectOverride ?? hub.projectId;
  const [status, setStatus] = useState<"waiting" | "connected" | "retrying">(
    "waiting",
  );
  const cache = useRef({ client, scopeKey: hub.scopeKey, projectId });
  cache.current = { client, scopeKey: hub.scopeKey, projectId };
  useEffect(() => {
    if (adapter.mode === "demo" || !eventCursor) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = eventCursor;
    let failures = 0;
    const invalidate = () => {
      const current = cache.current;
      void current.client.invalidateQueries({
        queryKey: [current.scopeKey, current.projectId, "work", adapter.mode],
      });
    };
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void poll(), 15000);
        return;
      }
      try {
        const page = await adapter.events(cursor, controller.signal);
        if (controller.signal.aborted) return;
        cursor = page.nextCursor;
        failures = 0;
        setStatus("connected");
        // Event content is only an invalidation hint. Fetch canonical records;
        // never execute commands, trust hints or cache writes from event text.
        if (page.events.length) invalidate();
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        setStatus("retrying");
        if (error instanceof ApiError && [409, 410].includes(error.status)) {
          invalidate();
          return;
        }
      }
      timer = setTimeout(
        () => void poll(),
        Math.min(30000, 2000 * 2 ** Math.min(failures, 4)),
      );
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [adapter, eventCursor]);
  return status;
}

export function WorkAttention({
  adapter,
  records,
  onSelect,
}: {
  adapter: WorkAdapter;
  records: WorkRecord[];
  onSelect: (flowId: string, intentId?: string, attemptId?: string) => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const query = useInfiniteQuery({
    queryKey: [hub.scopeKey, hub.projectId, "work", adapter.mode, "attention"],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      adapter.attention(pageParam || undefined, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const items = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.records) ?? []).map((r) => [r.id, r]),
    ).values(),
  ];
  if (query.isPending || (!items.length && !query.error)) return null;
  return (
    <section className="work-attention">
      <h2>
        {t("attention")} <span>{items.length}</span>
      </h2>
      {query.error ? (
        <p>{t("attentionError")}</p>
      ) : (
        <div className="work-attention-items">
          {items.map((item) => {
            const flowId =
              item.kind === "flow"
                ? item.id
                : "flowId" in item
                  ? item.flowId
                  : null;
            if (!flowId) return null;
            const parent = records.find(
              (r) => r.kind === "flow" && r.id === flowId,
            );
            return (
              <button
                key={item.id}
                onClick={() =>
                  onSelect(
                    flowId,
                    item.kind === "intent"
                      ? item.id
                      : item.kind === "attempt"
                        ? item.intentId
                        : undefined,
                    item.kind === "attempt" ? item.id : undefined,
                  )
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
                  {parent && "title" in parent ? parent.title : flowId} ·{" "}
                  {"state" in item ? t("states." + item.state) : ""}
                </small>
              </button>
            );
          })}
        </div>
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
