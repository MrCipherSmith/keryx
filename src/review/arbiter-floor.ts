// The floor: what the review arbiter is never asked and never answers.
//
// A question or a tool call of one of these classes goes the way it went before the arbiter existed: to the
// operator, or, in an autonomous run, to a refusal. The classes mirror review-auto's own floor
// (`reviewAutoGrants`): destructive, credential, publish and hook-tightened calls, a call after untrusted content,
// and an irreversible decision. Nothing the arbiter's model says can lower this floor, because the check runs
// before the model is reached and does not read the model's answer.

import type { ApprovalMeta } from "../commands/agent";
import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import { reviewAutoMayAnswer } from "./review-system";

export const FLOOR_CLASSES = [
  "irreversible",
  "action",
  "untrusted-content",
  "operator-denial",
  "destructive",
  "credentials",
  "publish",
  "hook-ask",
  "always-ask",
  "untrusted-origin",
] as const;
export type FloorClass = (typeof FLOOR_CLASSES)[number];

/** The floor class of an `ask_user` question, or `undefined` when the arbiter may be asked. */
export function askFloor(request: AskUserRequest): FloorClass | undefined {
  if (request.irreversible === true) return "irreversible";
  if (typeof request.action === "string" && request.action.trim().length > 0) return "action";
  if (request.untrustedContent === true) return "untrusted-content";
  if (!reviewAutoMayAnswer(request)) return "operator-denial";
  return undefined;
}

/** The floor class of a tool-approval call, or `undefined`. The arbiter never answers an approval; this names why the floor holds. */
export function approvalFloor(meta: ApprovalMeta | undefined): FloorClass | undefined {
  if (meta === undefined) return "always-ask";
  if (meta.destructive) return "destructive";
  if (meta.credentials === true) return "credentials";
  if (meta.publishLease === true) return "publish";
  if (meta.hookAsk === true) return "hook-ask";
  if (meta.alwaysAsk === true) return "always-ask";
  if (meta.untrustedOrigin === true) return "untrusted-origin";
  return undefined;
}
