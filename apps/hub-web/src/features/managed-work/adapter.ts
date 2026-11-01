import { ApiError, workJson } from "../../api/client";
import { isObject, isWorkRecord } from "./validation";
import type {
  WorkCapabilities,
  WorkCommand,
  WorkReceipt,
  WorkSnapshot,
  WorkRecord,
} from "./types";

export interface WorkAdapter {
  readonly mode: "live" | "demo";
  capabilities(signal?: AbortSignal): Promise<WorkCapabilities>;
  snapshot(signal?: AbortSignal): Promise<WorkSnapshot>;
  command(command: WorkCommand, signal?: AbortSignal): Promise<WorkReceipt>;
  operation(id: string, signal?: AbortSignal): Promise<WorkReceipt>;
  acceptancePreview(
    flowId: string,
    signal?: AbortSignal,
  ): Promise<{
    acceptanceManifestDigest: string;
    flowRevisionId: string;
    acceptedIntentDecisionIds: string[];
  }>;
}
function invalid(): never {
  throw new ApiError(502, "invalid-response", "Invalid work protocol response");
}
function receipt(value: unknown, operationId: string): WorkReceipt {
  if (!isObject(value) || value.operationId !== operationId) return invalid();
  if (value.status === "pending") return { operationId, status: "pending" };
  const committedEnvelope =
    Array.isArray(value.entities) &&
    value.entities.every(isWorkRecord) &&
    typeof value.eventCursor === "string";
  if (
    typeof value.receiptId !== "string" ||
    (value.status !== "committed" && !committedEnvelope)
  )
    return invalid();
  return { operationId, status: "committed", receiptId: value.receiptId };
}
export function liveWorkAdapter(projectId: string): WorkAdapter {
  const base = "/projects/" + encodeURIComponent(projectId);
  return {
    mode: "live",
    async capabilities(signal) {
      const data = await workJson<unknown>(
        base + "/capabilities",
        "GET",
        undefined,
        signal,
      );
      if (
        !isObject(data) ||
        data.protocolVersion !== 1 ||
        typeof data.enabled !== "boolean" ||
        !Array.isArray(data.allowedCommands) ||
        !data.allowedCommands.every((c) => typeof c === "string") ||
        !isObject(data.features) ||
        !isObject(data.limits)
      )
        return invalid();
      if (
        !["managedExecution", "gitObserver", "legacyConversion"].every(
          (k) =>
            typeof data.features === "object" &&
            data.features !== null &&
            k in data.features &&
            typeof Reflect.get(data.features, k) === "boolean",
        )
      )
        return invalid();
      return {
        protocolVersion: 1,
        enabled: data.enabled,
        allowedCommands: data.enabled ? data.allowedCommands : [],
        limits: data.limits,
        features: data.features,
      } as WorkCapabilities;
    },
    async snapshot(signal) {
      // Stage all pages; no partial snapshot is published to the view.
      const records: WorkRecord[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let eventCursor: string | undefined;
      let bytes = 0;
      do {
        const data: unknown = await workJson<unknown>(
          base +
            "/snapshot?limit=200" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          "GET",
          undefined,
          signal,
        );
        if (
          !isObject(data) ||
          !Array.isArray(data.records) ||
          data.records.length > 200 ||
          !data.records.every(isWorkRecord) ||
          !["string", "number"].includes(typeof data.eventCursor) ||
          (data.nextCursor !== null && typeof data.nextCursor !== "string")
        )
          return invalid();
        const nextEventCursor = String(data.eventCursor);
        if (eventCursor !== undefined && eventCursor !== nextEventCursor)
          return invalid();
        eventCursor = nextEventCursor;
        if (data.records.some((r) => r.projectId !== projectId))
          return invalid();
        bytes += JSON.stringify(data).length;
        if (bytes > 20 * 1024 * 1024 || cursors.size >= 500)
          throw new ApiError(413, "snapshot-limit", "Snapshot is too large");
        records.push(...data.records);
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
        if (cursor && cursors.has(cursor)) return invalid();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { records, actions: [], eventCursor: eventCursor ?? "" };
    },
    async command(command, signal) {
      return receipt(
        await workJson<unknown>(
          base + "/commands",
          "POST",
          command,
          signal,
          command.operationId,
        ),
        command.operationId,
      );
    },
    async operation(id, signal) {
      return receipt(
        await workJson<unknown>(
          base + "/operations/" + encodeURIComponent(id),
          "GET",
          undefined,
          signal,
        ),
        id,
      );
    },
    async acceptancePreview(flowId, signal) {
      const value = await workJson<unknown>(
        base + "/flows/" + encodeURIComponent(flowId) + "/acceptance-preview",
        "GET",
        undefined,
        signal,
      );
      if (
        !isObject(value) ||
        value.flowId !== flowId ||
        typeof value.flowRevisionId !== "string" ||
        typeof value.acceptanceManifestDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.acceptanceManifestDigest) ||
        !Array.isArray(value.acceptedIntents)
      )
        return invalid();
      const ids: string[] = [];
      for (const intent of value.acceptedIntents) {
        if (!isObject(intent) || typeof intent.decisionId !== "string")
          return invalid();
        ids.push(intent.decisionId);
      }
      return {
        acceptanceManifestDigest: value.acceptanceManifestDigest,
        flowRevisionId: value.flowRevisionId,
        acceptedIntentDecisionIds: ids,
      };
    },
  };
}
