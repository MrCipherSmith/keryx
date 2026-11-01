import { useTranslation } from "react-i18next";
import { ApiError, getClientScope } from "../../api/client";
import { useHub } from "../../app/hub-context";
import { useDraft } from "../../state/drafts";
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
export function useWorkOperation(
  adapter: WorkAdapter,
  onCommitted: (receipt: WorkReceipt) => void,
) {
  const hub = useHub();
  const [operation, setOperation] = useDraft<Operation>(
    [hub.scopeKey, hub.projectId, adapter.mode, "work-operation"].join(":"),
    initial,
  );
  const run = async (command?: Omit<WorkCommand, "operationId">) => {
    if (operation.status === "sending" || (command && operation.command))
      return;
    const value = command
      ? { ...command, operationId: crypto.randomUUID() }
      : operation.command;
    const observation = value?.command === "subject.observe";
    const validObservation =
      observation &&
      typeof value.payload.subjectId === "string" &&
      typeof value.payload.subjectDigest === "string" &&
      /^[a-f0-9]{64}$/.test(value.payload.subjectDigest) &&
      Object.keys(value.payload).length === 2 &&
      Object.keys(value.expectedVersions).length > 0 &&
      Object.values(value.expectedVersions).every(
        (v) => Number.isSafeInteger(v) && v >= 1,
      );
    if (!value || (!isWorkCommand(value) && !validObservation)) {
      setOperation({ ...initial, status: "rejected", code: "invalid-command" });
      return;
    }
    const generation = getClientScope();
    setOperation({ status: "sending", command: value, code: null });
    try {
      const receipt = command
        ? observation
          ? await adapter.observe(value)
          : await adapter.command(value)
        : await adapter.operation(value.operationId);
      if (generation !== getClientScope()) return;
      if (receipt.status === "pending")
        setOperation({ status: "unknown", command: value, code: "pending" });
      else {
        setOperation({ ...initial, lastReceipt: receipt });
        onCommitted(receipt);
      }
    } catch (e) {
      if (generation !== getClientScope()) return;
      // A lookup failure cannot turn an uncertain mutation into a definite refusal.
      if (command && e instanceof ApiError && e.status >= 400 && e.status < 500)
        setOperation({ status: "rejected", command: null, code: e.code });
      else setOperation({ status: "unknown", command: value, code: "unknown" });
    }
  };
  return {
    operation,
    run,
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
  const { operation, run } = useWorkOperation(adapter, onCommitted);
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
      {operation.code && <small> ({operation.code})</small>}
      {operation.command && (
        <p>
          {t("operation")}: <code>{operation.command.operationId}</code>
        </p>
      )}
      {operation.status === "unknown" && (
        <Button variant="secondary" onClick={() => void run()}>
          {t("checkOperation")}
        </Button>
      )}
    </Notice>
  );
}
