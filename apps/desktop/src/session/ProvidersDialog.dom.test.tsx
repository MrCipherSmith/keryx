import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { LoginChallenge, ProviderInfo } from "../acp/providers";
import type { ProvidersApi } from "./ProvidersDialog";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let ProvidersDialog: typeof import("./ProvidersDialog").ProvidersDialog;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ProvidersDialog = (await import("./ProvidersDialog")).ProvidersDialog;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const ALL = [
  "_keryx/providers/list",
  "_keryx/providers/test",
  "_keryx/providers/disconnect",
  "_keryx/providers/connect",
  "_keryx/providers/login",
  "_keryx/providers/login_cancel",
  "_keryx/search_providers/list",
  "_keryx/search_providers/connect",
  "_keryx/search_providers/select",
];

const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", connected: true, authMethods: ["api-key"], needsBaseUrl: false },
  { id: "openai", label: "OpenAI", connected: false, authMethods: ["api-key"], needsBaseUrl: false },
  { id: "openai-codex", label: "OpenAI Codex", connected: false, authMethods: ["device-code"], needsBaseUrl: false },
  { id: "local", label: "Local server", connected: false, authMethods: ["api-key"], needsBaseUrl: true, baseUrl: "http://localhost:11434/v1" },
  { id: "bedrock", label: "Bedrock", connected: false, authMethods: ["api-key"], needsBaseUrl: false, refusal: "Configure AWS credentials in your shell." },
];

interface Call {
  method: string;
  params: unknown;
}
let calls: Call[];
let handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>;
let challengeCb: ((c: LoginChallenge) => void) | null;
let opened: string[];
let loginResolve: ((v: unknown) => void) | null;

const api = (extensions: readonly string[] = ALL): ProvidersApi => ({
  extensions,
  request: (async (method: string, params?: unknown) => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) throw new Error(`no handler for ${method}`);
    return h(params);
  }) as ProvidersApi["request"],
  onChallenge: (cb) => {
    challengeCb = cb;
    return () => {
      challengeCb = null;
    };
  },
  openUrl: (url) => void opened.push(url),
});

