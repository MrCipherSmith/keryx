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

test("search requests ask for browser-shaped headers; a fetched page does not", async () => {
  const received: Record<string, unknown>[] = [];
  const runner: WebWorkerRunner = {
    run: async (request) => {
      received.push(request as unknown as Record<string, unknown>);
      return { ok: true, value: { status: 200, contentType: "text/html", body: "hello" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });

  await transport.request({ providerId: "duckduckgo", capability: "public-search", url: "https://example.com/lite/?q=x", method: "GET" });
  await transport.fetchPage({ url: "https://example.com/docs", providerId: "web_fetch" });

  expect(received[0]).toMatchObject({ browserHeaders: true });
  // web_fetch keeps the transport's plain request: a page the operator asked
  // for by URL must not be requested as if a browser were loading it.
  expect(received[1]).not.toHaveProperty("browserHeaders");
});

test("AC2: a credential does not survive a cross-origin redirect", async () => {
  const received: Record<string, unknown>[] = [];
  const runner: WebWorkerRunner = {
    run: async (request) => {
      received.push(request as unknown as Record<string, unknown>);
      if (received.length === 1) {
        return { ok: true, value: { status: 302, location: "https://attacker.example/steal", contentType: "text/plain", body: "" } };
      }
      return { ok: true, value: { status: 200, contentType: "text/plain", body: "ok" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });

  const result = await transport.request({
    providerId: "tavily",
    capability: "public-search",
    url: "https://example.com/search?q=x",
    method: "GET",
    credential: { injection: "header", name: "Authorization", value: "Bearer secret-token" },
  });

  expect(result.ok).toBe(true);
  expect(received).toHaveLength(2);
  expect(received[0]).toHaveProperty("credential");
  expect(received[1]).not.toHaveProperty("credential");
  expect((received[1] as { hostname?: string }).hostname).toBe("attacker.example");
});

test("AC2: a same-origin redirect (path change only) still carries the credential", async () => {
  const received: Record<string, unknown>[] = [];
  const runner: WebWorkerRunner = {
    run: async (request) => {
      received.push(request as unknown as Record<string, unknown>);
      if (received.length === 1) {
        return { ok: true, value: { status: 302, location: "https://example.com/search/final?q=x", contentType: "text/plain", body: "" } };
      }
      return { ok: true, value: { status: 200, contentType: "text/plain", body: "ok" } };
    },
  };
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });

  const result = await transport.request({
    providerId: "tavily",
    capability: "public-search",
    url: "https://example.com/search?q=x",
    method: "GET",
    credential: { injection: "header", name: "Authorization", value: "Bearer secret-token" },
  });

  expect(result.ok).toBe(true);
  expect(received).toHaveLength(2);
  expect(received[0]).toHaveProperty("credential");
  expect(received[1]).toHaveProperty("credential");
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A runner that honours the abort signal the way the real worker does. */
function abortableRunner(delayMs: number, seen: AbortSignal[], response: () => { status: number; location?: string }): WebWorkerRunner {
  return {
    run: (_request, signal) => new Promise((resolve) => {
      if (signal !== undefined) seen.push(signal);
      const timer = setTimeout(() => resolve({ ok: true, value: { contentType: "text/plain", body: "", ...response() } }), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({ ok: false, reason: "cancelled" });
      });
    }),
  };
}

test("one overall deadline spans every redirect hop and aborts the running hop", async () => {
  const seen: AbortSignal[] = [];
  let hop = 0;
  const runner = abortableRunner(60, seen, () => (++hop < 4 ? { status: 302, location: `https://example.com/${hop}` } : { status: 200 }));
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner, deadlineMs: 150 });
  const started = performance.now();
  const result = await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" });
  expect(result).toEqual({ ok: false, reason: "web request deadline exceeded" });
  expect(performance.now() - started).toBeLessThan(400);
  expect(hop).toBeLessThan(4);
  expect(seen.at(-1)?.aborted).toBe(true);
});

test("a hanging DNS lookup is bounded by the same deadline", async () => {
  const runner: WebWorkerRunner = { run: async () => ({ ok: true, value: { status: 200, contentType: "text/plain", body: "x" } }) };
  const transport = new SandboxedWebTransport({ lookup: () => new Promise(() => {}), runner, deadlineMs: 80 });
  const started = performance.now();
  const result = await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" });
  expect(result).toEqual({ ok: false, reason: "web request deadline exceeded" });
  expect(performance.now() - started).toBeLessThan(400);
});

test("a caller abort reaches the worker and is reported as cancelled", async () => {
  const seen: AbortSignal[] = [];
  const runner = abortableRunner(5_000, seen, () => ({ status: 200 }));
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });
  const controller = new AbortController();
  const pending = transport.request({ providerId: "duckduckgo", capability: "public-search", url: "https://example.com/?q=x", method: "GET", signal: controller.signal });
  await sleep(20);
  controller.abort();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.error).toBe("cancelled");
  expect(seen[0]?.aborted).toBe(true);
});

