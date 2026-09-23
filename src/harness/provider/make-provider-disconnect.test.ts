// flow 304 review finding #7: AC7 ("disconnecting the provider the session
// is using neither switches provider nor interrupts a turn — the session
// keeps its already-loaded credential") was only proven by a source-text
// audit (`src/tui/connect-provider-buttons.test.ts`'s AC7 describe block,
// which pins that the `/connect` command handler prints the right system
// line — it cannot observe what the ALREADY-BUILT provider object actually
// sends on the wire). This file drives the real, behavioral path: build a
// provider via `makeProvider` from a temp env/config dir, disconnect it
// (which deletes the credential from disk AND from `process.env`), then send
// one more request through the SAME already-built provider object with an
// injected fetch that records the outgoing Authorization header. The
// original credential must still be the one sent — `makeProvider` bakes the
// key into the constructed provider's `grant` at construction time; it never
// re-reads `env`/`process.env` on a later request.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disconnectProvider } from "../../commands/providers";
import { applySavedApiKeys, saveApiKey } from "../../lib/shell-config";
import type { NormalizedRequest, StreamOptions } from "./types";
import { makeProvider } from "./make-provider";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-make-provider-disconnect-"));
}

function buildRequest(): NormalizedRequest {
  return {
    providerId: "deepseek",
    modelId: "deepseek-chat",
    systemInstruction: "",
    messages: [{ role: "user", content: "ping" }],
    budget: { maxOutputTokens: 64, runReservation: 64 },
    stream: true,
    requestId: "make-provider-disconnect-ac7",
    parentRunId: "make-provider-disconnect-ac7",
  };
}

/** Records every request's `Authorization` header and answers a minimal, valid SSE reply. */
function makeRecordingSseFetch(): { fetch: typeof fetch; authorizationHeaders: (string | undefined)[] } {
  const authorizationHeaders: (string | undefined)[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    authorizationHeaders.push(headers?.authorization);
    const body =
      'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetch: fetchMock, authorizationHeaders };
}

test("AC7 behavioral: a provider already built with a credential keeps using it after that credential is disconnected", async () => {
  const configDir = tempDir();
  const savedEnv = { ...process.env };
  try {
    saveApiKey("DEEPSEEK_API_KEY", "sk-original-secret", configDir);
    delete process.env.DEEPSEEK_API_KEY;
    applySavedApiKeys(configDir); // loads it into process.env AND marks it keryx-saved

    const { fetch: fetchMock, authorizationHeaders } = makeRecordingSseFetch();
    // Built WHILE the credential is present — `makeProvider` reads `env` (here,
    // the live `process.env`) exactly once, at construction, and bakes the
    // resolved key into the returned provider's own `grant`.
    const provider = makeProvider("deepseek", "deepseek-chat", { fetch: fetchMock, env: process.env });

    // Disconnect: removes `apiKeys.DEEPSEEK_API_KEY` from auth.json AND
    // deletes `process.env.DEEPSEEK_API_KEY` for this process (flow 304 review
    // finding #1's fix applies here too, via the SAME `savedCredentialEnvKeys()`
    // gate saved-api-key disconnects already used).
    const result = disconnectProvider("deepseek", process.env, configDir);
    expect(result.ok).toBe(true);
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();

    // One MORE request through the SAME, already-built provider object.
    const request = buildRequest();
    const opts: StreamOptions = { attemptId: "ac7-after-disconnect" };
    const events = [];
    for await (const event of provider.stream(request, opts)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.kind).toBe("model_end");
    expect(authorizationHeaders).toHaveLength(1);
    // The ORIGINAL key, not "undefined" and not a fresh (nonexistent) re-read —
    // the session keeps its already-loaded credential, exactly as AC7 promises.
    expect(authorizationHeaders[0]).toBe("Bearer sk-original-secret");
  } finally {
    process.env = savedEnv;
    rmSync(configDir, { recursive: true, force: true });
  }
});
