// Why an empty model list is empty.
//
// `fetchOpenAiCompatModelsDetailed` stopped substituting curated ids for a
// failed probe (commit d0d86c76), which was right — a documentary id is not a
// model you can call. But it dropped the ANSWER along with the ids: every
// failure became `{ models: [] }`, and the picker said "(no models found)"
// whether the provider had nothing to offer, refused the credential, or was
// never reached.
//
// On a machine holding an expired grok login that read as a broken picker.
// `/provider` → grok → no prompt (a value WAS in env, just a dead one) → an
// empty list, and no way to learn that `api.x.ai` had answered "403 The OAuth2
// access token could not be validated".
//
// These tests pin the reason, not just the emptiness.

import { describe, expect, test } from "bun:test";
import type { ModelsFailure, OpenAiCompatProvider } from "./providers";
import {
  fetchOpenAiCompatModelsDetailed,
  modelsErrorDetail,
  modelsFailureLine,
  resolveModelsForPicker,
} from "./providers";

const PROVIDER: OpenAiCompatProvider = {
  name: "example",
  label: "Example",
  baseUrl: "https://api.example.invalid",
  envKey: "EXAMPLE_API_KEY",
  models: ["curated-1", "curated-2"],
};

/** A fetch that answers once with the given status and body. */
function answering(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("a failed /models probe reports WHY, and still offers no curated ids", () => {
  type Row = {
    readonly label: string;
    readonly status: number;
    readonly body: string;
    readonly expected: ModelsFailure;
  };

  const ROWS: Row[] = [
    {
      // The exact body api.x.ai returns for an expired device-code grant.
      label: "403 from xAI with an expired OAuth grant",
      status: 403,
      body: '{"code":"unauthenticated:bad-credentials","error":"The OAuth2 access token could not be validated."}',
      expected: { kind: "rejected", status: 403, detail: "The OAuth2 access token could not be validated." },
    },
    {
      label: "401 in the OpenAI error shape",
      status: 401,
      body: '{"error":{"message":"Incorrect API key provided","type":"incorrect_api_key_error"}}',
      expected: { kind: "rejected", status: 401, detail: "Incorrect API key provided" },
    },
    {
      label: "403 in the Cerebras `detail` shape",
      status: 403,
      body: '{"detail":"Not authenticated"}',
      expected: { kind: "rejected", status: 403, detail: "Not authenticated" },
    },
    {
      // Not a credential problem: the operator must not be sent to re-enter a key.
      label: "404 is an endpoint problem, not a credential one",
      status: 404,
      body: "404 page not found",
      expected: { kind: "http", status: 404, detail: "404 page not found" },
    },
    {
      label: "500 with an HTML error page keeps the status and drops the markup",
      status: 500,
      body: "<html><body><h1>502 Bad Gateway</h1></body></html>",
      expected: { kind: "http", status: 500 },
    },
  ];

  for (const row of ROWS) {
    test(row.label, async () => {
      const result = await fetchOpenAiCompatModelsDetailed(answering(row.status, row.body), PROVIDER, "key");
      // The curated ids stay out of the picker — that part of d0d86c76 stands.
      expect(result.models).toEqual([]);
      expect(result.source).toBe("fallback");
      expect(result.failure).toEqual(row.expected);
    });
  }

  test("a 2xx with an empty data array is `empty`, not a failure to reach anybody", async () => {
    const result = await fetchOpenAiCompatModelsDetailed(answering(200, '{"data":[]}'), PROVIDER, "key");
    expect(result.failure).toEqual({ kind: "empty" });
  });

  test("a network fault is `unreachable` and carries the message", async () => {
    const broken = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.invalid");
    }) as unknown as typeof fetch;
    const result = await fetchOpenAiCompatModelsDetailed(broken, PROVIDER, "key");
    expect(result.failure).toEqual({ kind: "unreachable", detail: "getaddrinfo ENOTFOUND api.example.invalid" });
  });

  test("a timeout says it timed out rather than blaming the network", async () => {
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as typeof fetch;
    const result = await fetchOpenAiCompatModelsDetailed(hangs, PROVIDER, "key", { timeoutMs: 20 });
    expect(result.failure).toEqual({ kind: "unreachable", detail: "timed out after 20ms" });
  });

  test("BOUNDARY — a live list carries no failure at all", async () => {
    const result = await fetchOpenAiCompatModelsDetailed(answering(200, '{"data":[{"id":"m-1"}]}'), PROVIDER, "key");
    expect(result.models).toEqual(["m-1"]);
    expect(result.source).toBe("live");
    expect(result.failure).toBeUndefined();
  });

  test("resolveModelsForPicker carries the reason out to the picker", async () => {
    const result = await resolveModelsForPicker(
      answering(403, '{"error":"The OAuth2 access token could not be validated."}'),
      { name: "grok", models: ["grok-2-latest"], envKey: "XAI_API_KEY" },
      { XAI_API_KEY: "stale" },
    );
    expect(result.models).toEqual([]);
    expect(result.failure?.kind).toBe("rejected");
  });

  test("a non-registry provider keeps its detected models and reports no failure", async () => {
    const never = (() => {
      throw new Error("must not probe");
    }) as unknown as typeof fetch;
    const result = await resolveModelsForPicker(never, { name: "ollama", models: ["llama3"] }, {});
    expect(result.models).toEqual(["llama3"]);
    expect(result.failure).toBeUndefined();
  });
});

