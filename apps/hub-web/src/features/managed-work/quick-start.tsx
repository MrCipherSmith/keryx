import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, errorMessage, getClientScope } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { Button } from "../../components/ui";
import { useDraft } from "../../state/drafts";
import type { WorkAdapter } from "./adapter";
import { mergeWorkCache, requestWorkRefresh, workAttentionKey, workSnapshotKey } from "./cache";
import type { QuickStartRequest } from "./quick-contract";
import { quickStartRequest, type QuickDraft } from "./quick-request";
import { emptyQuickDraft, QuickStartDialog, type QuickPhase } from "./quick-start-dialog";
import { unresolved, type Pending } from "./quick-start-unresolved";

/**
 * One submission at a time. A definite refusal (4xx) forgets the operation id, so the next try is a new operation.
 * Anything ambiguous (lost connection, 5xx) keeps the id and the exact request, and only Retry may send them again:
 * the server replays the stored receipt, so a retry can never create a second Flow.
 */
function useQuickStart(adapter: WorkAdapter, onCreated: (flowId: string, sent: QuickDraft) => void) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const client = useQueryClient();
  const storeKey = hub.scopeKey + ":" + hub.projectId + ":" + adapter.mode;
  const restored = unresolved.get(storeKey);
  const [phase, setPhase] = useState<QuickPhase>(
    restored
      ? { status: "unknown", message: restored.inFlight ? t("quickStart.interrupted") : restored.message }
      : { status: "idle" },
  );
  const pending = useRef<Pending | null>(restored?.pending ?? null);
  const busy = useRef(false);
  const created = useRef(onCreated);
  created.current = onCreated;

  const forget = () => {
    pending.current = null;
    unresolved.delete(storeKey);
  };

  const attempt = async (next: Pending) => {
    if (busy.current) return;
    busy.current = true;
    pending.current = next;
    unresolved.set(storeKey, { pending: next, message: "", inFlight: true });
    setPhase({ status: "sending" });
    const generation = getClientScope();
    try {
      const outcome = await adapter.quickStart(next.id, next.request);
      if (generation !== getClientScope()) {
        forget();
        return;
      }
      forget();
      setPhase({ status: "idle" });
      const snapshot = workSnapshotKey(hub.scopeKey, hub.projectId, adapter.mode);
      if (outcome.receipt.entities)
        mergeWorkCache(client, snapshot, outcome.receipt.entities.filter((record) => record.projectId === hub.projectId));
      requestWorkRefresh(client, snapshot);
      // A quick start creates a Flow and an Intent the receipt may not carry: read the snapshot now instead of waiting for the feed.
      void client.invalidateQueries({ queryKey: snapshot, exact: true, refetchType: "active" });
      void client.invalidateQueries({
        queryKey: workAttentionKey(hub.scopeKey, hub.projectId, adapter.mode),
        exact: true,
        refetchType: "active",
      });
      created.current(outcome.flowId, next.draft);
    } catch (error) {
      if (generation !== getClientScope()) {
        forget();
        setPhase({ status: "idle" });
        return;
      }
      const message = error instanceof ApiError && error.code === "invalid-body" ? t("quickStart.tooBig") : errorMessage(error);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        forget();
        setPhase({ status: "rejected", message });
      } else {
        unresolved.set(storeKey, { pending: next, message, inFlight: false });
        setPhase({ status: "unknown", message });
      }
    } finally {
      busy.current = false;
    }
  };
  return {
    phase,
    submit: (request: QuickStartRequest, draft: QuickDraft) => attempt({ id: crypto.randomUUID(), request, draft }),
    retry: () => {
      if (pending.current) void attempt(pending.current);
    },
    startOver: () => {
      forget();
      setPhase({ status: "idle" });
    },
  };
}

/** The "New task" button and its dialog. The operation state outlives the dialog, so closing it never loses a pending retry. */
export function QuickStart({
  adapter,
  onCreated,
}: {
  adapter: WorkAdapter;
  onCreated: (flowId: string) => void;
}) {
  const { t } = useTranslation("work");
  const hub = useHub();
  const [open, setOpen] = useState(false);
  const [draft, setDraft, clearDraft] = useDraft(
    hub.scopeKey + ":" + hub.projectId + ":work-quick-start",
    emptyQuickDraft,
  );
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Closing hands focus back to the button that opened the dialog, even when that click never focused it.
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const operation = useQuickStart(adapter, (flowId, sent) => {
    clearDraft(sent);
    setOpen(false);
    onCreated(flowId);
  });
  const canSubmit =
    draft.description.trim().length > 0 &&
    operation.phase.status !== "sending" &&
    operation.phase.status !== "unknown";
  const submit = () => {
    if (!canSubmit) return;
    void operation.submit(quickStartRequest(draft), draft);
  };
  return (
    <>
      <Button
        variant="secondary"
        onClick={(event) => {
          trigger.current = event.currentTarget;
          setOpen(true);
        }}
      >
        {t("quickStart.open")}
      </Button>
      {open &&
        createPortal(
          <QuickStartDialog
            draft={draft}
            phase={operation.phase}
            canSubmit={canSubmit}
            onChange={setDraft}
            onSubmit={submit}
            onRetry={operation.retry}
            onStartOver={operation.startOver}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}
