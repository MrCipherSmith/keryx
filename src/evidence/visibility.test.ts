import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bindVisibleSource } from "../harness/provider/visible-context";
import { serializeOpenAiRequest, OpenAiProvider } from "../harness/provider/openai/openai-provider";
import { OpenAiCodexProvider } from "../harness/provider/openai-codex/openai-codex-provider";
import { filterVisibleEvidence, verifyVisibleRepack } from "./visibility";
import type { NormalizedMessage, NormalizedRequest } from "../harness/provider/types";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const text = "évidence\nexact bytes";
const item = { sourceId: "source", versionHash: hash("version"), contentHash: hash(text), text,
  locator: { kind: "file" as const, startByte: 0, endByte: Buffer.byteLength(text), startLine: 1, endLine: 2 } };
function fixture() {
  const message: NormalizedMessage = { role: "user", content: `prefix:${text}:suffix` };
  bindVisibleSource(message, { ...item, coverage: "exact", startByte: 7, endByte: 7 + Buffer.byteLength(text) });
  const request: NormalizedRequest = { providerId: "openai", modelId: "fixture", messages: [message], systemInstruction: "policy",
    budget: { maxOutputTokens: 100, runReservation: 100 }, stream: true, requestId: "r", parentRunId: "p" };
  return { message, request };
}
test("actual body is hashed; unicode spans are attributed; metadata never sent", async () => {
  const { request } = fixture();
  const { body, projection } = serializeOpenAiRequest(request);
  expect(projection!.requestHash).toBe(hash(body));
  expect(projection!.spans).toHaveLength(1);
  expect(body).not.toContain("versionHash");
  expect(filterVisibleEvidence([item], projection, hash(body)).items).toEqual([]);
  expect(filterVisibleEvidence([item], projection, "0".repeat(64)).items).toEqual([item]);
  expect(serializeOpenAiRequest({ ...request, systemInstruction: "changed" }).projection!.requestHash).not.toBe(projection!.requestHash);
  let sent = "", projected = "";
  const provider = new OpenAiProvider({ grant: { network: true, apiKey: "synthetic" }, fetch: (async (_url, init) => {
    sent = String(init?.body); return new Response("", { status: 500 });
  }) as typeof fetch });
  for await (const event of provider.stream(request, { attemptId: "a", onSerializedRequest: p => { projected = p.requestHash; } })) void event;
  expect(sent).toBe(body); expect(projected).toBe(hash(sent));
  expect(serializeOpenAiRequest(request, "openai", false)).toEqual({ body, projection: undefined });
});
test("compaction, cloning, redaction and version changes never suppress", () => {
  const { request, message } = fixture();
  const original = serializeOpenAiRequest(request).projection!;
  expect(filterVisibleEvidence([{ ...item, versionHash: hash("rewrite") }], original, original.requestHash).items).toHaveLength(1);
  expect(filterVisibleEvidence([{ ...item, text: "different" }], original, original.requestHash).items).toHaveLength(1);
  expect(filterVisibleEvidence([item], JSON.parse(JSON.stringify(original)), original.requestHash).items).toHaveLength(1);
  for (const messages of [[], [{ ...message }], [{ role: "user" as const, content: "summary" }]])
    expect(serializeOpenAiRequest({ ...request, messages }).projection!.spans).toEqual([]);
  message.content = "redacted";
  expect(serializeOpenAiRequest(request).projection!.spans.every(s => s.coverage !== "exact")).toBe(true);
});
test("partial, summary, unknown and unsupported retain candidates", () => {
  for (const coverage of ["partial", "summary", "unknown"] as const) {
    const { request, message } = fixture();
    bindVisibleSource(message, { ...item, coverage, startByte: 7, endByte: 7 + Buffer.byteLength(text) });
    const { projection } = serializeOpenAiRequest(request, "openai-codex");
    expect(projection!.providerAdapter).toBe("openai-codex-responses-v1");
    expect(filterVisibleEvidence([item], projection, projection!.requestHash).items).toEqual([item]);
  }
  expect(filterVisibleEvidence([item], undefined, "unknown").items).toEqual([item]);
});
test("one repack restores evicted spans, without searching again", async () => {
  const { request } = fixture(), base = serializeOpenAiRequest(request).projection!;
  const empty = serializeOpenAiRequest({ ...request, messages: [] }).projection!;
  let calls = 0;
  const result = await verifyVisibleRepack([item], base, async items => {
    calls++; expect(items).toHaveLength(calls === 1 ? 0 : 1); return empty;
  });
  expect(calls).toBe(2); expect(result.items).toEqual([item]);
});

