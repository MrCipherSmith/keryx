// Flow 387 review r1 F-001 / r2 F-021, F-022: the ACP host persists after every turn WITHOUT
// pruning, but the provider-overflow recovery in `runAgentTurn` still shortens `history` in
// place on every host. The host therefore keeps the originals itself (`AcpSessionState.archive`)
// and must (a) not lose the turn that triggered a compaction and (b) seed that archive from the
// stored archive, not from the (possibly compacted) context, on `session/load`.

import { expect, test } from "bun:test";
import path from "node:path";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { createSession, loadArchive, loadContext, persistHistory } from "../session";
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

/** Answers `answer-<n>`; the call numbers in `overflowOn` are rejected as a context overflow. */
function scriptedProvider(overflowOn: readonly number[]): ProviderPort {
  let calls = 0;
  return {
    describe: () => description,
    stream: (_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        calls += 1;
        if (overflowOn.includes(calls)) {
          yield {
            sequence: 0,
            attemptId: opts.attemptId,
            kind: "provider_error",
            error: { kind: "context_overflow", retryable: false, message: "prompt too long" },
          } as NormalizedEvent;
          return;
        }
        yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: `answer-${calls}` } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })(),
  };
}

type Harness = ReturnType<typeof harness>;

async function startSession(h: Harness): Promise<string> {
  const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
  await h.waitFor((f) => f.id === initId);
  const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
  const reply = await h.waitFor((f) => f.id === newId);
  return String(reply.result?.["sessionId"]);
}

async function prompt(h: Harness, sessionId: string, text: string): Promise<void> {
  const id = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  await h.waitFor((f) => f.id === id);
}

test("ACP host: the archive keeps the turn that triggered an overflow compaction", async () => {
  // Call 5 is q5's first request: rejected, the context is compacted in place, then retried (call 6).
  const h = harness({ providerId: "test", modelId: "test-model", provider: scriptedProvider([5]) });
  try {
    const sessionId = await startSession(h);
    const questions = ["q1", "q2", "q3", "q4", "q5-triggers-overflow"];
    for (const text of questions) {
      await prompt(h, sessionId, text);
    }

    const dataDir = path.join(h.projectDir, "data");
    const archive = loadArchive(h.projectDir, sessionId, dataDir);
    const context = loadContext(h.projectDir, sessionId, dataDir);
    const archiveText = archive.map((m) => m.content);

    // The compaction really happened: the context no longer holds the first question verbatim
    // (a summary may quote it, so compare whole messages).
    expect(context.some((m) => m.content === "q1")).toBe(false);
    // The archive holds every user message, including the one that triggered it, and its answer.
    for (const question of questions) {
      expect(archiveText.filter((c) => c === question)).toHaveLength(1);
    }
    expect(archiveText).toContain("answer-6");
    // The originals are the archive: it is strictly longer than the compacted context.
    expect(archive.length).toBeGreaterThan(context.length);
    // Nothing is duplicated by the cursor re-pointing.
    expect(archiveText.filter((c) => c === "answer-1")).toHaveLength(1);
  } finally {
    await h.end();
  }
});

test("ACP host: archive.jsonl keeps every turn when nothing shrinks", async () => {
  const h = harness({ providerId: "test", modelId: "test-model", provider: scriptedProvider([]) });
  try {
    const sessionId = await startSession(h);
    await prompt(h, sessionId, "first question");
    await prompt(h, sessionId, "second question");

    const dataDir = path.join(h.projectDir, "data");
    const archive = loadArchive(h.projectDir, sessionId, dataDir).map((m) => m.content);
    expect(archive.filter((c) => c === "first question")).toHaveLength(1);
    expect(archive.filter((c) => c === "second question")).toHaveLength(1);
    expect(archive).toEqual(["first question", "answer-1", "second question", "answer-2"]);
  } finally {
    await h.end();
  }
});

test("ACP session/load: the next prompt does not rewrite the archive from the compacted context", async () => {
  const h = harness({ providerId: "test", modelId: "test-model", provider: scriptedProvider([]) });
  try {
    const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    await h.waitFor((f) => f.id === initId);

    // A session a shell left behind: the context was compacted, the archive holds the originals.
    const dataDir = path.join(h.projectDir, "data");
    const handle = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir });
    const questionTwo: NormalizedMessage = { role: "user", content: "old question two" };
    const answerTwo: NormalizedMessage = { role: "assistant", content: "old answer two" };
    const originals: NormalizedMessage[] = [
      { role: "user", content: "old question one" },
      { role: "assistant", content: "old answer one" },
      questionTwo,
      answerTwo,
    ];
    const compacted: NormalizedMessage[] = [
      { role: "user", content: "[Compacted summary of earlier turns]" },
      questionTwo,
      answerTwo,
    ];
    persistHistory(handle, compacted, { provider: "test", model: "test-model", archive: originals });
    const sessionId = handle.summary.id;

    const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
    const loaded = await h.waitFor((f) => f.id === loadId);
    expect(loaded.error).toBeUndefined();
    await prompt(h, sessionId, "new question");

    const archive = loadArchive(h.projectDir, sessionId, dataDir).map((m) => m.content);
    expect(archive).toEqual([
      "old question one",
      "old answer one",
      "old question two",
      "old answer two",
      "new question",
      "answer-1",
    ]);
    expect(archive).not.toContain("[Compacted summary of earlier turns]");
  } finally {
    await h.end();
  }
});
