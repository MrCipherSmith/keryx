import { expect, test } from "bun:test";
import { fetchBoundedAnalysis } from "./native-analysis-transport";

test("analysis transport refuses redirects and strips reflected service error bodies", async () => {
  let redirect: RequestRedirect | undefined;
  const fetchFn: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => { redirect = init?.redirect; return new Response("private-service-key", { status: 403 }); }, { preconnect() {} });
  const response = await fetchBoundedAnalysis(fetchFn, "https://openrouter.ai/api/v1/systemone", { body: "{}" }, new AbortController().signal);
  expect(redirect).toBe("error"); expect(await response.text()).toBe('{"error":"analysis-service-rejected"}');
  const redirected: typeof fetch = Object.assign(async () => new Response(null, { status: 302, headers: { location: "https://unapproved.invalid" } }), { preconnect() {} });
  await expect(fetchBoundedAnalysis(redirected, "https://openrouter.ai/api/v1/systemone", {}, new AbortController().signal)).rejects.toThrow("analysis-redirect-refused");
});

test("analysis response streaming stops at quota and abort reaches a stalled response reader", async () => {
  let cancelled = false;
  const oversized: typeof fetch = Object.assign(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } })), { preconnect() {} });
  await expect(fetchBoundedAnalysis(oversized, "https://openrouter.ai/api/v1/systemone", {}, new AbortController().signal, 4096)).rejects.toThrow("analysis-response-quota-exceeded");
  expect(cancelled).toBe(true);
  const abort = new AbortController();
  const stalled: typeof fetch = Object.assign(async () => new Response(new ReadableStream({ start() { queueMicrotask(() => abort.abort(new Error("stop-analysis"))); } })), { preconnect() {} });
  await expect(fetchBoundedAnalysis(stalled, "https://openrouter.ai/api/v1/systemone", {}, abort.signal)).rejects.toThrow("stop-analysis");
});