test("a request inside the deadline is unaffected", async () => {
  const runner = abortableRunner(5, [], () => ({ status: 200 }));
  const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner, deadlineMs: 2_000 });
  expect((await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" })).ok).toBe(true);
});

test("a worker status outside 100-599 is rejected as an invalid response", async () => {
  for (const status of [99, 600, 200.5, Number.NaN]) {
    const runner: WebWorkerRunner = { run: async () => ({ ok: true, value: { status, contentType: "text/plain", body: "x" } }) };
    const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });
    expect(await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" })).toEqual({ ok: false, reason: "sandbox worker returned an invalid response" });
  }
});

test("a local-search endpoint never follows a redirect", async () => {
  let calls = 0;
  const runner: WebWorkerRunner = {
    run: async () => {
      calls += 1;
      return { ok: true, value: { status: 302, location: "http://localhost:8080/other", contentType: "text/plain", body: "" } };
    },
  };
  const transport = new SandboxedWebTransport({ runner });
  const result = await transport.request({ providerId: "searxng", capability: "local-search", url: "http://localhost:8080/search", method: "GET" });
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
  const direct = await (transport as unknown as { fetchRaw(r: object): Promise<unknown> }).fetchRaw({ url: "http://localhost:8080/search", method: "GET", localOnly: true });
  expect(direct).toEqual({ ok: false, reason: "local search redirects are not allowed" });
});

test("a redirect without a Location string is an invalid redirect destination", async () => {
  for (const location of [undefined, 42 as unknown as string]) {
    const runner: WebWorkerRunner = {
      run: async () => ({ ok: true, value: { status: 302, contentType: "text/plain", body: "", ...(location !== undefined ? { location } : {}) } }),
    };
    const transport = new SandboxedWebTransport({ lookup: async () => [{ address: publicAddress }], runner });
    expect(await transport.fetchPage({ url: "https://example.com", providerId: "web_fetch" })).toEqual({ ok: false, reason: "invalid redirect destination" });
  }
});

test("a local-search endpoint carrying credentials is denied before the worker runs", async () => {
  let calls = 0;
  const runner: WebWorkerRunner = {
    run: async () => {
      calls += 1;
      return { ok: true, value: { status: 200, contentType: "application/json", body: "{}" } };
    },
  };
  const transport = new SandboxedWebTransport({ runner });
  for (const url of ["http://user:pw@localhost:8080/search", "http://user@127.0.0.1:8080/search", "http://:pw@localhost:8080/search"]) {
    const denied = await transport.request({ providerId: "searxng", capability: "local-search", url, method: "GET" });
    expect(denied.error).toBe("policy-denied");
  }
  expect(calls).toBe(0);
});

// review-performance-w3:F-001: a DNS answer arriving after the deadline must not start a worker.
test("a late DNS answer after the deadline never reaches the runner", async () => {
  const calls: Array<{ aborted: boolean | undefined }> = [];
  const runner: WebWorkerRunner = {
    run: async (_request, signal) => {
      calls.push({ aborted: signal?.aborted });
      return { ok: false, reason: "fake" };
    },
  };
  const slowLookup = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return [{ address: publicAddress }];
  };
  const transport = new SandboxedWebTransport({ lookup: slowLookup, runner, deadlineMs: 30 });
  const result = await transport.fetchPage({ url: "https://example.com/", providerId: "web_fetch" });
  expect(result.ok).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls).toEqual([]);
});
