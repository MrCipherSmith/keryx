import { useQueryClient } from "@tanstack/react-query";
import { mergeWorkCache, workSnapshotKey } from "./cache";
import { useTranslation } from "react-i18next";
import { ApiError, getClientScope } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import { pendingScope, usePending } from "../../state/pending";
import { isWorkCommand } from "./validation";
import { isObserveCommand } from "./observe-validation";
import { Button, Notice } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { WorkCommand, WorkReceipt } from "./types";

type Operation = {
  status: "idle" | "sending" | "unknown" | "rejected";
  command: WorkCommand | null;
  code: string | null;
  lastReceipt?: WorkReceipt;
};
const initial: Operation = { status: "idle", command: null, code: null };
export function validCommand(value: unknown): value is WorkCommand {
  return isWorkCommand(value) || isObserveCommand(value);
}
export function useWorkOperation(
  adapter: WorkAdapter,
  onCommitted: (receipt: WorkReceipt) => void,
) {
  const hub = useHub();
  const client = useQueryClient();
  const scope = pendingScope("work", hub.principal.id, hub.projectId ?? "", adapter.mode);
  const pending = usePending(scope, validCommand, (v) => v, adapter.mode === "live");
  const [transient, setOperation] = useDraft<Operation>("work-status:" + scope, initial);
  const operation: Operation = pending.value
    ? { status: !pending.error && transient.status === "sending" ? "sending" : "unknown", command: pending.value, code: pending.error ? "pending-storage" : transient.code }
    : pending.error ? { status: "unknown", command: null, code: "pending-storage" } : transient;
  const execute = async (mode: "submit" | "check" | "retry", command?: Omit<WorkCommand, "operationId">) => {
    if (operation.status === "sending" || pending.error || (command && pending.value)) return;
    const value = command ? structuredClone({ ...command, operationId: crypto.randomUUID() }) : pending.value;
    if (!validCommand(value)) {
      setOperation({ ...initial, status: "rejected", code: "invalid-command" });
      return;
    }
    const mutation = mode !== "check";
    if (mutation && !pending.put(value)) return;
    const observation = value.command === "subject.observe";
    const generation = getClientScope();
    setOperation({ status: "sending", command: value, code: null });
    try {
      const receipt = mutation
        ? observation
          ? await adapter.observe(value)
          : await adapter.command(value)
        : await adapter.operation(value.operationId);
      if (generation !== getClientScope()) return;
      if (receipt.status === "pending")
        setOperation({ status: "unknown", command: value, code: "pending" });
      else {
        if (!pending.put(null)) return;
        setOperation({ ...initial, lastReceipt: receipt });
        if (receipt.entities) mergeWorkCache(client, workSnapshotKey(hub.scopeKey, hub.projectId, adapter.mode), receipt.entities.filter((record) => record.projectId === hub.projectId));
        onCommitted(receipt);
      }
    } catch (e) {
      if (generation !== getClientScope()) return;
      // Only a first-send refusal is definite. A later authorization/CAS refusal
      // may precede receipt lookup and cannot disprove the original commit.
      if (mode === "submit" && e instanceof ApiError && e.status >= 400 && e.status < 500) {
        if (!pending.put(null)) return;
        setOperation({ status: "rejected", command: null, code: e.code });
      }
      else setOperation({ status: "unknown", command: value, code: "unknown" });
    }
  };
  return {
    operation,
    run: (command?: Omit<WorkCommand, "operationId">) => command ? execute("submit", command) : execute("check"),
    retry: () => execute("retry"),
    blocked: operation.status === "sending" || operation.status === "unknown",
  };
}
export function WorkOperationStatus({
  adapter,
  onCommitted,
}: {
  adapter: WorkAdapter;
  onCommitted: (receipt: WorkReceipt) => void;
}) {
  const { t } = useTranslation("work");
  const { operation, run, retry } = useWorkOperation(adapter, onCommitted);
  if (operation.status === "idle") return null;
  return (
    <Notice tone={operation.status === "rejected" ? "error" : "info"}>
      {t(
        operation.status === "rejected"
          ? "conflict"
          : operation.status === "sending"
            ? "pending"
            : "unknown",
      )}
      {operation.code === "pending-storage" && <p>{t("pendingStorageError")}</p>}
      {operation.code && <small> ({operation.code})</small>}
      {operation.command && (
        <p>
          {t("operation")}: <code>{operation.command.operationId}</code><br /><code>{operation.command.command}</code><br /><code>{JSON.stringify(Object.fromEntries(Object.entries(operation.command.payload).filter(([key]) => /Id$|^title$/.test(key))))}</code><br /><code>{JSON.stringify(operation.command.expectedVersions)}</code>
        </p>
      )}
      {operation.status === "unknown" && operation.command && (
        <> <Button variant="secondary" onClick={() => void run()}>
          {t("checkOperation")}
        </Button><Button variant="secondary" onClick={() => void retry()}>{t("retryOriginalOperation")}</Button></>
      )}
    </Notice>
  );
}
