// K-005 (arena, flow 249): every OpenAI-compatible registry provider used to be
// built with Ollama's identity, so a grok session reported
// `Ollama API returned HTTP 403` and sent whoever read it to an Ollama endpoint
// that was never involved. The label now comes from the registry; the id stays
// pinned to "ollama" (make-provider.test.ts) until the separate naming fix.
import { expect, test } from "bun:test";
import { providerByName } from "../../commands/providers";
import { makeProvider } from "./make-provider";
import type { NormalizedEvent, NormalizedRequest } from "./types";

const request: NormalizedRequest = {
  providerId: "grok",
  modelId: "grok-4.6",
  systemInstruction: "fixture",
  messages: [{ role: "user", content: "hello" }],
  budget: { maxOutputTokens: 32, runReservation: 32 },
  stream: true,
  requestId: "label-1",
  parentRunId: "label-1",
};

test("a grok provider names grok in its HTTP errors, and keeps its pinned id", async () => {
  const grok = providerByName("grok");
  if (grok?.envKey === undefined) throw new Error("grok registry entry has no envKey");
  const refusing = Object.assign(
    (async () => new Response(JSON.stringify({ error: "balance exhausted" }), { status: 403 })) as unknown as typeof fetch,
    { preconnect: (_input: string | URL) => {} },
  );
  const provider = makeProvider("grok", "grok-4.6", { fetch: refusing, env: { [grok.envKey]: "test-key" } });

  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(request, { attemptId: "label-1" })) events.push(event);

  const message = events.find((event) => event.kind === "provider_error")?.error?.message ?? "";
  expect(message.startsWith(`${grok.label} API returned HTTP 403`)).toBe(true);
  expect(message).toContain("balance exhausted");
  expect(message).not.toContain("Ollama");
  expect(provider.describe().descriptor.providerId).toBe("ollama");
});
