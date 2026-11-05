import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProviderConnection } from "../tui/tui-shell";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_PICKER,
  connectionProviderByName,
  fetchAnthropicModels,
  resolveModelsForPicker,
  testProviderConnection,
} from "./providers";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "keryx-anthropic-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = "anthropic-test-key";
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";

interface Seen {
  url: string;
  headers: Headers;
}
function fakeFetch(seen: Seen[], respond: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
}
const liveBody = () =>
  Response.json({ data: [{ id: "claude-opus-new" }, { id: "claude-sonnet-new" }, { id: "claude-opus-new" }, { id: "claude-haiku-old" }] });

test("anthropic is resolvable as a connection provider (no more 'unknown provider')", () => {
  const provider = connectionProviderByName("anthropic", root());
  expect(provider).toBe(ANTHROPIC_PICKER);
  expect(provider?.envKey).toBe("ANTHROPIC_API_KEY");
});

test("fetchAnthropicModels uses x-api-key + anthropic-version, never Bearer, and keeps API order", async () => {
  const seen: Seen[] = [];
  const result = await fetchAnthropicModels(fakeFetch(seen, liveBody), KEY);
  expect(result).toEqual({ source: "live", models: ["claude-opus-new", "claude-sonnet-new", "claude-haiku-old"] });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(MODELS_URL);
  expect(seen[0]!.headers.get("x-api-key")).toBe(KEY);
  expect(seen[0]!.headers.get("anthropic-version")).toBe(ANTHROPIC_API_VERSION);
  expect(seen[0]!.headers.has("authorization")).toBe(false);
});

test.each([401, 403])("fetchAnthropicModels reports HTTP %i as a rejected credential", async (status) => {
  const result = await fetchAnthropicModels(fakeFetch([], () => Response.json({ error: { message: "invalid x-api-key" } }, { status })), KEY);
  expect(result.source).toBe("fallback");
  expect(result.models).toEqual([]);
  expect(result.failure?.kind).toBe("rejected");
});

test("fetchAnthropicModels reports other HTTP errors, empty lists and unreachable hosts", async () => {
  expect((await fetchAnthropicModels(fakeFetch([], () => new Response("", { status: 503 })), KEY)).failure?.kind).toBe("http");
  expect((await fetchAnthropicModels(fakeFetch([], () => Response.json({ data: [] })), KEY)).failure?.kind).toBe("empty");
  const down = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await fetchAnthropicModels(down, KEY);
  expect(result.failure?.kind).toBe("unreachable");
});

test("testProviderConnection hits Anthropic's native endpoint with the saved/env key", async () => {
  const seen: Seen[] = [];
  const result = await testProviderConnection(ANTHROPIC_PICKER, fakeFetch(seen, liveBody), { ANTHROPIC_API_KEY: KEY }, { dir: root() });
  expect(result.source).toBe("live");
  expect(result.models).toHaveLength(3);
  expect(seen[0]!.url).toBe(MODELS_URL);
  expect(seen[0]!.headers.get("x-api-key")).toBe(KEY);
});

test("model picker shows the LIVE Anthropic list when a key exists, the curated list otherwise", async () => {
  const dir = root();
  const entry = { name: "anthropic", models: ["curated-stale"], envKey: "ANTHROPIC_API_KEY" };
  const seen: Seen[] = [];
  const live = await resolveModelsForPicker(fakeFetch(seen, liveBody), entry, { ANTHROPIC_API_KEY: KEY }, { configDir: dir });
  expect(live.source).toBe("live");
  expect(live.models[0]).toBe("claude-opus-new");
  const keyless: Seen[] = [];
  const curated = await resolveModelsForPicker(fakeFetch(keyless, liveBody), entry, {}, { configDir: dir });
  expect(curated).toEqual({ source: "fallback", models: ["curated-stale"] });
  expect(keyless).toEqual([]);
});

test("/connect [Test] for Anthropic probes live instead of answering 'unknown provider'", async () => {
  const dir = root();
  const seen: Seen[] = [];
  const outcome = await probeProviderConnection("anthropic", { fetch: fakeFetch(seen, liveBody), env: { ANTHROPIC_API_KEY: KEY }, configDir: dir, requireCredential: true });
  expect(outcome).toMatchObject({ kind: "live", modelCount: 3 });
  const bad = await probeProviderConnection("anthropic", { fetch: fakeFetch([], () => new Response("", { status: 401 })), env: { ANTHROPIC_API_KEY: KEY }, configDir: dir, requireCredential: true });
  expect(bad).toMatchObject({ kind: "failed", failure: { kind: "rejected", status: 401 } });
  const none = await probeProviderConnection("anthropic", { fetch: fakeFetch([], liveBody), env: {}, configDir: dir, requireCredential: true });
  expect(none.kind).toBe("no-credential");
});
