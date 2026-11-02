import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { Button } from "../../components/ui";
import { attentionTarget, attentionLabel, resolveAttentionTarget } from "./attention-target";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord, WorkSnapshot } from "./types";
import { fetchEventRecords, mergeWorkCache, mergeSnapshotCache, subscribeWorkRefresh, workSnapshotKey, workAttentionKey, workObservationsKey } from "./cache";

const ACTIVE_POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;
const MAX_POLL_MS = 30000;

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
  const latestCursor = useRef(eventCursor);
  latestCursor.current = eventCursor;
  const hasCursor = !!eventCursor;
  useEffect(() => {
    if (adapter.mode === "demo" || !hasCursor) return;
    const controller = new AbortController();
    const key = workSnapshotKey(hub.scopeKey, projectId, adapter.mode);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = latestCursor.current!;
    let failures = 0;
    let idlePages = 0;
    let running = false;
    let requested = false;
    const attentionKey = workAttentionKey(hub.scopeKey, projectId, adapter.mode);
    const observationsKey = workObservationsKey(hub.scopeKey, projectId, adapter.mode);
    const refreshRelated = (observations: boolean) => {
      void client.invalidateQueries({queryKey:attentionKey,exact:true,refetchType:"active"});
      if (observations) void client.invalidateQueries({queryKey:observationsKey,refetchType:"active"});
    };
    const applyEventPage = async (page: Awaited<ReturnType<WorkAdapter["events"]>>) => {
      const snapshot = client.getQueryData<WorkSnapshot>(key);
      const records = await fetchEventRecords(adapter, snapshot, page.events, controller.signal);
      if (controller.signal.aborted) return;
      mergeWorkCache(client, key, records);
      if (page.events.length) refreshRelated(page.events.some((event) => event.entityType === "git-observation"));
    };
    const resyncAfterGap = async () => {
      if (client.getQueryData(key)) {
        const snapshot = await adapter.snapshot(controller.signal);
        if (controller.signal.aborted) return;
        mergeSnapshotCache(client, key, snapshot);
        refreshRelated(true);
        return snapshot.eventCursor;
      }
      const page = await adapter.attention(undefined, controller.signal);
      if (controller.signal.aborted) return;
      client.setQueryData(attentionKey, {pages:[page],pageParams:[""]});
      void client.invalidateQueries({queryKey:observationsKey,refetchType:"active"});
      return page.eventCursor;
    };
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (running) { requested = true; return; }
      if (document.visibilityState === "hidden" && !requested) {
        timer = setTimeout(() => void poll(), HIDDEN_POLL_MS);
        return;
      }
      running = true;
      requested = false;
      try {
        const page = await adapter.events(cursor, controller.signal);
        if (controller.signal.aborted) return;
        await applyEventPage(page);
        if (controller.signal.aborted) return;
        cursor = page.nextCursor;
        failures = 0;
        idlePages = page.events.length ? 0 : idlePages + 1;
        setStatus("connected");
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        setStatus("retrying");
        if (error instanceof ApiError && [409,410].includes(error.status)) {
          try {
            const next = await resyncAfterGap();
            if (next) cursor = next;
          } catch {
            // A failed canonical resync remains visibly retrying; keep its cursor.
          }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), requested ? 0 : Math.min(MAX_POLL_MS, ACTIVE_POLL_MS * 2 ** Math.min(failures || idlePages,4)));
      }
    };
    const unsubscribe = subscribeWorkRefresh(client,key,() => {
      idlePages = 0;
      requested = true;
      if (timer) clearTimeout(timer);
      if (!running) void poll();
    });
    void poll();
    return () => {
      unsubscribe();
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [adapter, hasCursor, hub.scopeKey, projectId, client]);
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
  const [selectionError, setSelectionError] = useState(false);
  const query = useInfiniteQuery({
    queryKey: workAttentionKey(hub.scopeKey, hub.projectId, adapter.mode),
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
            const target = attentionTarget(item, records);
            const flowId = target?.flowId;
            const parent = records.find(
              (r) => r.kind === "flow" && r.id === flowId,
            );
            return (
              <button
                key={item.id}
                onClick={async () => {
                  setSelectionError(false);
                  try {
                    const selected = await resolveAttentionTarget(item, records, adapter);
                    if (selected) onSelect(selected.flowId, selected.intentId, selected.attemptId);
                  } catch { setSelectionError(true); }
                }}
              >
                <strong>
                  {attentionLabel(item)}
                </strong>
                <small>
                  {parent && "title" in parent ? parent.title : flowId} ·{" "}
                  {"state" in item ? t("states." + item.state) : item.kind === "evidence" ? item.result : ""}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {selectionError && <p role="alert">{t("attentionError")}</p>}
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
