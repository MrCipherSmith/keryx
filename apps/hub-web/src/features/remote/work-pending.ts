import type { Control } from "../../api/remote";
import type { NativeWorkHint } from "../../api/client";
import { isObject } from "../managed-work/validation";

export type ChatSubmission = { scope: string; operationId: string; path: string; body: Control["MessageSubmit"]; phase: "sending" | "unknown" };
export type NativeSubmission = ChatSubmission & { hint: NativeWorkHint };
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join() === expected;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
function validEnvelope(v: Record<string, unknown>, scope: string, path: string) {
  return v.scope === scope && v.path === path && id(v.operationId) &&
    (v.phase === "sending" || v.phase === "unknown");
}
function validBody(b: unknown): b is Control["MessageSubmit"] {
  if (!isObject(b) || !keys(b,"association,busyPolicy,controller,expectedConfigVersion,expectedSessionVersion,interpretation,text") ||
      !version(b.expectedSessionVersion) || !version(b.expectedConfigVersion) || typeof b.text !== "string" ||
      !b.text.trim() || b.text.length > 32768 || b.interpretation !== "literal-message" ||
      (b.busyPolicy !== "reject" && b.busyPolicy !== "enqueue")) return false;
  if (!isObject(b.controller) || !keys(b.controller,"controllerLeaseId,expectedControllerVersion") ||
      !id(b.controller.controllerLeaseId) || !version(b.controller.expectedControllerVersion) ||
      !isObject(b.association)) return false;
  const a = b.association;
  return a.mode === "ad-hoc" ? keys(a,"mode,profileConsentVersion") && version(a.profileConsentVersion)
    : a.mode === "flow" && keys(a,"criteriaDigest,expectedFlowVersion,flowId,mode,specDigest") &&
      id(a.flowId) && version(a.expectedFlowVersion) &&
      typeof a.specDigest === "string" && /^[a-f0-9]{64}$/i.test(a.specDigest) &&
      typeof a.criteriaDigest === "string" && /^[a-f0-9]{64}$/i.test(a.criteriaDigest);
}
/** Closed persisted envelopes: only the request sent to Hub, never browser credentials. */
export function validChatSubmission(v: unknown, scope: string, path: string): v is ChatSubmission {
  return isObject(v) && keys(v,"body,operationId,path,phase,scope") &&
    validEnvelope(v, scope, path) && validBody(v.body);
}
export function validNativeSubmission(v: unknown, scope: string, path: string): v is NativeSubmission {
  return isObject(v) && keys(v,"body,hint,operationId,path,phase,scope") &&
    validEnvelope(v, scope, path) && validBody(v.body) && v.body.association.mode === "ad-hoc" &&
    isObject(v.hint) && keys(v.hint,"attemptId,attemptVersion") &&
    typeof v.hint.attemptId === "string" && /^[\x20-\x7e]{1,200}$/.test(v.hint.attemptId) && version(v.hint.attemptVersion);
}
