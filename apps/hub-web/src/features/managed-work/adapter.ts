import { ApiError, workJson } from "../../api/client";
import {
  isObject,
  isWorkRecord,
  isWorkEvent,
  isGitObservation,
  isLegacyPreview,
} from "./validation";
import type {
  WorkCapabilities,
  WorkCommand,
  WorkReceipt,
  WorkSnapshot,
  WorkRecord,
  WorkEvent,
  GitObservation,
  DocumentRef,
} from "./types";

export interface WorkAdapter {
  readonly mode: "live" | "demo";
  capabilities(signal?: AbortSignal): Promise<WorkCapabilities>;
  snapshot(signal?: AbortSignal): Promise<WorkSnapshot>;
  command(command: WorkCommand, signal?: AbortSignal): Promise<WorkReceipt>;
  operation(id: string, signal?: AbortSignal): Promise<WorkReceipt>;
  document(
    reference: DocumentRef,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    projectId: string;
    path: string;
    kind: string;
    version: number;
    contentDigest: string;
    content: string;
  }>;
  events(
    cursor: string,
    signal?: AbortSignal,
  ): Promise<{ events: WorkEvent[]; nextCursor: string }>;
  attention(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    records: WorkRecord[];
    nextCursor: string | null;
    eventCursor?: string;
  }>;
  observations(
    subjectId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ observations: GitObservation[]; nextCursor: string | null }>;
  observe(command: WorkCommand, signal?: AbortSignal): Promise<WorkReceipt>;
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
  return {
    operationId,
    status: "committed",
    receiptId: value.receiptId,
    ...(isLegacyPreview(value.preview) ? { preview: value.preview } : {}),
    ...(isGitObservation(value.observation)
      ? { observation: value.observation }
      : {}),
  };
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
          typeof data.eventCursor !== "string" ||
          (data.nextCursor !== null && typeof data.nextCursor !== "string")
        )
          return invalid();
        const nextEventCursor = String(data.eventCursor);
        if (eventCursor !== undefined && eventCursor !== nextEventCursor)
          return invalid();
        eventCursor = nextEventCursor;
        if (data.records.some((r) => r.projectId !== projectId))
          return invalid();
        bytes += new TextEncoder().encode(JSON.stringify(data)).byteLength;
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
      const value = await workJson<unknown>(
        base + "/operations/" + encodeURIComponent(id),
        "GET",
        undefined,
        signal,
      );
      if (
        isObject(value) &&
        value.status === "committed" &&
        isObject(value.result)
      )
        return receipt({ ...value.result, status: "committed" }, id);
      return receipt(value, id);
    },
    async document(reference, signal) {
      const data = await workJson<unknown>(
        base +
          "/documents/" +
          encodeURIComponent(reference.documentId) +
          "/versions/" +
          reference.version +
          "?digest=" +
          encodeURIComponent(reference.contentDigest),
        "GET",
        undefined,
        signal,
      );
      if (!isObject(data) || !isObject(data.document)) return invalid();
      const d = data.document;
      if (
        d.id !== reference.documentId ||
        d.projectId !== projectId ||
        d.version !== reference.version ||
        d.contentDigest !== reference.contentDigest ||
        typeof d.content !== "string" ||
        typeof d.path !== "string" ||
        typeof d.kind !== "string"
      )
        return invalid();
      if (new TextEncoder().encode(d.content).byteLength > 1024 * 1024)
        throw new ApiError(
          413,
          "document-limit",
          "Document exceeds bounded preview",
        );
      return {
        id: reference.documentId,
        projectId,
        path: d.path,
        kind: d.kind,
        version: reference.version,
        contentDigest: reference.contentDigest,
        content: d.content,
      };
    },
    async events(cursor, signal) {
      const data = await workJson<unknown>(
        base + "/events?limit=1000&after=" + encodeURIComponent(cursor),
        "GET",
        undefined,
        signal,
      );
      if (
        !isObject(data) ||
        !Array.isArray(data.events) ||
        data.events.length > 1000 ||
        !data.events.every(isWorkEvent) ||
        typeof data.nextCursor !== "string" ||
        data.events.some((e) => e.projectId !== projectId) ||
        new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024
      )
        return invalid();
      return { events: data.events, nextCursor: data.nextCursor };
    },
    async attention(cursor, signal) {
      const data = await workJson<unknown>(
        base +
          "/attention?limit=50" +
          (cursor ? "&afterId=" + encodeURIComponent(cursor) : ""),
        "GET",
        undefined,
        signal,
      );
      if (
        !isObject(data) ||
        !Array.isArray(data.records) ||
        data.records.length > 50 ||
        !data.records.every(isWorkRecord) ||
        data.records.some(
          (r) =>
            r.projectId !== projectId ||
            !["flow", "intent", "attempt"].includes(r.kind),
        ) ||
        (data.nextCursor !== null && typeof data.nextCursor !== "string")
      )
        return invalid();
      return {
        records: data.records,
        nextCursor: data.nextCursor,
        ...(typeof data.eventCursor === "string"
          ? { eventCursor: data.eventCursor }
          : {}),
      };
    },
    async observations(subjectId, cursor, signal) {
      const data = await workJson<unknown>(
        base +
          "/subjects/" +
          encodeURIComponent(subjectId) +
          "/observations?limit=50" +
          (cursor ? "&afterId=" + encodeURIComponent(cursor) : ""),
        "GET",
        undefined,
        signal,
      );
      if (
        !isObject(data) ||
        !Array.isArray(data.observations) ||
        data.observations.length > 50 ||
        !data.observations.every(isGitObservation) ||
        data.observations.some(
          (o) => o.projectId !== projectId || o.subjectId !== subjectId,
        ) ||
        (data.nextCursor !== null && typeof data.nextCursor !== "string")
      )
        return invalid();
      return { observations: data.observations, nextCursor: data.nextCursor };
    },
    async observe(command, signal) {
      if (typeof command.payload.subjectId !== "string") return invalid();
      const data = await workJson<unknown>(
        base +
          "/subjects/" +
          encodeURIComponent(command.payload.subjectId) +
          "/observe",
        "POST",
        {
          operationId: command.operationId,
          expectedVersions: command.expectedVersions,
          payload: { subjectDigest: command.payload.subjectDigest },
        },
        signal,
        command.operationId,
      );
      if (isObject(data) && data.status === "pending")
        return receipt(data, command.operationId);
      if (
        !isObject(data) ||
        !isGitObservation(data.observation) ||
        data.observation.projectId !== projectId ||
        data.observation.subjectId !== command.payload.subjectId ||
        data.observation.subjectDigest !== command.payload.subjectDigest
      )
        return invalid();
      return receipt({ ...data, status: "committed" }, command.operationId);
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
