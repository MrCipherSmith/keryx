import { ApiError } from "../../api/client";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord } from "./types";

export function attentionTarget(item: WorkRecord, records: WorkRecord[]) {
  const subject = item.kind === "evidence"
    ? records.find(record => record.kind === "attempt" && record.id === item.attemptId)
    : item;
  if (!subject) return null;
  if (subject.kind === "flow") return { flowId: subject.id };
  if (subject.kind === "intent") return { flowId: subject.flowId, intentId: subject.id };
  if (subject.kind === "attempt") return { flowId: subject.flowId, intentId: subject.intentId, attemptId: subject.id };
  return null;
}

export async function resolveAttentionTarget(item: WorkRecord, records: WorkRecord[], adapter: WorkAdapter) {
  const cached = attentionTarget(item, records);
  if (cached) return cached;
  if (item.kind === "evidence") {
    const { record: parent } = await adapter.record(item.attemptId);
    if (parent.kind === "attempt") return attentionTarget(parent, []);
  }
  throw new ApiError(502, "invalid-response", "Attention parent is unavailable");
}

export function attentionLabel(item: WorkRecord) {
  return "title" in item ? item.title : "summary" in item ? item.summary : item.kind === "evidence" ? item.report : item.id;
}
