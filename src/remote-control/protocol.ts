import { createHash } from "node:crypto";
import * as validators from "./generated/validators.js";
import type { Control, MachineFrame } from "./generated/types";
export type * from "./generated/types";
export const PROTOCOL_VERSION = 2 as const;
export const MACHINE_SUBPROTOCOL = "keryx.hub.machine.v2";
export const LIMITS = Object.freeze({ frameBytes: 65536, logChunkBytes: 8192, bufferBytes: 262144, taskBytes: 32768, runLogBytes: 10485760, eventPageCount: 500, eventPageBytes: 524288, historyPageCount: 100, pendingCommands: 1000, pendingSessionItems: 100, grantMs: 5000, controllerMs: 60000, heartbeatMs: 20000, heartbeatTimeoutMs: 60000 });
export type ProtocolError = { code: string; message: string };
export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolError };
export type MachineToHubFrame = Extract<MachineFrame, { type: "hello" | "heartbeat" | "inventory" | "command-receipt" | "run-event" | "session-command-receipt" | "session-event" | "capability-page" | "error" }>;
export type HubToMachineFrame = Exclude<MachineFrame, MachineToHubFrame> | Extract<MachineFrame, { type: "error" }>;
export type FrameOf<T extends MachineFrame["type"]> = Extract<MachineFrame, { type: T }>;
const bad = (code: string, message: string): ProtocolResult<never> => ({ ok: false, error: { code, message } });
export function validateControl<K extends keyof Control>(name: K, value: unknown): ProtocolResult<Control[K]> {
  const check = validators[`control_${name}`];
  return check(value) ? { ok: true, value: value as Control[K] } : bad("invalid-frame", `Invalid ${name}`);
}
/** Duplicate-aware JSON decoding; depth is bounded before JSON.parse can allocate nested trees. */
export function parseClosedJson(raw: string, maxBytes: number = LIMITS.frameBytes): ProtocolResult<unknown> {
  if (Buffer.byteLength(raw) > maxBytes) return bad("quota-exceeded", "Encoded JSON exceeds quota");
  let at = 0;
  const whitespace = () => { while (/\s/.test(raw[at] ?? "") && at < raw.length) at++; };
  const string = (): string => {
    const from = at++;
    while (at < raw.length) { const c = raw[at++]!; if (c === "\\") { at++; continue; } if (c === '"') return JSON.parse(raw.slice(from, at)) as string; }
    throw new SyntaxError();
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new SyntaxError(); whitespace();
    const c = raw[at];
    if (c === '"') { string(); return; }
    if (c === "{") {
      at++; whitespace(); const seen = new Set<string>(); if (raw[at] === "}") { at++; return; }
      while (at < raw.length) { whitespace(); if (raw[at] !== '"') throw new SyntaxError(); const key = string(); if (seen.has(key)) throw new SyntaxError(); seen.add(key); whitespace(); if (raw[at++] !== ":") throw new SyntaxError(); value(depth + 1); whitespace(); const end = raw[at++]; if (end === "}") return; if (end !== ",") throw new SyntaxError(); }
      throw new SyntaxError();
    }
    if (c === "[") { at++; whitespace(); if (raw[at] === "]") { at++; return; } while (at < raw.length) { value(depth + 1); whitespace(); const end = raw[at++]; if (end === "]") return; if (end !== ",") throw new SyntaxError(); } throw new SyntaxError(); }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at));
    if (!match) throw new SyntaxError(); at += match[0].length;
  };
  try { value(0); whitespace(); if (at !== raw.length) return bad("invalid-frame", "Invalid JSON"); return { ok: true, value: JSON.parse(raw) as unknown }; }
  catch { return bad("invalid-frame", "Malformed or duplicate-key JSON"); }
}
const incoming = new Set<MachineFrame["type"]>(["hello", "heartbeat", "inventory", "command-receipt", "run-event", "session-command-receipt", "session-event", "capability-page", "error"]);
export function parseMachineFrame(raw: string | Uint8Array, direction: "machine-to-hub" | "hub-to-machine"): ProtocolResult<MachineFrame> {
  if (typeof raw !== "string") return bad("invalid-frame", "Binary frames are unsupported");
  const parsed = parseClosedJson(raw); if (!parsed.ok) return parsed;
  if (typeof parsed.value === "object" && parsed.value !== null && "v" in parsed.value && parsed.value.v !== 2) return bad("unsupported-version", "Unsupported protocol version");
  if (!validators.machineFrame(parsed.value)) return bad("invalid-frame", "Invalid machine frame");
  const frame = parsed.value as MachineFrame;
  if (frame.type !== "error" && incoming.has(frame.type) !== (direction === "machine-to-hub")) return bad("wrong-direction", "Frame direction denied");
  return { ok: true, value: frame };
}
function codePointCompare(a: string, b: string) { const x = Array.from(a, (c) => c.codePointAt(0)!); const y = Array.from(b, (c) => c.codePointAt(0)!); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return x.length - y.length; }
export function canonicalBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalBody);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => codePointCompare(a, b)).map(([key, item]) => [key, canonicalBody(item)]));
  return value;
}
export function canonicalDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonicalBody(value))).digest("hex"); }
export function criteriaDigest(criteria: string[]): string { return createHash("sha256").update(JSON.stringify(criteria)).digest("hex"); }
export function catalogueDigest(entries: Control["CommandCatalogueEntry"][]): string { return canonicalDigest([...entries].sort((a, b) => codePointCompare(a.commandName, b.commandName))); }
export function runCommandDigest(c: FrameOf<"command">["payload"]): string { return createHash("sha256").update(JSON.stringify([2, "run", c.kind, c.commandId, c.hubSequence, c.sessionId, c.runId, c.turnId, c.projectId, c.checkoutId, c.expectedSessionVersion, c.expectedRunVersion, canonicalBody(c.controller), c.expiresAt, c.authorizedBy, canonicalBody(c.body)])).digest("hex"); }
export function sessionCommandDigest(c: FrameOf<"session-command">["payload"]): string { return createHash("sha256").update(JSON.stringify([2, "session", c.kind, c.commandId, c.hubSequence, c.projectId, c.checkoutId, canonicalBody(c.target), c.expiresAt, c.authorizedBy, canonicalBody(c.body)])).digest("hex"); }

