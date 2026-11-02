import { recordOf, recordsOf } from "./model";
import type { AmendmentManifest, WorkFlow, WorkRecord } from "./types";

/**
 * Every live Intent can join a requirements amendment: a draft Intent introduced after
 * Flow approval can only be approved through one. Cancelled Intents cannot be replaced.
 */
export function amendmentDraft(records: WorkRecord[], flow: WorkFlow) {
  const all = recordsOf(records, "intent").filter((intent) => intent.flowId === flow.id);
  const intents = all.filter((intent) => intent.state !== "cancelled");
  const flowRevision = recordOf(records, "flow-revision", flow.currentRevisionId);
  const flowChanged = !!flow.approvedRevisionId && !!flowRevision && flowRevision.id !== flow.approvedRevisionId;
  const replacements: AmendmentManifest["replacements"] = [];
  if (flowChanged && flowRevision) replacements.push({targetType:"flow",targetId:flow.id,revisionId:flowRevision.id,contentDigest:flowRevision.contentDigest});
  for (const intent of intents) {
    const revision = recordOf(records, "intent-revision", intent.currentRevisionId);
    if (revision && revision.id !== intent.approvedRevisionId) replacements.push({targetType:"intent",targetId:intent.id,revisionId:revision.id,contentDigest:revision.contentDigest});
  }
  const affected = replacements.filter((replacement) => replacement.targetType === "intent").map((replacement) => replacement.targetId);
  const targetRevision = flowChanged ? flowRevision : recordOf(records,"flow-revision",flow.approvedRevisionId);
  const complete = replacements.length > 0 && !!targetRevision &&
    intents.filter((intent) => intent.required && affected.includes(intent.id)).every((intent) => targetRevision.requiredIntentIds.includes(intent.id)) &&
    (!flowChanged || intents.every((intent) => affected.includes(intent.id))) &&
    affected.every((id) => recordOf(records,"intent-revision",intents.find((intent) => intent.id === id)?.currentRevisionId)?.flowRevisionId === targetRevision.id);
  const expectedVersions = Object.fromEntries([flow,...all.filter((intent) => affected.includes(intent.id))].map((record) => [record.id,record.version]));
  return { all, intents, replacements, affected, complete, expectedVersions };
}
