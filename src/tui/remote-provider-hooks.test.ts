// Flow 471 (AC8, review F-001, F-002, F-003, F-007): the provider hooks Telegram's /connect calls.
// Everything they return is sent to a chat, so these tests feed them the dangerous inputs (a provider's
// error text holding masked key fragments, a login failure holding a token) and look at what comes out.

import { describe, expect, it } from "bun:test";
import type { ModelsFailure } from "../commands/providers";
import type { DeviceLoginInput, DeviceLoginResult } from "../lib/oauth/login";
import { createConnectedProvidersCache, createRemoteDeviceLogin, NO_CREDENTIAL_TEXT, remoteFailureText, testProviderForRemote } from "./remote-provider-hooks";

const MASKED = ["sk-proj-****abcd", "sk-ab...wxyz", "key ending in 1a2b3c"];
const TOKEN = "gho_SECRETTOKENVALUE123";
const DEVICE_CODE = "DEVICE-CODE-SECRET-9f8e7d";
const CHALLENGE = { userCode: "WDJB-MJHT", verificationUri: "https://example.com/login/device" };

function leaks(text: string): string[] {
  return [...MASKED, TOKEN, DEVICE_CODE].filter((sample) => text.includes(sample));
}

describe("testProviderForRemote", () => {
  it("says how many models a live provider reports", async () => {
    const out = await testProviderForRemote("acme", { probe: async () => ({ kind: "live", modelCount: 4 }) });
    expect(out).toEqual({ ok: true, message: "ok — 4 model(s)" });
  });

  it("answers an unknown provider and a missing credential in fixed words", async () => {
    expect((await testProviderForRemote("x", { probe: async () => ({ kind: "unknown" }) })).ok).toBe(false);
    expect(await testProviderForRemote("x", { probe: async () => ({ kind: "no-credential" }) })).toEqual({ ok: false, message: NO_CREDENTIAL_TEXT });
  });

  it("never relays a provider's own error text, whatever masked fragments it holds", async () => {
    const failures: ModelsFailure[] = [
      { kind: "rejected", status: 401, detail: `Incorrect API key provided: ${MASKED[0]}. ${MASKED[1]} ${MASKED[2]}` },
      { kind: "http", status: 500, detail: `upstream said ${MASKED.join(" ")}` },
      { kind: "unreachable", detail: `connect ECONNREFUSED ${MASKED.join(" ")}` },
      { kind: "empty", detail: MASKED.join(" ") },
    ] as ModelsFailure[];
    for (const failure of failures) {
      const out = await testProviderForRemote("acme", { probe: async () => ({ kind: "failed", failure }) });
      expect(out.ok).toBe(false);
      expect(leaks(out.message)).toEqual([]);
      expect(out.message).not.toContain("Incorrect API key");
    }
  });

  it("keeps the failure kind and the status", () => {
    expect(remoteFailureText({ kind: "rejected", status: 401, detail: "x" } as ModelsFailure)).toBe("rejected the credential (HTTP 401)");
    expect(remoteFailureText({ kind: "http", status: 503, detail: "x" } as ModelsFailure)).toBe("could not list models (HTTP 503)");
    expect(remoteFailureText({ kind: "unreachable", detail: "x" } as ModelsFailure)).toBe("could not be reached");
    expect(remoteFailureText({ kind: "empty", detail: "x" } as ModelsFailure)).toBe("reports no models");
  });
});

function loginRig(
  login: (input: DeviceLoginInput) => Promise<DeviceLoginResult>,
  extra: { allows?: boolean; busy?: () => boolean; timeoutMs?: number } = {},
) {
  const applied: Array<string | undefined> = [];
  const connected: string[] = [];
  const notes: string[] = [];
  const calls: DeviceLoginInput[] = [];
  const hook = createRemoteDeviceLogin({
    login: async (input) => {
      calls.push(input);
      return login(input);
    },
    fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    applyEnv: (dir) => {
      applied.push(dir);
    },
    allows: () => extra.allows ?? true,
    ...(extra.busy !== undefined ? { isBusy: extra.busy } : {}),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    configDir: "/tmp/cfg",
    onConnected: (id) => connected.push(id),
  });
  const notify = async (text: string) => {
    notes.push(text);
  };
  return { hook, applied, connected, notes, calls, notify };
}

const SUCCESS = { ok: true } as unknown as DeviceLoginResult;