test("issued projection is deeply immutable; toJSON cannot spoof authoritative spans", () => {
  const { request } = fixture(), projection = serializeOpenAiRequest(request).projection!;
  expect(Object.isFrozen(projection)).toBe(true);
  expect(Object.isFrozen(projection.spans)).toBe(true);
  expect(Object.isFrozen(projection.spans[0]!.locator)).toBe(true);
  expect(Reflect.set(projection, "toJSON", () => ({}))).toBe(false);
  expect(Reflect.set(projection, "spans", [])).toBe(false);
  expect(Reflect.set(projection.spans[0]!, "sourceId", "forged")).toBe(false);
  expect(Reflect.set(projection.spans[0]!.locator, "startByte", 100)).toBe(false);
  expect(filterVisibleEvidence([{ ...item, sourceId: "forged" }], projection, projection.requestHash).items).toHaveLength(1);
});
test("second-assembly instability discards packed bodies and returns baseline bytes", async () => {
  const a = fixture(), b = fixture();
  bindVisibleSource(b.message, { ...item, sourceId: "other", coverage: "exact", startByte: 7, endByte: 7 + Buffer.byteLength(text) });
  const other = { ...item, sourceId: "other" };
  const baseline = serializeOpenAiRequest({ ...a.request, messages: [a.message, b.message] });
  let calls = 0;
  const result = await verifyVisibleRepack([item, other], baseline.projection!, async items => {
    calls++;
    expect(items).toHaveLength(calls === 1 ? 0 : 1);
    return serializeOpenAiRequest({ ...a.request, messages: calls === 1 ? [b.message] : [] }).projection!;
  });
  expect(calls).toBe(2);
  expect(result.items).toEqual([]);
  expect(result.diagnostics).toEqual(["visibility-unstable"]);
  expect(result.request.body).toBe(baseline.body);
});
test("tool outputs attributed, opaque replay and call arguments never confer coverage", () => {
  const { request } = fixture();
  const tool: NormalizedMessage = { role: "tool", toolCallId: "c", content: text };
  bindVisibleSource(tool, { ...item, coverage: "exact", startByte: 0, endByte: Buffer.byteLength(text) });
  const assistant: NormalizedMessage = { role: "assistant", content: "", toolCalls: [{ id: "c", name: "tool", arguments: text }] };
  const withTool = serializeOpenAiRequest({ ...request, messages: [assistant, tool] }).projection!;
  expect(withTool.spans).toHaveLength(1);
  expect(() => bindVisibleSource(assistant, { ...item, text: "", contentHash: hash(""), coverage: "exact", startByte: 0, endByte: 1 })).toThrow();
  expect(serializeOpenAiRequest({ ...request, messages: [assistant] }).projection!.spans).toEqual([]);
});


test("Codex transport projects exact bytes through auth retry and disabled mode", async () => {
  const { request } = fixture();
  const sent: string[] = [], projected: string[] = [];
  const provider = new OpenAiCodexProvider({
    authorize: async () => ({ access: "synthetic", accountId: "fixture" }),
    fetch: (async (_url, init) => {
      sent.push(String(init?.body));
      return new Response("", { status: sent.length === 1 ? 401 : 500 });
    }) as typeof fetch,
  });
  for await (const e of provider.stream(request, { attemptId: "c", onSerializedRequest: p => {
    expect(p.providerAdapter).toBe("openai-codex-responses-v1");
    projected.push(p.requestHash);
  } })) void e;
  expect(sent).toHaveLength(2);
  expect(projected).toEqual(sent.map(hash));
  for await (const e of provider.stream(request, { attemptId: "off" })) void e;
  expect(sent).toHaveLength(3);
  const pinned = `{"model":"fixture","instructions":"policy","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"prefix:évidence\\nexact bytes:suffix"}]}],"stream":true,"store":false,"tool_choice":"auto","parallel_tool_calls":true,"tools":[]}`;
  expect(sent).toEqual([pinned, pinned, pinned]);
  const native = pinned.replace(',"store":false,"tool_choice":"auto","parallel_tool_calls":true,"tools":[]', ',"max_output_tokens":100');
  expect(serializeOpenAiRequest(request, "openai", false)).toEqual({ body: native, projection: undefined });
});
