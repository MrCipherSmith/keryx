// Flow 387, AC11: no secret reaches the topic. Output is redacted, picker labels are redacted, and
// nothing in the topic ever asks for a credential.

import { describe, expect, it } from "bun:test";
import { commandHarness, SECRET, waitFor } from "./command.test-helpers";

const KEY_BODY = "AbCdEfGhIjKlMnOp";

function everything(h: ReturnType<typeof commandHarness>): string {
  const client = h.client();
  return JSON.stringify({ replies: client.replies, choices: client.choices.map((choice) => ({ text: choice.text, rows: choice.rows })) });
}

describe("no secret reaches the topic (AC11)", () => {
  it("redacts command output", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: `key: ${SECRET}`, ok: true }) });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    expect(everything(h)).not.toContain(KEY_BODY);
  });

  it("redacts the output of a failed command", async () => {
    const h = commandHarness({ runCommand: async () => ({ output: `rejected ${SECRET}`, ok: false }) });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    expect(everything(h)).not.toContain(KEY_BODY);
  });

  it("redacts the message of a command that throws", async () => {
    const h = commandHarness({
      runCommand: async () => {
        throw new Error(`bad key ${SECRET}`);
      },
    });
    await h.bridge.enable();
    await h.say("/status");
    await h.bridge.idle();
    expect(everything(h)).not.toContain(KEY_BODY);
  });

  it("redacts a model label shown on a picker button", async () => {
    const h = commandHarness({
      listModels: async () => ({ provider: "acme", models: [{ id: "m1", label: `model ${SECRET}` }, { id: "m2", label: "plain" }] }),
      switchModel: async () => ({ output: "ok", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    expect(everything(h)).not.toContain(KEY_BODY);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("redacts a provider label shown on a picker button", async () => {
    const h = commandHarness({
      listProviders: async () => [{ id: "p1", label: `acme ${SECRET}` }],
      listModels: async () => ({ provider: "acme", models: [{ id: "m", label: "m" }] }),
      switchModel: async () => ({ output: "ok", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    expect(everything(h)).not.toContain(KEY_BODY);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("redacts the task shown in a confirmation", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say(`/delegate claude fix the thing with ${SECRET}`);
    await waitFor(() => h.client().choices.length === 1, "the question");
    expect(everything(h)).not.toContain(KEY_BODY);
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
  });

  it("does not echo a typed secret back in a refusal", async () => {
    const h = commandHarness();
    await h.bridge.enable();
    await h.say(`/provider ${SECRET}`);
    await h.say(`/${SECRET}`);
    await h.bridge.idle();
    expect(everything(h)).not.toContain(KEY_BODY);
  });

  it("redacts the switch result of a model change", async () => {
    const h = commandHarness({
      listModels: async () => ({ provider: "acme", models: [{ id: "m1", label: "one" }] }),
      switchModel: async () => ({ output: `switched using ${SECRET}`, ok: true }),
    });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(0);
    await h.bridge.idle();
    expect(h.client().replies.length).toBe(1);
    expect(everything(h)).not.toContain(KEY_BODY);
  });
});

describe("no credential prompt remotely (AC11)", () => {
  it("refuses the commands that take a key, a URL or a token", async () => {
    for (const line of ["/provider", "/search-provider", "/search-connect", "/setup", "/integrate", "/mcp trust"]) {
      const h = commandHarness();
      await h.bridge.enable();
      await h.say(line);
      await h.bridge.idle();
      expect(h.client().replies[0]).toContain("Not available remotely");
      expect(h.client().choices).toEqual([]);
      expect(h.ran).toEqual([]);
    }
  });

  it("says a new provider is connected in the shell when none is connected", async () => {
    const h = commandHarness({
      listProviders: async () => [],
      listModels: async () => undefined,
      switchModel: async () => ({ output: "", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/connect");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("use the shell");
  });

  it("offers no Disconnect, key, URL or token button on /connect or /model", async () => {
    const h = commandHarness({
      listProviders: async () => [{ id: "p1", label: "acme", current: true }, { id: "p2", label: "other" }],
      listModels: async () => ({ provider: "acme", models: [{ id: "m1", label: "one" }, { id: "m2", label: "two" }] }),
      switchModel: async () => ({ output: "ok", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    const providers = JSON.stringify(h.client().choices[0]?.rows);
    expect(providers).not.toMatch(/disconnect|api key|token|url|password/i);
    h.client().choices[0]?.answer(0);
    await waitFor(() => h.client().choices.length === 2, "the model picker");
    const models = JSON.stringify(h.client().choices[1]?.rows);
    expect(models).not.toMatch(/disconnect|api key|token|url|password/i);
    h.client().choices[1]?.answer(undefined);
    await h.bridge.idle();
  });
});