describe("createRemoteDeviceLogin", () => {
  it("notifies once with exactly the user code and the link, then applies the token", async () => {
    const rig = loginRig(async (input) => {
      input.onChallenge?.(CHALLENGE as never);
      return SUCCESS;
    });
    const out = await rig.hook.connect("copilot", rig.notify);
    await Promise.resolve();
    expect(rig.notes).toEqual([`Open ${CHALLENGE.verificationUri} and enter the code ${CHALLENGE.userCode}`]);
    expect(out.ok).toBe(true);
    expect(rig.applied).toEqual(["/tmp/cfg"]);
    expect(rig.connected).toEqual(["copilot"]);
    expect(rig.calls[0]?.dir).toBe("/tmp/cfg");
    expect(rig.hook.running).toBe(false);
  });

  it("refuses a provider without a device login in the catalog and starts no login", async () => {
    const rig = loginRig(async () => SUCCESS, { allows: false });
    const out = await rig.hook.connect("hosted", rig.notify);
    expect(out.ok).toBe(false);
    expect(rig.calls).toEqual([]);
    expect(rig.applied).toEqual([]);
  });

  it("times out, says so, and saves and applies nothing", async () => {
    const rig = loginRig(
      (input) =>
        new Promise<DeviceLoginResult>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)));
        }),
      { timeoutMs: 15 },
    );
    const out = await rig.hook.connect("copilot", rig.notify);
    expect(out).toEqual({ ok: false, message: "Device login timed out; nothing was saved." });
    expect(rig.applied).toEqual([]);
    expect(rig.connected).toEqual([]);
    expect(rig.hook.running).toBe(false);
  });

  it("answers a failed login in fixed words, with no error text, token or device code", async () => {
    const failed = loginRig(async () => ({ ok: false, error: `denied ${TOKEN} ${DEVICE_CODE} ${MASKED.join(" ")}` }) as unknown as DeviceLoginResult);
    const a = await failed.hook.connect("copilot", failed.notify);
    expect(a).toEqual({ ok: false, message: "Device login failed. Try /connect in the shell." });
    const thrown = loginRig(async () => {
      throw new Error(`boom ${TOKEN} ${DEVICE_CODE} ${MASKED.join(" ")}`);
    });
    const b = await thrown.hook.connect("copilot", thrown.notify);
    expect(b).toEqual({ ok: false, message: "Device login failed. Try /connect in the shell." });
    for (const text of [a.message, b.message]) expect(leaks(text)).toEqual([]);
    expect(failed.applied).toEqual([]);
    expect(thrown.applied).toEqual([]);
  });

  it("allows one login at a time: a second Connect is answered, not started", async () => {
    let release: (() => void) | undefined;
    const rig = loginRig(
      () =>
        new Promise<DeviceLoginResult>((resolve) => {
          release = () => resolve(SUCCESS);
        }),
    );
    const first = rig.hook.connect("copilot", rig.notify);
    expect(rig.hook.running).toBe(true);
    const second = await rig.hook.connect("copilot", rig.notify);
    expect(second).toEqual({ ok: false, message: "a device login is already running" });
    expect(rig.calls.length).toBe(1);
    release?.();
    expect((await first).ok).toBe(true);
    // Once it ended, a new one may start.
    const third = rig.hook.connect("copilot", rig.notify);
    release?.();
    expect(rig.calls.length).toBe(2);
    release?.();
    await third;
  });

  it("does not apply the token when the shell became busy during the login", async () => {
    let busy = false;
    const rig = loginRig(
      async () => {
        busy = true;
        return SUCCESS;
      },
      { busy: () => busy },
    );
    const out = await rig.hook.connect("copilot", rig.notify);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("busy");
    expect(rig.applied).toEqual([]);
    expect(rig.connected).toEqual([]);
  });

  it("says so when the login succeeded but was aborted before the token could be applied", async () => {
    let finish: (() => void) | undefined;
    const rig = loginRig(
      () =>
        new Promise<DeviceLoginResult>((resolve) => {
          finish = () => resolve(SUCCESS);
        }),
    );
    const pending = rig.hook.connect("copilot", rig.notify);
    rig.hook.abort();
    finish?.();
    const out = await pending;
    expect(out).toEqual({ ok: false, message: "Signed in, but not applied to this session; run /connect again or restart." });
    expect(rig.applied).toEqual([]);
    expect(rig.connected).toEqual([]);
  });

  it("abort() ends a waiting login, saves nothing and says it was stopped", async () => {
    const rig = loginRig(
      (input) =>
        new Promise<DeviceLoginResult>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = rig.hook.connect("copilot", rig.notify);
    rig.hook.abort();
    expect(await pending).toEqual({ ok: false, message: "Device login was stopped; nothing was saved." });
    expect(rig.applied).toEqual([]);
    expect(rig.hook.running).toBe(false);
  });
});

describe("createConnectedProvidersCache", () => {
  it("loads once for a burst of calls, again after the window, and again after invalidate", async () => {
    let clock = 0;
    let loads = 0;
    const cache = createConnectedProvidersCache(
      async () => {
        loads += 1;
        return { detected: [{ name: "a" }], connected: [{ name: "a" }] };
      },
      { ttlMs: 15_000, now: () => clock },
    );
    await Promise.all([cache.get(), cache.get()]);
    await cache.get();
    expect(loads).toBe(1);
    clock = 20_000;
    await cache.get();
    expect(loads).toBe(2);
    cache.invalidate();
    await cache.get();
    expect(loads).toBe(3);
  });

  it("does not keep a failed load", async () => {
    let loads = 0;
    const cache = createConnectedProvidersCache(async () => {
      loads += 1;
      if (loads === 1) throw new Error("probe failed");
      return { detected: [], connected: [] };
    });
    await expect(cache.get()).rejects.toThrow();
    await cache.get();
    expect(loads).toBe(2);
  });
});
