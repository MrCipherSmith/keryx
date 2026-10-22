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

  it("keeps that refusal when the shell cannot list addable providers", async () => {
    const h = commandHarness({ listProviders: async () => [], listModels: async () => undefined, switchModel: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/connect");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("No provider is connected");
  });

  it("is refused while the shell is busy", async () => {
    const h = commandHarness({ busy: true, listProviders: async () => PROVIDERS, listModels: async () => undefined, switchModel: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/connect");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
  });
});

// Flow 471, AC8: the Add provider list, [Test] and [Connect] (device login only).

const ADDABLE = [
  { id: "acme", label: "Acme", connected: true, deviceLogin: false },
  { id: "copilot", label: "Copilot", connected: false, deviceLogin: true },
  { id: "hosted", label: "Hosted", connected: false, deviceLogin: false },
];
const CODE = "WDJB-MJHT";
const LINK = "https://example.com/login/device";

function addRig(extra: { connected?: typeof PROVIDERS; tested?: string[]; connectedIds?: string[]; switched?: string[] } = {}) {
  const tested = extra.tested ?? [];
  const connectedIds = extra.connectedIds ?? [];
  const switched = extra.switched ?? [];
  return commandHarness({
    listProviders: async () => extra.connected ?? PROVIDERS,
    listModels: async () => undefined,
    switchModel: async (id) => {
      switched.push(id);
      return { output: "", ok: true };
    },
    listAddableProviders: async () => ADDABLE,
    testProvider: async (id) => {
      tested.push(id);
      return id === "hosted" ? { ok: false, message: "no credential, Connect first" } : { ok: true, message: "ok — 3 model(s)" };
    },
    connectWithDeviceLogin: async (id, notify) => {
      connectedIds.push(id);
      await notify(`Open ${LINK} and enter the code ${CODE}`);
      return { ok: true, message: "connected. The session and model are unchanged." };
    },
  });
}

describe("/connect: Add provider (AC8)", () => {
  it("adds an Add provider button after the connected providers", async () => {
    const h = addRig();
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    expect(h.client().choices[0]?.rows).toEqual([["* Acme"], ["Other"], ["Add provider"]]);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("goes straight to the Add provider list when nothing is connected", async () => {
    const h = addRig({ connected: [] });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    expect(h.client().choices[0]?.rows).toEqual([["Acme (connected)"], ["Copilot"], ["Hosted"]]);
    expect(h.client().replies).toEqual([]);
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
  });

  it("lists every addable provider after Add provider is pressed, and offers Test and Connect", async () => {
    const h = addRig();
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(2);
    await waitFor(() => h.client().choices.length === 2, "the add list");
    expect(h.client().choices[1]?.rows).toEqual([["Acme (connected)"], ["Copilot"], ["Hosted"]]);
    h.client().choices[1]?.answer(1);
    await waitFor(() => h.client().choices.length === 3, "Test / Connect");
    expect(h.client().choices[2]?.rows).toEqual([["Test", "Connect"]]);
    h.client().choices[2]?.answer(undefined);
    await h.bridge.idle();
  });

  it("[Test] relays the host message and does not switch the model", async () => {
    const tested: string[] = [];
    const switched: string[] = [];
    const h = addRig({ connected: [], tested, switched });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(0);
    await h.bridge.idle();
    expect(tested).toEqual(["copilot"]);
    expect(h.client().replies).toEqual(["Copilot: ok — 3 model(s)"]);
    expect(switched).toEqual([]);
  });

  it("[Test] relays the no-credential answer", async () => {
    const h = addRig({ connected: [] });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(2);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(0);
    await h.bridge.idle();
    expect(h.client().replies).toEqual(["Hosted: no credential, Connect first"]);
  });

  it("[Connect] on a device-login provider posts the code and link, then the result, and does not switch", async () => {
    const connectedIds: string[] = [];
    const switched: string[] = [];
    const h = addRig({ connected: [], connectedIds, switched });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(1);
    await h.bridge.idle();
    expect(connectedIds).toEqual(["copilot"]);
    expect(h.client().replies.length).toBe(2);
    expect(h.client().replies[0]).toContain(CODE);
    expect(h.client().replies[0]).toContain(LINK);
    expect(h.client().replies[1]).toBe("Copilot: connected. The session and model are unchanged.");
    expect(switched).toEqual([]);
  });

  it("[Connect] on a key provider calls no host hook and sends the key to the shell", async () => {
    const tested: string[] = [];
    const connectedIds: string[] = [];
    const h = addRig({ connected: [], tested, connectedIds });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(2);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(1);
    await h.bridge.idle();
    expect(tested).toEqual([]);
    expect(connectedIds).toEqual([]);
    expect(h.client().replies.length).toBe(1);
    expect(h.client().replies[0]).toContain("entered in the shell");
    expect(h.client().replies[0]).toContain("never in this chat");
    expect(h.client().replies[0]).not.toMatch(/paste|enter your|https?:|base url/i);
  });

  it("changes nothing when the Add list or Test / Connect is not answered", async () => {
    const tested: string[] = [];
    const connectedIds: string[] = [];
    const h = addRig({ connected: [], tested, connectedIds });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(undefined);
    await h.bridge.idle();
    expect(tested).toEqual([]);
    expect(connectedIds).toEqual([]);
    expect(h.client().replies).toEqual([]);
  });

  it("has no Disconnect, key, URL or token button anywhere in the Add provider path", async () => {
    const h = addRig();
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the provider picker");
    h.client().choices[0]?.answer(2);
    await waitFor(() => h.client().choices.length === 2, "the add list");
    h.client().choices[1]?.answer(2);
    await waitFor(() => h.client().choices.length === 3, "Test / Connect");
    for (const choice of h.client().choices) {
      expect(JSON.stringify(choice.rows)).not.toMatch(/disconnect|key|url|token|password/i);
      expect(choice.text).not.toMatch(/paste|enter your|api key|password/i);
    }
    h.client().choices[2]?.answer(undefined);
    await h.bridge.idle();
  });

  it("answers that Test is not available when the shell has no such hook", async () => {
    const h = commandHarness({
      listProviders: async () => [],
      listModels: async () => undefined,
      switchModel: async () => ({ output: "", ok: true }),
      listAddableProviders: async () => ADDABLE,
    });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.client().choices[1]?.answer(0);
    await h.bridge.idle();
    expect(h.client().replies[0]).toContain("not available from this shell");
  });

  it("does not start a device login while the shell is busy", async () => {
    const connectedIds: string[] = [];
    const h = addRig({ connected: [], connectedIds });
    await h.bridge.enable();
    await h.say("/connect");
    await waitFor(() => h.client().choices.length === 1, "the add list");
    h.client().choices[0]?.answer(1);
    await waitFor(() => h.client().choices.length === 2, "Test / Connect");
    h.state.busy = true;
    h.client().choices[1]?.answer(1);
    await h.bridge.idle();
    expect(connectedIds).toEqual([]);
    expect(h.client().replies[0]).toContain("was not run");
  });
});
