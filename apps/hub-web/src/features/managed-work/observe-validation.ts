import { isObject } from "./validation";
import type { WorkCommand } from "./types";

export function isObserveCommand(value: unknown): value is WorkCommand {
  return isObject(value) && Object.keys(value).sort().join() === "command,expectedVersions,operationId,payload" &&
    value.command === "subject.observe" && typeof value.operationId === "string" && /^[\x20-\x7e]{1,200}$/.test(value.operationId) &&
    isObject(value.payload) && typeof value.payload.subjectId === "string" && /^[\x20-\x7e]{1,200}$/.test(value.payload.subjectId) &&
    typeof value.payload.subjectDigest === "string" && /^[a-f0-9]{64}$/.test(value.payload.subjectDigest) && Object.keys(value.payload).length === 2 &&
    isObject(value.expectedVersions) && Object.keys(value.expectedVersions).length > 0 && Object.keys(value.expectedVersions).length <= 200 &&
    Object.values(value.expectedVersions).every((v) => Number.isSafeInteger(v) && Number(v) >= 1);
}
