import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createAutomaticEvidenceRecall } from "./automatic";
import type { PublicEvidenceSearchResult } from "./projection";
import { OpenAiCodexProvider } from "../harness/provider/openai-codex/openai-codex-provider";
import type { NormalizedEvent, NormalizedRequest, ProviderPort } from "../harness/provider/types";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const config = { schemaVersion: 1, enabled: true, automatic: true };
const item = { sourceId: "s", sourcePath: "notes/a.md", versionHash: hash("v"), chunkId: "c", contentHash: hash("old"),
  locator: { kind: "file" as const, startByte: 0, endByte: 3, startLine: 1, endLine: 1 }, text: "old",
  role: null, timestamp: null, trustedAsPolicy: false as const, redaction: "not-needed" as const, score: 1 };
const result: PublicEvidenceSearchResult = { schemaVersion: 1, code: "ok", coverage: "full", generation: "g", items: [item], diagnostics: [] };
const request: NormalizedRequest = { providerId: "openai-codex", modelId: "gpt-5.4", systemInstruction: "policy",
  messages: [{ role: "user", content: "latest task" }], budget: { maxOutputTokens: 100, runReservation: 100 },
  stream: true, requestId: "r", parentRunId: "p" };
const textStream = readFileSync(join(import.meta.dir, "../harness/provider/openai/fixtures/text-stream.SYNTHETIC.sse"), "utf8");

test("a transport-level retry inside one provider call never searches again and never re-injects recall", async () => {
  let searches = 0;
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "latest task", reserveBytes: 2000,
    search: async (_q, handoff) => { searches++; handoff(result); } })!;
  const bodies: string[] = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? new Response(null, { status: 401 }) : new Response(textStream);
  }) as typeof globalThis.fetch;
  let grants = 0;
  const provider = new OpenAiCodexProvider({ fetch, authorize: async () => ({ access: `access-${++grants}`, accountId: "account-fixture" }) });
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(request, { attemptId: "a", prepareSerializedRequest: prepare })) events.push(event);
  expect(grants).toBe(2);
  expect(bodies).toHaveLength(2);
  expect(searches).toBe(1);
  expect(bodies[0]).toContain("historical-evidence");
  expect(bodies[1]).not.toContain("historical-evidence");
  expect(events.at(-1)?.kind).toBe("model_end");
});

test("an adapter that ignores prepareSerializedRequest never triggers retrieval", async () => {
  let searches = 0;
  const prepare = createAutomaticEvidenceRecall({ projectRoot: ".", config, query: "latest task", reserveBytes: 2000,
    search: async (_q, handoff) => { searches++; handoff(result); } })!;
  const unsupported = { async *stream(_request: NormalizedRequest, _opts: unknown) { /* no events */ } } as unknown as ProviderPort;
  for await (const event of unsupported.stream(request, { attemptId: "a", prepareSerializedRequest: prepare })) void event;
  expect(searches).toBe(0);
});

test("only the OpenAI Responses adapter consumes the serialized-request hooks", () => {
  const root = join(import.meta.dir, "../harness/provider");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") &&
        /prepareSerializedRequest|onSerializedRequest/.test(readFileSync(path, "utf8"))) found.push(relative(root, path));
    }
  };
  walk(root);
  // Adding an adapter here means exact visibility, delivery validation and the T14 docs must be extended first.
  expect(found.sort()).toEqual(["openai/openai-provider.ts", "types.ts"]);
});
