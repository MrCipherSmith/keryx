// `runAcpServer` in-process, for the flow-288 T14 review findings on model
// selection and slash commands whose evidence is an ORDER between the server
// and a model source it cannot see into:
//
//   1. a model list that never arrives cannot hold `session/new`;
//   4c. `session/cancel` during `/model` leaves the model as it was;
//   5. `session/load` after a restart continues on the recorded model;
//   6. a later switch that fails leaves an earlier successful one in effect.
//
// Every wait is on a frame or on the source being called — never a sleep. The
// one timer is the server's own list bound, set short here.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedEvent, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { acpModelChoice, type AcpModelBinding, type AcpModelChoice, type AcpModelSource } from "./models";
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
  descriptor: { providerId: "server-models-test" },
};

/** A provider whose every turn answers "ran on <label>." — the model a turn ran, on the wire. */
function textProvider(label: string): ProviderPort {
  return {
    describe: () => description,
    stream: (_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: `ran on ${label}.` } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })(),
  };
}

const bindingFor = (choice: AcpModelChoice): AcpModelBinding => ({
  provider: textProvider(choice.modelId),
  providerId: choice.providerId,
  modelId: choice.modelId,
  turnSettings: {},
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Harness = ReturnType<typeof harness>;

async function open(h: Harness, cwd: string): Promise<{ sessionId: string; currentValue: string; values: string[] }> {
  const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
  await h.waitFor((f) => f.id === initId);
  const newId = h.request("session/new", { cwd, mcpServers: [] });
  const reply = await h.waitFor((f) => f.id === newId);
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
  return { sessionId: String(reply.result?.["sessionId"]), ...modelOf(reply.result?.["configOptions"]) };
}

function modelOf(configOptions: unknown): { currentValue: string; values: string[] } {
  const option = (configOptions as { id: string; currentValue: string; options: { value: string }[] }[]).find(
    (entry) => entry.id === "model",
  );
  if (option === undefined) throw new Error(`no model option: ${JSON.stringify(configOptions)}`);
  return { currentValue: option.currentValue, values: option.options.map((entry) => entry.value) };
}

async function prompt(h: Harness, sessionId: string, text: string): Promise<{ stopReason: unknown; text: string }> {
  const before = h.frames.length;
  const id = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  const reply = await h.waitFor((f) => f.id === id);
  const said = h.frames
    .slice(before)
    .filter((f) => f.params?.sessionId === sessionId && f.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((f) => f.params?.update?.content?.text ?? "")
    .join("");
  return { stopReason: reply.result?.["stopReason"], text: said };
}

function tempRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-server-models-")));
}

const LAUNCH = { providerId: "test", modelId: "test-model" };

describe("1 — a model list that never arrives cannot hold session/new", () => {
  test("session/new answers with the launch model once the bound passes, and says so on stderr", async () => {
    const never: AcpModelSource = { choices: () => new Promise(() => {}), bind: async (choice) => bindingFor(choice) };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: never, modelListTimeoutMs: 30 });
    try {
      const opened = await open(h, h.projectDir);
      expect(opened.values).toEqual(["test/test-model"]);
      expect(opened.currentValue).toBe("test/test-model");
      expect(h.stderr.join("\n")).toContain("the model list did not arrive within 30ms");
    } finally {
      await h.end();
    }
  });

  test("a failed list is not cached: the next session asks again and gets it", async () => {
    let failing = true;
    const flaky: AcpModelSource = {
      choices: async () => {
        if (failing) throw new Error("gateway down");
        return [acpModelChoice("test", "test-model"), acpModelChoice("test", "other")];
      },
      bind: async (choice) => bindingFor(choice),
    };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: flaky });
    try {
      const first = await open(h, h.projectDir);
      expect(first.values).toEqual(["test/test-model"]);
      expect(h.stderr.join("\n")).toContain("listing models failed (gateway down)");
      failing = false;
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      const second = await h.waitFor((f) => f.id === newId);
      expect(modelOf(second.result?.["configOptions"]).values).toEqual(["test/test-model", "test/other"]);
    } finally {
      await h.end();
    }
  });
});

