import { useTranslation } from "react-i18next";
import { ApiError, getClientScope } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
import { pendingScope, usePending } from "../../state/pending";
import { isObject } from "./validation";
import { Button, Notice } from "../../components/ui";
import type { WorkAdapter } from "./adapter";
import type { WorkCommand, WorkReceipt } from "./types";
import { isWorkCommand } from "./validation";

type Operation = {
  status: "idle" | "sending" | "unknown" | "rejected";
  command: WorkCommand | null;
  code: string | null;
  lastReceipt?: WorkReceipt;
};
const initial: Operation = { status: "idle", command: null, code: null };
export function validCommand(value: unknown): value is WorkCommand {
  if (isWorkCommand(value)) return true;
  return isObject(value) && Object.keys(value).sort().join() === "command,expectedVersions,operationId,payload" &&
    value.command === "subject.observe" && typeof value.operationId === "string" && /^[\x20-\x7e]{1,200}$/.test(value.operationId) &&
    isObject(value.payload) && typeof value.payload.subjectId === "string" && /^[\x20-\x7e]{1,200}$/.test(value.payload.subjectId) &&
    typeof value.payload.subjectDigest === "string" && /^[a-f0-9]{64}$/.test(value.payload.subjectDigest) && Object.keys(value.payload).length === 2 &&
    isObject(value.expectedVersions) && Object.keys(value.expectedVersions).length > 0 && Object.keys(value.expectedVersions).length <= 200 &&
    Object.values(value.expectedVersions).every((v) => Number.isSafeInteger(v) && Number(v) >= 1);
}
export function useWorkOperation(
  adapter: WorkAdapter,
  onCommitted: (receipt: WorkReceipt) => void,
) {
  const hub = useHub();
  const scope = pendingScope("work", hub.principal.id, hub.projectId ?? "", adapter.mode);
  const pending = usePending(scope, validCommand, (v) => v, adapter.mode === "live");
  const [transient, setOperation] = useDraft<Operation>("work-status:" + scope, initial);
  const operation: Operation = pending.value
    ? { status: !pending.error && transient.status === "sending" ? "sending" : "unknown", command: pending.value, code: pending.error ? "pending-storage" : transient.code }
    : pending.error ? { status: "unknown", command: null, code: "pending-storage" } : transient;
  const run = async (command?: Omit<WorkCommand, "operationId">, retryOriginal = false) => {
    if (operation.status === "sending" || pending.error || (command && pending.value)) return;
    const value = command ? structuredClone({ ...command, operationId: crypto.randomUUID() }) : pending.value;
    if (!validCommand(value)) {
      setOperation({ ...initial, status: "rejected", code: "invalid-command" });
      return;
    }
    const mutation = !!command || retryOriginal;
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
        onCommitted(receipt);
      }
    } catch (e) {
      if (generation !== getClientScope()) return;
      // Only a first-send refusal is definite. A later authorization/CAS refusal
      // may precede receipt lookup and cannot disprove the original commit.
      if (command && e instanceof ApiError && e.status >= 400 && e.status < 500) {
        if (!pending.put(null)) return;
        setOperation({ status: "rejected", command: null, code: e.code });
      }
      else setOperation({ status: "unknown", command: value, code: "unknown" });
    }
  };
  return {
    operation,
    run,
    retry: () => run(undefined, true),
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
