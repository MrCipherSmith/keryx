import { expect, test } from "bun:test";
import { SandboxedWebTransport, type WebWorkerRunner } from "./sandboxed-web-transport";

const publicAddress = "93.184.216.34";

test("transport sends a DNS-validated pinned target to its worker", async () => {
  let received: unknown;
  const runner: WebWorkerRunner = {
    run: async (request) => {
      received = request;
      return { ok: true, value: { status: 200, contentType: "text/plain", body: "hello" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner, now: () => "2026-08-12T00:00:00.000Z" });

  const result = await transport.fetchPage({ url: "https://example.com/docs", providerId: "web_fetch" });
  expect(result.ok).toBe(true);
  expect(received).toMatchObject({ url: "https://example.com/docs", hostname: "example.com", address: publicAddress });
  if (result.ok) expect(result.value.text).toContain("hello");
});

test("transport validates every redirect before calling the worker again", async () => {
  let calls = 0;
  const runner: WebWorkerRunner = {
    run: async () => {
      calls += 1;
      return { ok: true, value: { status: 302, location: "https://127.0.0.1/admin", contentType: "text/plain", body: "" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });
  const result = await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" });
  expect(result).toEqual({ ok: false, reason: "private or loopback destination is not allowed" });
  expect(calls).toBe(1);
});

test("transport rejects binary responses and malformed worker results without a retry", async () => {
  let calls = 0;
  const runner: WebWorkerRunner = {
    run: async () => {
      calls += 1;
      return { ok: true, value: { status: 200, contentType: "image/png", body: "binary" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });
  expect(await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" })).toEqual({ ok: false, reason: "response is not readable text content" });
  expect(calls).toBe(1);
});

test("local-search capability is restricted to exact loopback endpoints", async () => {
  let calls = 0;
  const runner: WebWorkerRunner = {
    run: async () => {
      calls += 1;
      return { ok: true, value: { status: 200, contentType: "application/json", body: '{"results":[]}' } };
    },
  };
  const transport = new SandboxedWebTransport({ runner });
  const denied = await transport.request({ providerId: "searxng", capability: "local-search", url: "http://10.0.0.7:8080/search?format=json", method: "GET" });
  expect(denied.error).toBe("policy-denied");
  expect(calls).toBe(0);

  const accepted = await transport.request({ providerId: "searxng", capability: "local-search", url: "http://localhost:8080/search?format=json", method: "GET" });
  expect(accepted.ok).toBe(true);
  expect(calls).toBe(1);
});
