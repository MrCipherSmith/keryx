// ACP takes the same session lease `keryx shell` takes (agent bus D-07), so the
// two surfaces never both rewrite one transcript (perimeter review,
// regression-04 F-001): a session another instance holds is not loaded, a
// lease taken over mid-session stops the persist, and the connection's end
// gives every lease back.

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NormalizedEvent, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { createSession, loadContext, persistHistory } from "../session";
import { openLeasedSession, processInstanceId, sessionLeasePath } from "../session/lease";
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
  descriptor: { providerId: "acp-lease-test" },
};

const provider: ProviderPort = {
  describe: () => description,
  stream: (_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> =>
    (async function* (): AsyncGenerator<NormalizedEvent> {
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "answer" } as NormalizedEvent;
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
    })(),
};

type Harness = ReturnType<typeof harness>;

function dataDirOf(h: Harness): string {
  return path.join(h.projectDir, "data");
}

async function initialize(h: Harness): Promise<void> {
  const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
  await h.waitFor((f) => f.id === initId);
}

/** A session with one stored turn, as a shell would leave it. */
function storedSession(h: Harness): string {
  const handle = createSession({ cwd: h.projectDir, provider: "test", model: "test-model", dataDir: dataDirOf(h) });
  persistHistory(
    handle,
    [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ],
    { provider: "test", model: "test-model" },
  );
  return handle.summary.id;
}

/**
 * Makes `sessionId`'s lease belong to ANOTHER live instance: lease it, then
 * rewrite its owner record as a different instance would (fresh heartbeat,
 * this live pid). Whatever this process held on it reads as lost.
 */
function holdByAnotherInstance(h: Harness, sessionId: string): void {
  const ownerFile = path.join(sessionLeasePath(h.projectDir, sessionId, dataDirOf(h)), "owner.json");
  if (!existsSync(ownerFile)) {
    openLeasedSession({ cwd: h.projectDir, resumeId: sessionId, dataDir: dataDirOf(h) });
  }
  const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
  writeFileSync(
    ownerFile,
    JSON.stringify({ ...owner, token: "another-instance-token", instanceId: "another-instance", heartbeatAt: new Date().toISOString() }),
  );
  // Drop this process's own handle, so only the record on disk decides.
  openLeasedSession({ cwd: h.projectDir, resumeId: sessionId, dataDir: dataDirOf(h) }).lease.checkLost();
}

test("session/load of a session another instance holds is refused, and its transcript is left alone", async () => {
  const h = harness({ provider });
  try {
    await initialize(h);
    const sessionId = storedSession(h);
    holdByAnotherInstance(h, sessionId);

    const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
    const reply = await h.waitFor((f) => f.id === loadId);
    expect(reply.error?.message).toContain(`Cannot load session ${sessionId}: it is open in`);
    expect(reply.error?.data?.["reason"]).toBe("session-leased");

    // Not registered: a prompt on it is an unknown session, not a write.
    const promptId = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "new question" }] });
    expect((await h.waitFor((f) => f.id === promptId)).error).toBeDefined();
    expect(loadContext(h.projectDir, sessionId, dataDirOf(h)).map((m) => m.content)).toEqual(["old question", "old answer"]);
  } finally {
    await h.end();
  }
});

test("a normal session/load takes the lease, and the connection's end releases it", async () => {
  const h = harness({ provider });
  const sessionId = storedSession(h);
  const lockPath = sessionLeasePath(h.projectDir, sessionId, dataDirOf(h));
  try {
    await initialize(h);
    const loadId = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [] });
    expect((await h.waitFor((f) => f.id === loadId)).error).toBeUndefined();

    const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")) as { instanceId: string };
    expect(owner.instanceId).toBe(processInstanceId());

    const promptId = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "new question" }] });
    expect((await h.waitFor((f) => f.id === promptId)).error).toBeUndefined();
    expect(loadContext(h.projectDir, sessionId, dataDirOf(h)).map((m) => m.content)).toContain("new question");
  } finally {
    await h.end();
  }
  expect(existsSync(lockPath)).toBe(false);
});

test("a lease taken over mid-session stops the persist and tells the client", async () => {
  const h = harness({ provider });
  try {
    await initialize(h);
    const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const sessionId = String((await h.waitFor((f) => f.id === newId)).result?.["sessionId"]);
    holdByAnotherInstance(h, sessionId);

    const promptId = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "new question" }] });
    const reply = await h.waitFor((f) => f.id === promptId);
    expect(reply.error?.data?.["reason"]).toBe("session-lease-lost");
    expect(reply.error?.message).toContain("was taken over by");
    expect(loadContext(h.projectDir, sessionId, dataDirOf(h)).map((m) => m.content)).not.toContain("new question");
  } finally {
    await h.end();
  }
});