/** Compile the deliberately non-executable bounded ArgumentSchema language. */
export function validateArguments(schema: unknown, value: unknown): ProtocolResult<unknown> {
  const admitted = validateControl("ArgumentSchema", schema); if (!admitted.ok) return admitted;
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.taskBytes) return bad("quota-exceeded", "Arguments exceed byte quota");
  function compile(s: Control["ArgumentSchema"], depth: number): ((item: unknown) => boolean) | undefined {
    if (depth > 8) return undefined;
    if (s.type === "object") {
      if (s.required.some((key) => !Object.hasOwn(s.properties, key))) return undefined;
      const checks = new Map<string, (item: unknown) => boolean>();
      for (const [key, child] of Object.entries(s.properties)) { const check = compile(child, depth + 1); if (!check) return undefined; checks.set(key, check); }
      return (item) => !!item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length <= 64 && s.required.every((key) => Object.hasOwn(item, key)) && Object.entries(item).every(([key, child]) => checks.get(key)?.(child) === true);
    }
    if (s.type === "array") { const check = compile(s.items, depth + 1); return check && ((item) => Array.isArray(item) && item.length <= s.maxItems && item.every(check)); }
    if (s.type === "string") return (item) => typeof item === "string" && [...item].length <= s.maxLength && (!s.enum || s.enum.includes(item));
    if (s.type === "number" || s.type === "integer") { if (s.minimum > s.maximum) return undefined; return (item) => typeof item === "number" && Number.isFinite(item) && (s.type !== "integer" || Number.isInteger(item)) && item >= s.minimum && item <= s.maximum; }
    if (s.type === "null") return (item) => item === null;
    return (item) => typeof item === "boolean";
  }
  const check = compile(admitted.value, 0);
  return check?.(value) ? { ok: true, value } : bad("invalid-arguments", "Arguments do not satisfy selected command schema");
}

export type MachineSummary = { machineId: string; version: number; displayName: string; projectIds: string[]; revoked: boolean; createdAt: string; lastSeenAt: string | null; connected: boolean; recoveryRequired: boolean; inventory: FrameOf<"inventory">["payload"] | null };
export type RunRecord = { runId: string; turnId: string; sessionId: string; projectId: string; checkoutId: string; machineId: string; version: number; state: FrameOf<"run-event">["payload"] extends infer Event ? Event extends { kind: "state"; state: infer State } ? State : never : never; lastLocalSeq: number; association: Control["FlowAssociation"]; snapshot: Control["ConfigSnapshot"]; partial: boolean; observedAt?: string; cancelRequested?: boolean; incident?: string; result?: Control["ResultReceipt"]; approvals?: ApprovalProjection[]; reconciliationReceipts?: Control["ReconciliationReceipt"][]; connected: boolean };

export type ApprovalProjection = { approvalId: string; runId: string; sessionId: string; turnId: string; actionFingerprint: string; policyDigest: string; expiresAt: string; summary: string; localRequired: boolean; status: "waiting" | "recorded" | "delivered" | "applied" | "not-applied" | "expired"; decision?: "allow-once" | "deny" };
export type ApprovalAnswerReceipt = { approvalId: string; receiptId: string; status: "recorded"; decision: "allow-once" | "deny" };
