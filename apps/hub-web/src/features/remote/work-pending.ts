import type { Control } from "../../api/remote";
import type { NativeWorkHint } from "../../api/client";
import { isObject } from "../managed-work/validation";

export type NativeSubmission = { scope: string; operationId: string; path: string; body: Control["MessageSubmit"]; hint: NativeWorkHint; phase: "sending" | "unknown" };
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join() === expected;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
/** Closed persisted envelope. Authentication stays in HttpOnly cookies, never this record. */
export function validNativeSubmission(v: unknown, scope: string, path: string): v is NativeSubmission {
  if (!isObject(v) || !keys(v,"body,hint,operationId,path,phase,scope") || v.scope !== scope || v.path !== path || !id(v.operationId) || !["sending","unknown"].includes(String(v.phase))) return false;
  if (!isObject(v.hint) || !keys(v.hint,"attemptId,attemptVersion") || !(typeof v.hint.attemptId === "string" && /^[\x20-\x7e]{1,200}$/.test(v.hint.attemptId)) || !version(v.hint.attemptVersion)) return false;
  const b = v.body;
  if (!isObject(b) || !keys(b,"association,busyPolicy,controller,expectedConfigVersion,expectedSessionVersion,interpretation,text") || !version(b.expectedSessionVersion) || !version(b.expectedConfigVersion) || typeof b.text !== "string" || !b.text.trim() || b.text.length > 32768 || b.interpretation !== "literal-message" || !["reject","enqueue"].includes(String(b.busyPolicy))) return false;
  return isObject(b.controller) && keys(b.controller,"controllerLeaseId,expectedControllerVersion") && id(b.controller.controllerLeaseId) && version(b.controller.expectedControllerVersion) && isObject(b.association) && keys(b.association,"mode,profileConsentVersion") && b.association.mode === "ad-hoc" && version(b.association.profileConsentVersion);
}