describe("modelsErrorDetail reads the sentence out of each gateway's dialect", () => {
  const CASES: ReadonlyArray<readonly [string, string | undefined]> = [
    ['{"error":"plain string"}', "plain string"],
    ['{"error":{"message":"nested message"}}', "nested message"],
    ['{"detail":"detail field"}', "detail field"],
    ['{"message":"message field"}', "message field"],
    ["not json but one line", "not json but one line"],
    ["<html><body>nope</body></html>", undefined],
    ["   ", undefined],
    ["", undefined],
    ['{"unrelated":1}', undefined],
  ];

  for (const [body, expected] of CASES) {
    test(`${JSON.stringify(body).slice(0, 40)} → ${String(expected)}`, () => {
      expect(modelsErrorDetail(body)).toBe(expected as string | undefined);
    });
  }

  test("an enormous body is read only up to the cap", () => {
    // A gateway that answers with a megabyte of HTML must not be parsed whole
    // just to produce a line nobody will read.
    const huge = `${"x".repeat(10_000)}\nsecond line`;
    const detail = modelsErrorDetail(huge);
    expect(detail).toBeDefined();
    expect((detail ?? "").length).toBeLessThanOrEqual(4_096);
  });
});

describe("modelsFailureLine says which of the four things went wrong", () => {
  test("a rejected credential names the status and the provider's own words", () => {
    expect(
      modelsFailureLine("xAI (Grok)", {
        kind: "rejected",
        status: 403,
        detail: "The OAuth2 access token could not be validated.",
      }),
    ).toBe("xAI (Grok) rejected the credential (HTTP 403) — The OAuth2 access token could not be validated.");
  });

  test("an unexplained failure still names the status", () => {
    expect(modelsFailureLine("Example", { kind: "http", status: 500 })).toBe(
      "Example could not list models (HTTP 500)",
    );
  });

  test("unreachable does not mention credentials", () => {
    const line = modelsFailureLine("Example", { kind: "unreachable", detail: "timed out after 10000ms" });
    expect(line).toBe("Example could not be reached — timed out after 10000ms");
    expect(line).not.toContain("credential");
  });

  test("an honestly empty catalogue is not phrased as an error", () => {
    const line = modelsFailureLine("Example", { kind: "empty" });
    expect(line).toBe("Example reports no models");
    expect(line).not.toContain("HTTP");
  });
});
