// Flow 387 review r1 F-001: the ACP host persists after every turn WITHOUT an archive of
// its own, which makes `persistHistory` write the context as the archive. It now keeps the
// unpruned messages per history array, so the archive is never derived from a context that
// something shortened. This host does not opt into pruning (no `pruneArchive`).

import { expect, test } from "bun:test";
import path from "node:path";
import type { NormalizedEvent, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { loadArchive, loadContext } from "../session";
import { ACP_PROTOCOL_VERSION } from "./protocol";
import { harness } from "./server-harness.test-helpers";

const description: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "acp-archive-test" },
};

const provider: ProviderPort = {
  describe: () => description,
  stream: (_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> =>
    (async function* (): AsyncGenerator<NormalizedEvent> {
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "answer" } as NormalizedEvent;
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
    })(),
};

test("ACP host: archive.jsonl keeps every message of every turn alongside the context", async () => {
  const h = harness({ providerId: "test", modelId: "test-model", provider });
  try {
    const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    await h.waitFor((f) => f.id === initId);
    const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const reply = await h.waitFor((f) => f.id === newId);
    const sessionId = String(reply.result?.["sessionId"]);

    for (const text of ["first question", "second question"]) {
      const id = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      await h.waitFor((f) => f.id === id);
    }

    const dataDir = path.join(h.projectDir, "data");
    const archive = loadArchive(h.projectDir, sessionId, dataDir).map((m) => m.content);
    const context = loadContext(h.projectDir, sessionId, dataDir);
    expect(archive.some((c) => c.includes("first question"))).toBe(true);
    expect(archive.some((c) => c.includes("second question"))).toBe(true);
    expect(archive.length).toBeGreaterThanOrEqual(context.length);
  } finally {
    await h.end();
  }
});
