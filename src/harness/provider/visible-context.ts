import { createHash } from "node:crypto";
import type { NormalizedMessage } from "./types";

export type VisibleLocator = { kind: "file"; startByte: number; endByte: number; startLine: number; endLine: number } |
  { kind: "archive"; startByte: number; endByte: number; recordId: string };
export interface VisibleSpan {
  sourceId: string; versionHash: string; contentHash: string; locator: VisibleLocator;
  coverage: "exact" | "partial" | "summary" | "unknown";
}
export interface VisibleProjection {
  schemaVersion: 1; requestHash: string; providerAdapter: string; spans: VisibleSpan[];
}
interface Binding extends VisibleSpan { text: string; startByte: number; endByte: number; snapshot: string }
const bindings = new WeakMap<object, Binding[]>();
const emitted = new WeakMap<object, { message: NormalizedMessage; text: string }>();
const sealed = new WeakMap<VisibleProjection, string>(); // exact ephemeral transport body
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** Trusted owner handoff only. This metadata is never serialized or persisted.
 * A copied/truncated message deliberately loses attribution. Rebinding replaces it.
 */
export function bindVisibleSource(message: NormalizedMessage, input: VisibleSpan & {
  text: string; startByte: number; endByte: number;
}): void {
  const bytes = Buffer.from(message.content), span = bytes.subarray(input.startByte, input.endByte);
  if (!input.sourceId || !/^[a-f0-9]{64}$/.test(input.versionHash) ||
      !Number.isSafeInteger(input.startByte) || !Number.isSafeInteger(input.endByte) ||
      input.startByte < 0 || input.endByte <= input.startByte || input.endByte > bytes.length ||
      !span.equals(Buffer.from(input.text)) || digest(input.text) !== input.contentHash)
    throw new Error("invalid visible source binding");
  bindings.set(message, [{ ...input, locator: { ...input.locator }, snapshot: message.content }]);
}

/** Called only for actual content fields, never tool arguments or opaque reasoning. */
export function attributeSerializedContent(item: object, message: NormalizedMessage): void {
  emitted.set(item, { message, text: message.content });
}

/** Hash the exact body used by fetch, with transport credentials excluded. */
export function projectResponsesBody(body: string, input: readonly object[], adapter: string): VisibleProjection {
  const wire = JSON.parse(body) as { input: Record<string, unknown>[] };
  const spans: VisibleSpan[] = [];
  input.forEach((item, index) => {
    const origin = emitted.get(item), field = wire.input[index];
    if (!origin || !field) return;
    const content = field.content as { text?: unknown }[] | undefined;
    const text = field.type === "function_call_output" ? field.output : content?.[0]?.text;
    if (text !== origin.text) return;
    for (const binding of bindings.get(origin.message) ?? []) {
      if (spans.length >= 10000) break;
      const { sourceId, versionHash, contentHash, locator, coverage } = binding;
      const exact = binding.snapshot === text && Buffer.from(text as string)
        .subarray(binding.startByte, binding.endByte).equals(Buffer.from(binding.text));
      spans.push({ sourceId, versionHash, contentHash, locator: { ...locator }, coverage: exact ? coverage : "unknown" });
    }
  });
  const projection: VisibleProjection = { schemaVersion: 1, requestHash: digest(body), providerAdapter: adapter, spans };
  // Deep freeze before exposure; serialization hooks are never authority.
  for (const span of spans) { Object.freeze(span.locator); Object.freeze(span); }
  Object.freeze(spans);
  Object.freeze(projection);
  sealed.set(projection, body);
  return projection;
}
export function isVerifiedVisibleProjection(projection: VisibleProjection, requestHash: string): boolean {
  return projection.requestHash === requestHash && sealed.has(projection);
}
/** Same-process transport handoff. Never log or persist the body. */
export function verifiedVisibleRequest(projection: VisibleProjection): { body: string; projection: VisibleProjection } {
  const body = sealed.get(projection);
  if (body === undefined) throw new Error("unverified visible request");
  return { body, projection };
}
