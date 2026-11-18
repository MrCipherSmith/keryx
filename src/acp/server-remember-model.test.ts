// A model the operator switches to explicitly (`session/set_config_option` or
// `/model`) is remembered: it is handed to `rememberModel` (the CLI saves it as
// `keryx shell`'s saved provider/model) and a NEW session starts on it.

import { describe, expect, test } from "bun:test";
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

const LAUNCH = { providerId: "test", modelId: "test-model" };
const ALL = [acpModelChoice("test", "test-model"), acpModelChoice("test", "x"), acpModelChoice("test", "y")];

function source(): AcpModelSource {
  return { choices: async () => ALL, bind: async (choice) => bindingFor(choice) };
}

describe("a model chosen in the desktop is the default for new sessions", () => {
  test("set_config_option, then a new session starts on it and the choice is saved once", async () => {
    const saved: string[] = [];
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source(), rememberModel: (c) => saved.push(c.value) });
    try {
      const first = await open(h, h.projectDir);
      expect(first.currentValue).toBe("test/test-model");
      const id = h.request("session/set_config_option", { sessionId: first.sessionId, configId: "model", value: "test/x" });
      await h.waitFor((f) => f.id === id);
      expect(saved).toEqual(["test/x"]);
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      const second = await h.waitFor((f) => f.id === newId);
      expect(modelOf(second.result?.["configOptions"]).currentValue).toBe("test/x");
      expect((await prompt(h, String(second.result?.["sessionId"]), "go")).text).toBe("ran on x.");
      // Opening a session and running a turn writes nothing.
      expect(saved).toEqual(["test/x"]);
    } finally {
      await h.end();
    }
  });

  test("/model <x> is remembered too", async () => {
    const saved: string[] = [];
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source(), rememberModel: (c) => saved.push(c.value) });
    try {
      const first = await open(h, h.projectDir);
      expect((await prompt(h, first.sessionId, "/model y")).text).toContain("Model: test/y");
      expect(saved).toEqual(["test/y"]);
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      const second = await h.waitFor((f) => f.id === newId);
      expect(modelOf(second.result?.["configOptions"]).currentValue).toBe("test/y");
    } finally {
      await h.end();
    }
  });

  test("a remembered model that can no longer be bound falls back to the launch model", async () => {
    let failing = false;
    const src: AcpModelSource = {
      choices: async () => ALL,
      bind: async (choice) => (failing && choice.modelId === "x" ? "no usable credential" : bindingFor(choice)),
    };
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: src });
    try {
      const first = await open(h, h.projectDir);
      const id = h.request("session/set_config_option", { sessionId: first.sessionId, configId: "model", value: "test/x" });
      await h.waitFor((f) => f.id === id);
      failing = true;
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      const second = await h.waitFor((f) => f.id === newId);
      expect(modelOf(second.result?.["configOptions"]).currentValue).toBe("test/test-model");
      expect(h.stderr.join("\n")).toContain("remembered model test/x cannot run");
    } finally {
      await h.end();
    }
  });

  test("a session keeps its own model when the default changes afterwards", async () => {
    const h = harness({ ...LAUNCH, provider: textProvider("test-model"), models: source() });
    try {
      const a = await open(h, h.projectDir);
      const toX = h.request("session/set_config_option", { sessionId: a.sessionId, configId: "model", value: "test/x" });
      await h.waitFor((f) => f.id === toX);
      const newId = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
      const b = await h.waitFor((f) => f.id === newId);
      const bId = String(b.result?.["sessionId"]);
      const toY = h.request("session/set_config_option", { sessionId: bId, configId: "model", value: "test/y" });
      await h.waitFor((f) => f.id === toY);
      expect((await prompt(h, a.sessionId, "go")).text).toBe("ran on x.");
      expect((await prompt(h, bId, "go")).text).toBe("ran on y.");
    } finally {
      await h.end();
    }
  });

  test("a failing save does not fail the switch", async () => {
    const h = harness({
      ...LAUNCH,
      provider: textProvider("test-model"),
      models: source(),
      rememberModel: () => {
        throw new Error("disk full");
      },
    });
    try {
      const first = await open(h, h.projectDir);
      const id = h.request("session/set_config_option", { sessionId: first.sessionId, configId: "model", value: "test/x" });
      const reply = await h.waitFor((f) => f.id === id);
      expect(reply.error).toBeUndefined();
      expect(h.stderr.join("\n")).toContain("could not save test/x as the default model (disk full)");
    } finally {
      await h.end();
    }
  });
});