beforeEach(async () => {
  await act(() => root.render(null));
  calls = [];
  opened = [];
  challengeCb = null;
  loginResolve = null;
  handlers = {
    "_keryx/providers/list": () => ({ providers: PROVIDERS }),
  };
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: Element) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent!.trim() === label)!;
const tab = (label: string) => Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent!.startsWith(label))!;
const setValue = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (el: Element) => act(async () => void el.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

async function open(name = "connect", args = "", a: ProvidersApi = api()) {
  await act(() => root.render(createElement(ProvidersDialog, { request: { name, args }, api: a, onClose: () => {} })));
  await flush();
}

test("the Connected tab lists connected providers; Add lists the rest and shows a refusal", async () => {
  await open();
  expect(calls[0]).toEqual({ method: "_keryx/providers/list", params: {} });
  const connected = Array.from(document.querySelectorAll(".providers-row")).map((r) => r.getAttribute("data-provider"));
  expect(connected).toEqual(["anthropic"]);
  await click(tab("Add"));
  expect(document.querySelector('[data-provider="bedrock"]')!.textContent).toContain("Configure AWS credentials in your shell.");
  expect((document.querySelector('[data-provider="bedrock"] button') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('[data-provider="openai"]')).not.toBeNull();
  expect(document.querySelector('[data-provider="anthropic"] button')!.textContent).toBe("Reconnect");
});

test("Test reports the result; Disconnect confirms and notes a shared environment variable", async () => {
  handlers["_keryx/providers/test"] = () => ({ ok: true, models: 12 });
  handlers["_keryx/providers/disconnect"] = () => ({ sharedEnvWith: ["openai"] });
  await open();
  await click(button("Test"));
  expect(document.querySelector(".providers-test")!.textContent).toBe("Works: 12 models");
  expect(calls.find((c) => c.method === "_keryx/providers/test")!.params).toEqual({ providerId: "anthropic" });
  await click(button("Disconnect"));
  expect(calls.some((c) => c.method === "_keryx/providers/disconnect")).toBe(false);
  const confirmBtn = Array.from(document.querySelectorAll('[role="dialog"] [role="dialog"] button, .dialog button')).filter((b) => b.textContent === "Disconnect").pop()!;
  await click(confirmBtn);
  await flush();
  expect(calls.find((c) => c.method === "_keryx/providers/disconnect")!.params).toEqual({ providerId: "anthropic" });
  expect(document.body.textContent).toContain("still connects OpenAI");
});

test("API key connect sends the exact params and the key is gone from the DOM afterwards", async () => {
  const KEY = "sk-secret-123456";
  let resolve!: (v: unknown) => void;
  handlers["_keryx/providers/connect"] = () => new Promise((r) => (resolve = r));
  await open();
  await click(tab("Add"));
  await click(document.querySelector('[data-provider="openai"] button')!);
  const input = document.querySelector('input[type="password"]') as HTMLInputElement;
  expect(input.getAttribute("type")).toBe("password");
  input.value = KEY;
  await submit(input);
  // while the request is in flight the field is already empty and the page never shows the key
  expect(input.value).toBe("");
  expect(document.body.innerHTML.includes(KEY)).toBe(false);
  expect(calls.find((c) => c.method === "_keryx/providers/connect")!.params).toEqual({ providerId: "openai", method: "api-key", apiKey: KEY });
  await act(async () => resolve({ ok: true }));
  await flush();
  expect(document.body.textContent).toContain("OpenAI is connected");
  expect(document.body.innerHTML.includes(KEY)).toBe(false);
});

test("a failed connect shows the reason and the retry hint, scrubbed of the key", async () => {
  const KEY = "sk-bad-key-999";
  handlers["_keryx/providers/connect"] = () => ({ ok: false, error: `401 for ${KEY}`, retry: "credential" });
  await open("connect", "openai");
  // `/connect openai` lands on that provider's form
  const input = document.querySelector('input[type="password"]') as HTMLInputElement;
  input.value = KEY;
  await submit(input);
  await flush();
  const err = document.querySelector(".field-error")!.textContent!;
  expect(err).toContain("Check the API key");
  expect(err.includes(KEY)).toBe(false);
  expect(document.body.innerHTML.includes(KEY)).toBe(false);
});

test("a provider that needs a base URL sends it; the custom provider sends name, URL and key", async () => {
  handlers["_keryx/providers/connect"] = () => ({ ok: true });
  await open();
  await click(tab("Add"));
  await click(document.querySelector('[data-provider="local"] button')!);
  const url = document.querySelector('input[placeholder^="https://"]') as HTMLInputElement;
  expect(url.value).toBe("http://localhost:11434/v1");
  await setValue(url, "http://gpu:8000/v1");
  const key = document.querySelector('input[type="password"]') as HTMLInputElement;
  key.value = "k1";
  await submit(key);
  await flush();
  expect(calls.filter((c) => c.method === "_keryx/providers/connect")[0]!.params).toEqual({ providerId: "local", method: "api-key", apiKey: "k1", baseUrl: "http://gpu:8000/v1" });

  await click(tab("Add"));
  await click(document.querySelector('[data-provider="__custom__"] button')!);
  await setValue(document.querySelector('input[name="custom-name"]') as HTMLInputElement, "My LLM");
  await setValue(document.querySelector('input[name="custom-base-url"]') as HTMLInputElement, "https://llm.example/v1");
  const ck = document.querySelector('input[name="custom-api-key"]') as HTMLInputElement;
  ck.value = "k2";
  await submit(ck);
  await flush();
  expect(calls.filter((c) => c.method === "_keryx/providers/connect")[1]!.params).toEqual({ custom: { name: "My LLM", baseUrl: "https://llm.example/v1", apiKey: "k2" } });
});

test("device code: the challenge shows the code, Open browser opens the complete URL, Cancel sends login_cancel", async () => {
  handlers["_keryx/providers/login"] = () => new Promise((r) => (loginResolve = r));
  handlers["_keryx/providers/login_cancel"] = () => {
    loginResolve?.({ outcome: "cancelled" });
    return {};
  };
  await open();
  await click(tab("Add"));
  await click(document.querySelector('[data-provider="openai-codex"] button')!);
  await click(button("Sign in with OpenAI Codex"));
  expect(calls.find((c) => c.method === "_keryx/providers/login")!.params).toEqual({ providerId: "openai-codex" });
  expect(button("Cancel").disabled).toBe(true); // no loginId yet
  await act(async () =>
    challengeCb!({
      loginId: "L1",
      providerId: "openai-codex",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.example/device",
      verificationUriComplete: "https://auth.example/device?user_code=ABCD-1234",
    }),
  );
  expect(document.querySelector(".device-code")!.textContent).toBe("ABCD-1234");
  await click(button("Open browser"));
  expect(opened).toEqual(["https://auth.example/device?user_code=ABCD-1234"]);
  await click(button("Cancel"));
  await flush();
  expect(calls.find((c) => c.method === "_keryx/providers/login_cancel")!.params).toEqual({ loginId: "L1" });
  expect(document.body.textContent).toContain("Sign-in cancelled");
  expect(document.querySelector(".device-code")).toBeNull();
});

test("device code without verificationUriComplete opens the plain verification URL; a challenge for another provider is ignored", async () => {
  handlers["_keryx/providers/login"] = () => new Promise((r) => (loginResolve = r));
  await open();
  await click(tab("Add"));
  await click(document.querySelector('[data-provider="openai-codex"] button')!);
  await click(button("Sign in with OpenAI Codex"));
  await act(async () => challengeCb!({ loginId: "X", providerId: "someone-else", userCode: "NOPE", verificationUri: "https://x" }));
  expect(document.querySelector(".device-code")).toBeNull();
  await act(async () => challengeCb!({ loginId: "L2", providerId: "openai-codex", userCode: "WXYZ", verificationUri: "https://auth.example/device" }));
  await click(button("Open browser"));
  expect(opened).toEqual(["https://auth.example/device"]);
  // a finished login connects and returns to the Connected tab
  await act(async () => loginResolve!({ outcome: "connected" }));
  await flush();
  expect(document.body.textContent).toContain("OpenAI Codex is connected");
});

test("a keryx without the providers methods gets an update notice instead of a dialog body", async () => {
  await open("connect", "", api([]));
  expect(document.body.textContent).toContain("Update keryx");
  expect(calls).toEqual([]);
  expect(document.querySelector('[role="tab"]')).toBeNull();
});

test("/search-provider opens the search tab: Use selects, a key connects", async () => {
  let list = [
    { id: "brave", label: "Brave", connected: true, selected: true },
    { id: "tavily", label: "Tavily", connected: false },
  ];
  handlers["_keryx/search_providers/list"] = () => ({ providers: list });
  handlers["_keryx/search_providers/connect"] = () => {
    list = list.map((p) => (p.id === "tavily" ? { ...p, connected: true } : p));
    return { ok: true };
  };
  await open("search-provider");
  expect(document.querySelector('[data-search-provider="brave"]')!.textContent).toContain("in use");
  const key = document.querySelector('[data-search-provider="tavily"] input') as HTMLInputElement;
  key.value = "tv-key";
  await click(document.querySelector('[data-search-provider="tavily"] button')!);
  await flush();
  expect(calls.find((c) => c.method === "_keryx/search_providers/connect")!.params).toEqual({ providerId: "tavily", apiKey: "tv-key" });
  expect(document.body.innerHTML.includes("tv-key")).toBe(false);
  expect(document.querySelector('[data-search-provider="tavily"] button')!.textContent).toBe("Use");
});