describe("6 — overlapping switches", () => {
  test("a later switch that fails leaves the earlier successful one in effect", async () => {
    const pending = new Map<string, { resolve: (value: AcpModelBinding | string) => void }>();
    const called = new Map<string, Promise<void>>();
    const callSignals = new Map<string, () => void>();
    for (const model of ["x", "y"]) {
      called.set(model, new Promise<void>((resolve) => callSignals.set(model, resolve)));
    }
    const source: AcpModelSource = {
      choices: async () => [acpModelChoice("test", "test-model"), acpModelChoice("test", "x"), acpModelChoice("test", "y")],
      bind: (choice) => {
        const d = deferred<AcpModelBinding | string>();
        pending.set(choice.modelId, d);
        callSignals.get(choice.modelId)?.();
        return d.promise;
      },
    };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source });
    try {
      const { sessionId } = await open(h, h.projectDir);
      const toX = h.request("session/set_config_option", { sessionId, configId: "model", value: "test/x" });
      await called.get("x");
      const toY = h.request("session/set_config_option", { sessionId, configId: "model", value: "test/y" });
      await called.get("y");
      pending.get("y")?.resolve("no usable credential");
      const refused = await h.waitFor((f) => f.id === toY);
      expect(refused.error?.message).toContain("cannot switch to test/y: no usable credential");
      pending.get("x")?.resolve(bindingFor(acpModelChoice("test", "x")));
      const applied = await h.waitFor((f) => f.id === toX);
      expect(modelOf(applied.result?.["configOptions"]).currentValue).toBe("test/x");
      expect((await prompt(h, sessionId, "go")).text).toBe("ran on x.");
    } finally {
      await h.end();
    }
  });
});

describe("4c — session/cancel during /model", () => {
  test("answers cancelled, says nothing more, and the switch does not apply", async () => {
    const d = deferred<AcpModelBinding | string>();
    const bindCalled = deferred<void>();
    const source: AcpModelSource = {
      choices: async () => [acpModelChoice("test", "test-model"), acpModelChoice("test", "x")],
      // Finishes building only once the command is cancelled — the order this test is about.
      bind: (choice, signal) => {
        signal?.addEventListener("abort", () => d.resolve(bindingFor(choice)), { once: true });
        bindCalled.resolve();
        return d.promise;
      },
    };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source });
    try {
      const { sessionId } = await open(h, h.projectDir);
      const before = h.frames.length;
      const id = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/model x" }] });
      await bindCalled.promise;
      h.notify("session/cancel", { sessionId });
      const reply = await h.waitFor((f) => f.id === id);
      expect(reply.result?.["stopReason"]).toBe("cancelled");
      const after = h.frames.slice(before).filter((f) => f.params?.sessionId === sessionId);
      expect(after.map((f) => f.params?.update?.sessionUpdate)).toEqual([]);
      expect((await prompt(h, sessionId, "go")).text).toBe("ran on test-model.");
    } finally {
      await h.end();
    }
  });
});

describe("5 — session/load after a restart", () => {
  const source: AcpModelSource = {
    choices: async () => [acpModelChoice("test", "test-model"), acpModelChoice("test", "x")],
    bind: async (choice) => bindingFor(choice),
  };

  async function sessionThatRanX(dataDir: string, cwd: string): Promise<string> {
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source, dataDir });
    try {
      const { sessionId } = await open(h, cwd);
      const setId = h.request("session/set_config_option", { sessionId, configId: "model", value: "test/x" });
      await h.waitFor((f) => f.id === setId);
      expect((await prompt(h, sessionId, "go")).text).toBe("ran on x.");
      return sessionId;
    } finally {
      await h.end();
    }
  }

  async function load(h: Harness, sessionId: string, cwd: string) {
    const initId = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    await h.waitFor((f) => f.id === initId);
    const loadId = h.request("session/load", { sessionId, cwd, mcpServers: [] });
    return h.waitFor((f) => f.id === loadId);
  }

  test("continues on the model the session last ran, when it can still run", async () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    const sessionId = await sessionThatRanX(dataDir, root);
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source, dataDir });
    try {
      const loaded = await load(h, sessionId, root);
      expect(modelOf(loaded.result?.["configOptions"]).currentValue).toBe("test/x");
      expect((await prompt(h, sessionId, "again")).text).toBe("ran on x.");
    } finally {
      await h.end();
    }
  });

  test("falls back to the launch model, and says why, when the recorded one is not available", async () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    const sessionId = await sessionThatRanX(dataDir, root);
    const launchOnly: AcpModelSource = { choices: async () => [acpModelChoice("test", "test-model")], bind: source.bind };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: launchOnly, dataDir });
    try {
      const loaded = await load(h, sessionId, root);
      expect(modelOf(loaded.result?.["configOptions"]).currentValue).toBe("test/test-model");
      const notice = await h.waitFor((f) => (f.params?.update?.content?.text ?? "").includes("last ran test/x"));
      expect(notice.params?.update?.content?.text).toContain("it continues on test/test-model");
    } finally {
      await h.end();
    }
  });
});
