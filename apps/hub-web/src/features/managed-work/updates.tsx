import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { Button } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord, WorkSnapshot } from "./types";
import { EVENT_RECORD_LIMIT, changedEventIds, fetchEventRecords, loadWorkSnapshot, mergeWorkCache, onWorkPollRequest, workSnapshotKey } from "./cache";

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
  const initialCursor = useRef(eventCursor);
  initialCursor.current = eventCursor;
  const hasCursor = !!eventCursor;
  useEffect(() => {
    if (!hasCursor) return;
    const controller = new AbortController();
    const key = workSnapshotKey(hub.scopeKey, projectId, adapter.mode);
    const attentionKey = [hub.scopeKey, projectId, "work", adapter.mode, "attention"];
    const observationsKey = [hub.scopeKey, projectId, "work", adapter.mode, "observations"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = initialCursor.current!;
    let failures = 0;
    let idlePages = 0;
    let busy = false;
    let again = false;
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void poll(), HIDDEN_POLL_MS);
        return;
      }
      busy = true;
      try {
        const page = await adapter.events(cursor, controller.signal);
        if (controller.signal.aborted) return;
        const snapshot = client.getQueryData<WorkSnapshot>(key);
        if (changedEventIds(snapshot, page.events).length > EVENT_RECORD_LIMIT) {
          // One canonical read replaces a per-record fan-out on bursts.
          const fresh = await loadWorkSnapshot(client, key, adapter, controller.signal);
          if (controller.signal.aborted) return;
          client.setQueryData(key, fresh);
        } else {
          const records = await fetchEventRecords(adapter, snapshot, page.events, controller.signal);
          if (controller.signal.aborted) return;
          mergeWorkCache(client, key, records);
        }
        if (page.events.some((event) => event.entityType === "git-observation")) {
          // Observations have a separate read model, not a WorkRecord ID. Only
          // active subject queries are refreshed; exact documents stay untouched.
          void client.invalidateQueries({ queryKey: observationsKey, refetchType: "active" });
        }
        // Any event can change attention, including one whose record a receipt
        // already merged, so it does not depend on records being fetched.
        if (page.events.length) void client.invalidateQueries({ queryKey: attentionKey, exact: true });
        cursor = page.nextCursor;
        failures = 0;
        idlePages = page.events.length ? 0 : idlePages + 1;
        setStatus("connected");
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        setStatus("retrying");
        if (error instanceof ApiError && [409, 410].includes(error.status)) {
          try {
            // Retention gaps require one canonical resync. Keep the loop alive even
            // when the server returns the same opaque cursor or the resync fails.
            if (client.getQueryData(key)) {
              const snapshot = await loadWorkSnapshot(client, key, adapter, controller.signal);
              if (controller.signal.aborted) return;
              client.setQueryData(key, snapshot);
              cursor = snapshot.eventCursor;
              // Events lost in the gap never arrive, so derived read models refresh too.
              void client.invalidateQueries({ queryKey: attentionKey, exact: true });
              void client.invalidateQueries({ queryKey: observationsKey, refetchType: "active" });
            } else {
              const page = await adapter.attention(undefined, controller.signal);
              if (controller.signal.aborted) return;
              client.setQueryData(attentionKey, { pages: [page], pageParams: [""] });
              if (page.eventCursor) cursor = page.eventCursor;
            }
          } catch {
            if (controller.signal.aborted) return;
          }
        }
      } finally {
        busy = false;
      }
      const delay = again ? 0 : Math.min(MAX_POLL_MS, ACTIVE_POLL_MS * 2 ** Math.min(failures || idlePages, 4));
      again = false;
      timer = setTimeout(() => void poll(), delay);
    };
    // A local commit polls now instead of waiting out the idle back-off.
    const stopWaking = onWorkPollRequest(client, key, () => {
      idlePages = 0;
      if (busy) {
        again = true;
        return;
      }
      if (timer) clearTimeout(timer);
      void poll();
    });
    void poll();
    return () => {
      controller.abort();
      stopWaking();
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
