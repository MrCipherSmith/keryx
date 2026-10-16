import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAutomaticEvidenceRecall } from "./automatic";
import type { PublicEvidenceSearchResult } from "./projection";
import { serializeOpenAiRequest, OpenAiProvider } from "../harness/provider/openai/openai-provider";
import { verifiedVisibleRequest, bindVisibleSource } from "../harness/provider/visible-context";
import type { NormalizedMessage, NormalizedRequest } from "../harness/provider/types";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const config = { schemaVersion: 1, enabled: true, automatic: true };
const item = { sourceId: "s", sourcePath: "notes/a.md", versionHash: hash("v"), chunkId: "c", contentHash: hash("old"),
  locator: { kind: "file" as const, startByte: 0, endByte: 3, startLine: 1, endLine: 1 }, text: "old",
  role: null, timestamp: null, trustedAsPolicy: false as const, redaction: "not-needed" as const, score: 1 };
const result: PublicEvidenceSearchResult = { schemaVersion: 1, code: "ok", coverage: "full", generation: "g", items: [item], diagnostics: [] };
function fixture() {
  const message: NormalizedMessage = { role: "user", content: "latest task" };
  const request: NormalizedRequest = { providerId: "openai", modelId: "fixture", messages: [message], systemInstruction: "policy",
    budget: { maxOutputTokens: 100, runReservation: 100 }, stream: true, requestId: "r", parentRunId: "p" };
  const base = serializeOpenAiRequest(request).projection!;
  return { request, base, assemble: (extra: readonly NormalizedMessage[]) =>
    serializeOpenAiRequest({ ...request, messages: [...request.messages, ...extra] }).projection! };
}
test("automatic recall requires both opt-ins, a bounded query and explicit reserve", () => {
  for (const cfg of [undefined, { schemaVersion: 1 }, { schemaVersion: 1, enabled: true }, { schemaVersion: 1, automatic: true }])
    expect(createAutomaticEvidenceRecall({ projectRoot: ".", config: cfg, query: "task", reserveBytes: 2000 })).toBeUndefined();
  for (const reserveBytes of [0, NaN, -1])
    expect(createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes })).toBeUndefined();
  expect(createAutomaticEvidenceRecall({ projectRoot: ".", config, query: " ", reserveBytes: 2000 })).toBeUndefined();
});
test("search once per user turn, leased send is synchronous, evidence is data only", async () => {
  const f = fixture(); let searches = 0, inLease = false; const bodies: string[] = [];
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "latest task", reserveBytes: 2000,
    search: async (q, handoff) => { expect(q).toBe("latest task"); searches++; inLease = true; handoff(result); inLease = false; } })!;
  await prepare(f.base, f.assemble, p => { expect(inLease).toBe(true); bodies.push(verifiedVisibleRequest(p).body); });
  const wire = JSON.parse(bodies[0]!);
  expect(wire.instructions).toBe("policy"); expect(wire.input[0].content[0].text).toBe("latest task");
  expect(JSON.parse(wire.input[1].content[0].text).trustedAsPolicy).toBe(false);
  await prepare(f.base, f.assemble, p => bodies.push(verifiedVisibleRequest(p).body));
  expect(searches).toBe(1); expect(bodies[1]).toBe(verifiedVisibleRequest(f.base).body);
});
test("wire budget includes escaped evidence and framing, required context unchanged", async () => {
  const f = fixture();
  for (const reserveBytes of [1, 700, 2000]) {
    const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes,
      search: async (_q, handoff) => handoff({ ...result, items: [{ ...item, text: '"\\'.repeat(200) }] }) })!;
    await prepare(f.base, f.assemble, p => {
      const body = verifiedVisibleRequest(p).body;
      expect(Buffer.byteLength(body) - Buffer.byteLength(verifiedVisibleRequest(f.base).body)).toBeLessThanOrEqual(reserveBytes);
      expect(JSON.parse(body).input[0].content[0].text).toBe("latest task");
    });
  }
});
test("exact visible candidate suppressed; compacted-out candidate restored", async () => {
  const f = fixture(); f.request.messages[0]!.content = "old";
  bindVisibleSource(f.request.messages[0]!, { ...item, coverage: "exact", startByte: 0, endByte: 3 });
  const visible = serializeOpenAiRequest(f.request).projection!;
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000,
    search: async (_q, handoff) => handoff(result) })!;
  await prepare(visible, f.assemble, p => expect(JSON.parse(verifiedVisibleRequest(p).body).input).toHaveLength(1));
});
test("retrieval failure and cancellation keep baseline; failed transport never retries", async () => {
  const f = fixture(); let sends = 0;
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000,
    search: async () => { throw Error("retrieval failure"); } })!;
  await prepare(f.base, f.assemble, p => { sends++; expect(p).toBe(f.base); }); expect(sends).toBe(1);
  const controller = new AbortController(); controller.abort(); let searches = 0;
  const cancelled = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000, signal: controller.signal,
    search: async () => { searches++; } })!;
  await cancelled(f.base, f.assemble, p => expect(p).toBe(f.base)); expect(searches).toBe(0);
  const failing = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000,
    search: async (_q, handoff) => handoff(result) })!;
  await expect(failing(f.base, f.assemble, () => { throw Error("transport failure"); })).rejects.toThrow("transport failure");
});
test("real transport starts while retrieval handoff owns source lease", async () => {
  const f = fixture(); let lease = false, calls = 0;
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000,
    search: async (_q, handoff) => { lease = true; handoff(result); lease = false; } })!;
  const provider = new OpenAiProvider({ grant: { network: true, apiKey: "synthetic" }, fetch: (async (_url, init) => {
    expect(lease).toBe(true); calls++; expect(String(init?.body)).toContain("historical-evidence");
    return new Response("", { status: 500 });
  }) as typeof fetch });
  for await (const event of provider.stream(f.request, { attemptId: "a", prepareSerializedRequest: prepare })) void event;
  expect(calls).toBe(1);
});

