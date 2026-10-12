// Flow 387, AC4: /connect shows the providers that are already connected, then that provider's
// models. There is no Disconnect, key, URL or token step.

import { describe, expect, it } from "bun:test";
import { commandHarness, waitFor } from "./command.test-helpers";

const PROVIDERS = [
  { id: "acme", label: "Acme", current: true },
  { id: "other", label: "Other" },
];

function rig(extra: { switched?: Array<[string, string | undefined]>; listed?: Array<string | undefined> } = {}) {
  const switched = extra.switched ?? [];
  const listed = extra.listed ?? [];
  return commandHarness({
    listProviders: async () => PROVIDERS,
    listModels: async (providerId) => {
      listed.push(providerId);
      return { provider: providerId ?? "acme", models: [{ id: `${providerId ?? "acme"}-1`, label: "First" }, { id: `${providerId ?? "acme"}-2`, label: "Second" }] };
    },
    switchModel: async (id, providerId) => {
      switched.push([id, providerId]);
      return { output: `Now using ${id}`, ok: true };
    },
  });
}

describe("/connect (AC4)", () => {
  it("shows the connected providers first, the current one marked", async () => {
    const h = rig();
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    expect(h.client().choices[0]?.rows).toEqual([["* Acme"], ["Other"]]);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("then shows that provider's models, and switches to the one pressed", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const listed: Array<string | undefined> = [];
    const h = rig({ switched, listed });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(1); // Other
    await waitFor(() => h.client().choices.length === 2, "the model picker");
    expect(listed).toEqual(["other"]);
    expect(h.client().choices[1]?.text).toContain("other");
    expect(h.client().choices[1]?.rows).toEqual([["First"], ["Second"]]);
    h.client().choices[1]?.answer(1);
    await h.bridge.idle();
    expect(switched).toEqual([["other-2", "other"]]);
    expect(h.client().replies).toEqual(["Now using other-2"]);
  });

  it("changes nothing when the provider picker is not answered", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = rig({ switched });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
    expect(switched).toEqual([]);
    expect(h.client().choices.length).toBe(1);
    expect(h.client().replies).toEqual([]);
  });

  it("changes nothing when the model picker is not answered", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = rig({ switched });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(0);
    await waitFor(() => h.client().choices.length === 2, "the model picker");
    h.client().choices[1]?.answer(undefined);
    await h.bridge.idle();
    expect(switched).toEqual([]);
  });

  it("has no Disconnect, key, URL or token step", async () => {
    const h = rig();
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(0);
    await waitFor(() => h.client().choices.length === 2, "the model picker");
    for (const choice of h.client().choices) {
      expect(JSON.stringify(choice.rows)).not.toMatch(/disconnect|key|url|token|password/i);
      expect(choice.text).not.toMatch(/paste|enter your|api key|password/i);
    }
    h.client().choices[1]?.answer(undefined);
    await h.bridge.idle();
    expect(h.client().replies).toEqual([]);
  });

  it("sends the operator to the shell when no provider is connected", async () => {
    const h = commandHarness({
      listProviders: async () => [],
      listModels: async () => undefined,
      switchModel: async () => ({ output: "", ok: true }),
    });
    await h.bridge.enable();
    await h.say("/connect");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("No provider is connected");
    expect(h.client().replies[0]).toContain("never typed into a chat");
  });

  it("is refused while the shell is busy", async () => {
    const h = commandHarness({ busy: true, listProviders: async () => PROVIDERS, listModels: async () => undefined, switchModel: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/connect");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
  });
});
