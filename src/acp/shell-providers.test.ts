// AC14 (specification §8): `_keryx/providers/*` and `_keryx/search_providers/*` over the real
// pipe — list, api-key connect with the key absent from every outbound frame and stderr line,
// device-code login with its challenge and cancel against a fake OAuth transport, disconnect, and
// the `config_option_update` every held session gets afterwards.
//
// Every test runs against a private config directory and a private environment object: nothing
// reads or writes the developer's real `auth.json`, and `process.env` keeps what it had.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SearchProviderController } from "../harness/search";
import { loadOAuthGrant } from "../lib/oauth/grants";
import { loadShellConfig } from "../lib/shell-config";
import { acpModelChoice, type AcpModelChoice } from "./models";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import { ACP_CLIENT_METHODS } from "./protocol";
import { shellHarness, type ShellHarness } from "./shell-profile.test-helpers";
import type { Frame } from "./server-harness.test-helpers";

const KEY = "sk-secret-KEY-0123456789-abcdef";

let configDir: string;
let env: Record<string, string | undefined>;
let savedProcessEnv: Record<string, string | undefined>;
const open: ShellHarness[] = [];

const WATCHED_ENV = ["XAI_API_KEY", "GITHUB_COPILOT_TOKEN"];

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "keryx-acp-providers-"));
  env = {};
  savedProcessEnv = Object.fromEntries(WATCHED_ENV.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
  for (const key of WATCHED_ENV) {
    if (savedProcessEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProcessEnv[key];
  }
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Fetched {
  readonly url: string;
  readonly authorization: string | null;
}

/** A model-list fake: `/api/tags` is Ollama's, every other URL a `/models` endpoint behind `behave`. */
function modelsFetch(behave: (call: Fetched) => Response | Promise<Response>, seen: Fetched[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("Authorization");
    const call = { url, authorization };
    seen.push(call);
    if (url.endsWith("/api/tags")) return json(404, {});
    return behave(call);
  }) as typeof fetch;
}

const liveModels = (...ids: string[]) => () => json(200, { data: ids.map((id) => ({ id })) });

/** The model source the server lists from: grows by `extra` once `connected.value` is true. */
function movingModelSource(connected: { value: boolean }, extra: AcpModelChoice): NonNullable<Parameters<typeof shellHarness>[0]>["serverOptions"] {
  return {
    models: {
      choices: async () => [acpModelChoice("test", "test-model"), ...(connected.value ? [extra] : [])],
      bind: async () => "no binding in this test",
    },
  };
}

async function start(
  serverOptions: NonNullable<Parameters<typeof shellHarness>[0]>["serverOptions"] = {},
  seams: { fetch?: typeof fetch; oauthFetch?: (input: string, init?: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ShellHarness> {
  const h = shellHarness({
    serverOptions: {
      shellConfigDir: configDir,
      providers: { configDir, env, ...seams },
      ...serverOptions,
    },
  });
  open.push(h);
  await h.initialize();
  return h;
}

async function call(h: ShellHarness, method: string, params: Record<string, unknown>): Promise<Frame> {
  const id = h.request(method, params);
  return h.waitFor((f) => f.id === id && f.method === undefined);
}

const outbound = (h: ShellHarness): string => JSON.stringify(h.frames) + h.stderr.join("\n");

const configUpdates = (h: ShellHarness): Frame[] =>
  h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionUpdate && f.params?.update?.sessionUpdate === "config_option_update");

const modelValues = (frame: Frame): string[] => {
  const options = (frame.params?.update as unknown as { configOptions: { options: { value: string }[] }[] }).configOptions;
  return options[0]?.options.map((o) => o.value) ?? [];
};

test("list: every provider with its auth methods; nothing is connected on an empty machine", async () => {
  const h = await start({}, { fetch: modelsFetch(() => json(401, {})) });
  const reply = await call(h, M.providersList, {});
  const rows = (reply.result as { providers: Record<string, unknown>[] }).providers;
  const byId = new Map(rows.map((row) => [row["id"] as string, row]));
  expect(byId.get("grok")?.["authMethods"]).toEqual(["device-code", "api-key"]);
  expect(byId.get("openai-codex")?.["authMethods"]).toEqual(["device-code"]);
  expect(byId.get("groq")?.["authMethods"]).toEqual(["api-key"]);
  expect(byId.get("ollama")).toMatchObject({ authMethods: ["none"], needsBaseUrl: true, connected: false });
  expect(byId.get("gemini")?.["authMethods"]).toEqual(["api-key"]);
  expect(byId.has("fake")).toBe(false);
  expect(rows.filter((row) => row["connected"] === true)).toEqual([]);
  expect(typeof byId.get("groq")?.["label"]).toBe("string");
});

test("list: a saved key makes its provider connected", async () => {
  env["GROQ_API_KEY"] = KEY;
  const h = await start({}, { fetch: modelsFetch(() => json(401, {})) });
  const reply = await call(h, M.providersList, {});
  const rows = (reply.result as { providers: { id: string; connected: boolean }[] }).providers;
  expect(rows.find((row) => row.id === "groq")?.connected).toBe(true);
  expect(rows.find((row) => row.id === "openrouter")?.connected).toBe(false);
  expect(outbound(h)).not.toContain(KEY);
});

test("connect api-key: saved 0600, key in no frame or log line, config_option_update to every held session", async () => {
  const seen: Fetched[] = [];
  const connected = { value: false };
  const h = await start(movingModelSource(connected, acpModelChoice("groq", "llama-x")), {
    fetch: modelsFetch(liveModels("llama-x", "llama-y"), seen),
  });
  const first = await h.newSession();
  const second = await h.newSession();
  const before = configUpdates(h).length;
  connected.value = true;

  const reply = await call(h, M.providersConnect, { providerId: "groq", method: "api-key", apiKey: KEY });
  expect(reply.result).toMatchObject({ ok: true, models: 2 });
  // The live check was made with the key just typed.
  expect(seen.some((s) => s.authorization === `Bearer ${KEY}`)).toBe(true);

  const authFile = path.join(configDir, "auth.json");
  expect(loadShellConfig(configDir).apiKeys?.["GROQ_API_KEY"]).toBe(KEY);
  expect(statSync(authFile).mode & 0o777).toBe(0o600);
  expect(env["GROQ_API_KEY"]).toBe(KEY);

  await h.waitFor(() => configUpdates(h).length >= before + 2);
  const updates = configUpdates(h).slice(before);
  expect(updates.map((u) => u.params?.sessionId).sort()).toEqual([first.sessionId, second.sessionId].sort());
  for (const update of updates) expect(modelValues(update)).toContain("groq/llama-x");

  // The session itself was not switched.
  expect((updates[0]?.params?.update as unknown as { configOptions: { currentValue: string }[] }).configOptions[0]?.currentValue).toBe("test/test-model");

  expect(outbound(h)).not.toContain(KEY);
});

test("connect api-key: a rejected key is answered with retry credential, rolled back, and never echoed", async () => {
  const connected = { value: false };
  const h = await start(movingModelSource(connected, acpModelChoice("groq", "llama-x")), {
    // A gateway that repeats the credential it was sent in its error.
    fetch: modelsFetch((call) => json(401, { error: `Incorrect API key provided: ${call.authorization?.replace("Bearer ", "")}` })),
  });
  await h.newSession();
  const before = configUpdates(h).length;
  const reply = await call(h, M.providersConnect, { providerId: "groq", method: "api-key", apiKey: KEY });
  expect(reply.result).toMatchObject({ ok: false, retry: "credential" });
  expect((reply.result as { error: string }).error).toContain("rejected the credential");
  expect(loadShellConfig(configDir).apiKeys?.["GROQ_API_KEY"]).toBeUndefined();
  expect(env["GROQ_API_KEY"]).toBeUndefined();
  expect(configUpdates(h).length).toBe(before);
  expect(outbound(h)).not.toContain(KEY);
});

test("connect api-key: an unreachable endpoint asks for the base URL again and saves nothing", async () => {
  const h = await start({}, {
    fetch: modelsFetch(() => {
      throw new Error("connect ECONNREFUSED");
    }),
  });
  const reply = await call(h, M.providersConnect, {
    providerId: "groq",
    method: "api-key",
    apiKey: KEY,
    baseUrl: "https://gateway.invalid/openai/v1",
  });
  expect(reply.result).toMatchObject({ ok: false, retry: "base-url" });
  expect(loadShellConfig(configDir).baseUrls?.["groq"]).toBeUndefined();
  expect(loadShellConfig(configDir).apiKeys?.["GROQ_API_KEY"]).toBeUndefined();
  expect(outbound(h)).not.toContain(KEY);
});

test("connect api-key: refusals are answers, not crashes", async () => {
  const h = await start({}, { fetch: modelsFetch(() => json(401, {})) });
  expect((await call(h, M.providersConnect, { providerId: "groq", method: "api-key", apiKey: "  " })).result).toMatchObject({
    ok: false,
    retry: "credential",
  });
  // Ollama takes no key; a device-code-only provider is not connected with one.
  expect((await call(h, M.providersConnect, { providerId: "ollama", method: "api-key", apiKey: KEY })).result).toMatchObject({ ok: false });
  expect((await call(h, M.providersConnect, { providerId: "openai-codex", method: "api-key", apiKey: KEY })).result).toMatchObject({ ok: false });
  const unknown = await call(h, M.providersConnect, { providerId: "no-such", method: "api-key", apiKey: KEY });
  expect(unknown.error?.code).toBe(-32602);
  const badMethod = await call(h, M.providersConnect, { providerId: "groq", method: "device-code" });
  expect(badMethod.error?.code).toBe(-32602);
  expect(existsSync(path.join(configDir, "auth.json"))).toBe(false);
  expect(outbound(h)).not.toContain(KEY);
});

test("connect none: a base-URL-only endpoint (Ollama) is saved and checked at that URL", async () => {
  const urls: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return url === "http://127.0.0.1:9911/api/tags" ? json(200, { models: [{ name: "qwen3:8b" }] }) : json(404, {});
  }) as typeof fetch;
  const h = await start({}, { fetch: fake });
  const reply = await call(h, M.providersConnect, { providerId: "ollama", method: "none", baseUrl: "http://127.0.0.1:9911" });
  expect(reply.result).toMatchObject({ ok: true, models: 1 });
  expect(urls).toContain("http://127.0.0.1:9911/api/tags");
  expect(loadShellConfig(configDir).baseUrls?.["ollama"]).toBe("http://127.0.0.1:9911");

  const wrong = await call(h, M.providersConnect, { providerId: "ollama", method: "none", baseUrl: "http://127.0.0.1:1" });
  expect(wrong.result).toMatchObject({ ok: false, retry: "base-url" });
  // The failed attempt put the earlier endpoint back.
  expect(loadShellConfig(configDir).baseUrls?.["ollama"]).toBe("http://127.0.0.1:9911");
});

test("connect custom: the endpoint is checked live, saved, and listed; a dead one is not kept", async () => {
  const live = { up: true };
  const h = await start({}, {
    fetch: modelsFetch(() => {
      if (!live.up) throw new Error("connect ECONNREFUSED");
      return json(200, { data: [{ id: "local-1" }] });
    }),
  });
  const reply = await call(h, M.providersConnect, {
    custom: { name: "my-gateway", baseUrl: "http://127.0.0.1:8123/v1", apiKey: "custom-secret-key-777" },
  });
  expect(reply.result).toMatchObject({ ok: true, models: 1 });
  const stored = JSON.parse(readFileSync(path.join(configDir, "llm-providers.json"), "utf8")) as { providers: Record<string, { models: string[] }> };
  expect(stored.providers["my-gateway"]?.models).toEqual(["local-1"]);
  const listed = await call(h, M.providersList, {});
  expect((listed.result as { providers: { id: string; connected: boolean }[] }).providers.find((p) => p.id === "my-gateway")?.connected).toBe(true);

  live.up = false;
  const dead = await call(h, M.providersConnect, { custom: { name: "dead-one", baseUrl: "http://127.0.0.1:1/v1", apiKey: "custom-secret-key-777" } });
  expect(dead.result).toMatchObject({ ok: false, retry: "base-url" });
  const after = JSON.parse(readFileSync(path.join(configDir, "llm-providers.json"), "utf8")) as { providers: Record<string, unknown> };
  expect(Object.keys(after.providers)).toEqual(["my-gateway"]);

  const taken = await call(h, M.providersConnect, { custom: { name: "groq", baseUrl: "http://127.0.0.1:1/v1" } });
  expect(taken.result).toMatchObject({ ok: false });
  expect(outbound(h)).not.toContain("custom-secret-key-777");
});

test("test: a connected provider reports its model count, a refused one the reason", async () => {
  env["GROQ_API_KEY"] = KEY;
  let reject = false;
  const h = await start({}, {
    fetch: modelsFetch((call) =>
      reject ? json(401, { error: `bad key ${call.authorization}` }) : json(200, { data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    ),
  });
  expect((await call(h, M.providersTest, { providerId: "groq" })).result).toEqual({ ok: true, models: 3 });
  reject = true;
  const failed = (await call(h, M.providersTest, { providerId: "groq" })).result as { ok: boolean; error: string };
  expect(failed.ok).toBe(false);
  expect(failed.error).toContain("rejected the credential");
  expect((await call(h, M.providersTest, { providerId: "nope" })).error?.code).toBe(-32602);
  expect(outbound(h)).not.toContain(KEY);
});

test("disconnect: removes the saved key, names the providers sharing it, and refreshes the sessions", async () => {
  const connected = { value: false };
  const h = await start(movingModelSource(connected, acpModelChoice("zai", "glm-x")), { fetch: modelsFetch(liveModels("glm-x")) });
  await h.newSession();
  connected.value = true;
  expect((await call(h, M.providersConnect, { providerId: "zai", method: "api-key", apiKey: KEY })).result).toMatchObject({ ok: true });
  await h.waitFor(() => configUpdates(h).length >= 1);
  const before = configUpdates(h).length;
  connected.value = false;

  const reply = await call(h, M.providersDisconnect, { providerId: "zai" });
  expect(reply.result).toEqual({ sharedEnvWith: ["zai-coding"] });
  expect(loadShellConfig(configDir).apiKeys?.["ZAI_API_KEY"]).toBeUndefined();
  await h.waitFor(() => configUpdates(h).length > before);
  expect(modelValues(configUpdates(h).at(-1) as Frame)).not.toContain("zai/glm-x");
  expect(outbound(h)).not.toContain(KEY);
});

test("disconnect: a key the user exported themselves cannot be removed from here", async () => {
  env["GROQ_API_KEY"] = KEY;
  const h = await start({}, { fetch: modelsFetch(() => json(401, {})) });
  const reply = await call(h, M.providersDisconnect, { providerId: "groq" });
  expect(reply.error?.code).toBe(-32602);
  expect(reply.error?.message).toContain("GROQ_API_KEY");
  expect(outbound(h)).not.toContain(KEY);
});

/** The device-code endpoints of `grok`: pending until `grant` is true, then a token. */
function deviceFake(state: { grant: boolean }): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    if (input.includes("/device/code")) {
      return json(200, {
        device_code: "dev-secret",
        user_code: "WXYZ-9",
        verification_uri: "https://auth.example/verify",
        verification_uri_complete: "https://auth.example/verify?code=WXYZ-9",
        interval: 1,
        expires_in: 60,
      });
    }
    return state.grant
      ? json(200, { access_token: "grok-access-token", refresh_token: "grok-refresh", expires_in: 3600 })
      : json(400, { error: "authorization_pending" });
  };
}

test("login: the challenge is sent while polling, the grant is saved, and the login request answers connected", async () => {
  const state = { grant: false };
  const connected = { value: false };
  const h = await start(movingModelSource(connected, acpModelChoice("grok", "grok-4")), {
    oauthFetch: deviceFake(state),
    sleep: async () => {
      state.grant = true;
    },
  });
  await h.newSession();
  connected.value = true;
  const id = h.request(M.providersLogin, { providerId: "grok" });
  const challenge = await h.waitFor((f) => f.method === M.providersLoginChallenge);
  expect(challenge.params).toMatchObject({
    providerId: "grok",
    userCode: "WXYZ-9",
    verificationUri: "https://auth.example/verify",
    verificationUriComplete: "https://auth.example/verify?code=WXYZ-9",
  });
  expect(typeof (challenge.params as { loginId?: unknown }).loginId).toBe("string");
  const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
  expect(reply.result).toEqual({ outcome: "connected" });
  expect(loadOAuthGrant("grok", configDir)?.access).toBe("grok-access-token");
  expect(statSync(path.join(configDir, "auth.json")).mode & 0o777).toBe(0o600);
  await h.waitFor(() => configUpdates(h).length >= 1);
  // The device code the vendor issued never reaches the client.
  expect(outbound(h)).not.toContain("dev-secret");
  expect(outbound(h)).not.toContain("grok-access-token");
});

test("login_cancel: stops the poll, the login answers cancelled, and no grant is written", async () => {
  const state = { grant: false };
  const h = await start({}, {
    oauthFetch: deviceFake(state),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  const id = h.request(M.providersLogin, { providerId: "grok" });
  const challenge = await h.waitFor((f) => f.method === M.providersLoginChallenge);
  const loginId = (challenge.params as { loginId: string }).loginId;
  const cancel = await call(h, M.providersLoginCancel, { loginId });
  expect(cancel.result).toEqual({});
  const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
  expect(reply.result).toEqual({ outcome: "cancelled" });
  expect(loadOAuthGrant("grok", configDir)).toBeUndefined();
  // A cancel for a login that is over is a no-op.
  expect((await call(h, M.providersLoginCancel, { loginId })).result).toEqual({});
});

test("login: a provider with no device login is refused with the vendor's reason, and one login per provider at a time", async () => {
  const state = { grant: false };
  const h = await start({}, { oauthFetch: deviceFake(state), sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) });
  const refused = await call(h, M.providersLogin, { providerId: "anthropic" });
  expect(refused.result).toMatchObject({ outcome: "failed" });
  expect((refused.result as { error: string }).error).toContain("Claude Pro/Max");

  const first = h.request(M.providersLogin, { providerId: "grok" });
  const challenge = await h.waitFor((f) => f.method === M.providersLoginChallenge);
  const second = await call(h, M.providersLogin, { providerId: "grok" });
  expect(second.result).toMatchObject({ outcome: "failed" });
  await call(h, M.providersLoginCancel, { loginId: (challenge.params as { loginId: string }).loginId });
  expect((await h.waitFor((f) => f.id === first && f.method === undefined)).result).toEqual({ outcome: "cancelled" });
});

/** A search-provider controller over an in-memory store: what the dialog drives. */
function fakeSearch(calls: { connect: unknown[][] }): SearchProviderController {
  const connectedIds = new Set<string>(["duckduckgo"]);
  let active = "duckduckgo";
  const descriptors = [
    { id: "duckduckgo", displayName: "DuckDuckGo", credentialSchema: { required: false, secret: true } },
    { id: "brave", displayName: "Brave Search", credentialSchema: { required: true, secret: true } },
  ];
  return {
    configurable: () => descriptors,
    selectable: () => descriptors.filter((d) => connectedIds.has(d.id)),
    active: () => descriptors.find((d) => d.id === active),
    connect: async (id: string, fields: unknown, credential: string | undefined, options: unknown) => {
      calls.connect.push([id, fields, credential, options]);
      if (credential === "wrong") return { ok: false, reason: "invalid-credential" };
      connectedIds.add(id);
      return { ok: true, active: false, servesPages: false };
    },
    select: async (id: string) => {
      if (!connectedIds.has(id)) return { ok: false, reason: "not-connected" };
      active = id;
      return { ok: true };
    },
  } as unknown as SearchProviderController;
}

test("search providers: list, connect (key never echoed, not activated), select", async () => {
  const calls = { connect: [] as unknown[][] };
  const h = await start({ searchController: fakeSearch(calls) });
  const listed = (await call(h, M.searchProvidersList, {})).result as { providers: Record<string, unknown>[] };
  expect(listed.providers).toEqual([
    { id: "duckduckgo", label: "DuckDuckGo", connected: true, selected: true, needsKey: false },
    { id: "brave", label: "Brave Search", connected: false, selected: false, needsKey: true },
  ]);

  expect((await call(h, M.searchProvidersConnect, { providerId: "brave" })).result).toMatchObject({ ok: false });
  expect((await call(h, M.searchProvidersConnect, { providerId: "brave", apiKey: "wrong" })).result).toMatchObject({
    ok: false,
    error: expect.stringContaining("rejected"),
  });
  expect((await call(h, M.searchProvidersSelect, { providerId: "brave" })).result).toMatchObject({ ok: false });
  expect((await call(h, M.searchProvidersConnect, { providerId: "brave", apiKey: KEY })).result).toEqual({ ok: true });
  expect(calls.connect.at(-1)).toEqual(["brave", {}, KEY, { activate: false }]);
  expect((await call(h, M.searchProvidersSelect, { providerId: "brave" })).result).toEqual({ ok: true });
  const after = (await call(h, M.searchProvidersList, {})).result as { providers: { id: string; selected: boolean }[] };
  expect(after.providers.find((p) => p.id === "brave")?.selected).toBe(true);
  expect((await call(h, M.searchProvidersSelect, { providerId: "nope" })).error?.code).toBe(-32602);
  expect(outbound(h)).not.toContain(KEY);
});

test("the editor profile does not serve them, and the shell profile advertises them", async () => {
  const editor = shellHarness({ profile: "editor" });
  open.push(editor);
  await editor.initialize();
  expect((await call(editor, M.providersList, {})).error?.code).toBe(-32601);

  const h = await start();
  const info = await call(h, "_keryx/info", {});
  const extensions = (info.result as { extensions: string[] }).extensions;
  for (const method of [
    M.providersList,
    M.providersTest,
    M.providersDisconnect,
    M.providersConnect,
    M.providersLogin,
    M.providersLoginCancel,
    M.providersLoginChallenge,
    M.searchProvidersList,
    M.searchProvidersConnect,
    M.searchProvidersSelect,
  ]) {
    expect(extensions).toContain(method);
  }
});

test("a request before initialize is refused", async () => {
  const h = shellHarness({ serverOptions: { providers: { configDir, env } } });
  open.push(h);
  const reply = await call(h, M.providersList, {});
  expect(reply.error?.code).toBe(-32600);
});