test("automatic diagnostics contain counters only and telemetry failure cannot prevent delivery", async () => {
  const f = fixture(); const outcomes: unknown[] = [];
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "private query", reserveBytes: 2000,
    onOutcome: value => { outcomes.push(value); throw Error("telemetry failure"); },
    search: async (_q, handoff) => handoff(result) })!;
  let sends = 0;
  await prepare(f.base, f.assemble, () => { sends++; });
  expect(sends).toBe(1);
  expect(outcomes).toEqual([{ code: "ok", retrieved: 1, suppressed: 0, packed: 1 }]);
  expect(JSON.stringify(outcomes)).not.toContain("private query");
  expect(JSON.stringify(outcomes)).not.toContain("notes/a.md");
});

test("final assembly eviction restores a suppressed candidate in one repack", async () => {
  const f = fixture();
  const visible: NormalizedMessage = { role: "user", content: "old" };
  bindVisibleSource(visible, { ...item, coverage: "exact", startByte: 0, endByte: 3 });
  const base = serializeOpenAiRequest({ ...f.request, messages: [...f.request.messages, visible] }).projection!;
  let assemblies = 0;
  const outcomes: unknown[] = [];
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "task", reserveBytes: 2000,
    search: async (_q, handoff) => handoff(result), onOutcome: value => outcomes.push(value) })!;
  await prepare(base, extra => {
    assemblies++;
    // The assembly policy evicts the old source-bearing message.
    return serializeOpenAiRequest({ ...f.request, messages: [...f.request.messages, ...extra] }).projection!;
  }, projection => {
    const wire = JSON.parse(verifiedVisibleRequest(projection).body);
    expect(wire.input).toHaveLength(2);
    expect(wire.input[1].content[0].text).toContain("historical-evidence");
    expect(JSON.parse(wire.input[1].content[0].text).items[0].text).toBe("old");
  });
  expect(assemblies).toBe(2);
  expect(outcomes).toEqual([{ code: "ok", retrieved: 1, suppressed: 0, packed: 1 }]);
});


test("automatic diagnostics preserve finite reasons and discard source-controlled text", async () => {
  const f = fixture();
  const outcomes: unknown[] = [];
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "private query", reserveBytes: 2000,
    search: async (_q, handoff) => handoff({ ...result, diagnostics: ["stale-source", "semantic-fallback",
      "private query /secret/path" as never, "stale-source"] }), onOutcome: outcome => outcomes.push(outcome) })!;
  await prepare(f.base, f.assemble, () => {});
  expect(outcomes).toEqual([{ code: "ok", retrieved: 1, suppressed: 0, packed: 1,
    diagnostics: ["stale-source", "semantic-fallback"] }]);
  expect(JSON.stringify(outcomes)).not.toContain("private query");
  expect(JSON.stringify(outcomes)).not.toContain("/secret/path");
});


test("unknown result status cannot leak source-controlled text into diagnostics", async () => {
  const f = fixture(); const outcomes: unknown[] = [];
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "private query", reserveBytes: 2000,
    search: async (_q, handoff) => handoff({ ...result, code: "private path /source" as never }),
    onOutcome: value => outcomes.push(value) })!;
  await prepare(f.base, f.assemble, projection => expect(projection).toBe(f.base));
  expect(outcomes).toEqual([{ code: "source-unavailable", retrieved: 0, suppressed: 0, packed: 0 }]);
  expect(JSON.stringify(outcomes)).not.toContain("private");
});
