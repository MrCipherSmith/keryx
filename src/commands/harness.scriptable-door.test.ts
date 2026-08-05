// Flow 135 — the scriptable door: tools on the non-interactive path, providers
// from the registry, declared model ids. Covers defects D3, D4 and D5 of
// `docs/requirements/keryx-shell-benchmark/run-2026-08-05.md`.
//
// One test per frozen acceptance criterion:
//   AC1 — `keryx harness run` registers the read-only metaproject tools and a
//         non-interactive run executes one end to end; the tool's result is in
//         the printed run output.
//   AC2 — every provider the registry declares is accepted, enumerated from
//         `OPENAI_COMPAT_PROVIDERS` rather than from a literal list here.
//   AC3 — an unknown provider is still refused with the usage message.
//   AC6 — a provider that needs a credential still aborts before any network
//         call when it is absent.
//
// OFFLINE / DETERMINISTIC: every run injects `fetch` (a throwing spy that also
// counts, so "no network" is asserted rather than assumed), a fixed
// `clock`/`idSeq`, an explicit `env`, and — where a tool must actually run — a
// fake `MetaprojectPort`, so nothing reads the graph on disk. No `Date.now()`,
// no `Math.random()`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HarnessCommandDeps } from "./harness";
import { harnessCommand, refuseBaseUrl } from "./harness";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import { OPENAI_COMPAT_PROVIDERS, credentialEnvKeyFor, knownProviderNames } from "./providers";
import type {
  NormalizedEvent,
  NormalizedMessage,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";

/** Records call count and always throws — proves a code path never reaches the network. */
function makeThrowingFetch(): { fetch: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fn = async (): Promise<Response> => {
    calls += 1;
    throw new Error("network must not be reached by this test path");
  };
  return { fetch: fn as unknown as typeof fetch, callCount: () => calls };
}

/** Patches `console.log` to capture every call's stringified arguments. */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

/** Parse the LAST captured console.log line as JSON (the pinned structured-result contract). */
function lastJson(logs: string[]): Record<string, unknown> {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (line === undefined) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not this line; keep scanning backwards.
    }
  }
  throw new Error(`no JSON-parseable console.log line found among: ${JSON.stringify(logs)}`);
}

let counter = 0;
function fixedDeps(overrides?: Partial<HarnessCommandDeps>): HarnessCommandDeps {
  counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    ...overrides,
  };
}

// --- a scripted provider ------------------------------------------------------

/**
 * A provider that replays a fixed normalized event list and records the request
 * it was handed. Not `FakeProvider`: that keys its transcripts by a hash of the
 * request, and this suite needs to READ the request (to see which tools the run
 * loop advertised) rather than reproduce it.
 */
function scriptedProvider(events: NormalizedEvent[]): {
  provider: ProviderPort;
  advertisedToolNames: () => string[];
  /** How many times the loop opened a stream — i.e. how many provider turns. */
  streamCalls: () => number;
  /** Every message list the loop sent, in order. */
  sentMessages: () => NormalizedMessage[][];
} {
  let advertised: string[] = [];
  let calls = 0;
  const messageLists: NormalizedMessage[][] = [];
  const provider: ProviderPort = {
    describe: () => ({
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "scripted", providerRevision: "scripted-1.0.0" },
    }),
    stream: (request, opts: StreamOptions) => {
      calls += 1;
      advertised = (request.tools ?? []).map((tool) => tool.name);
      messageLists.push(request.messages.map((message) => ({ ...message })));
      return (async function* () {
        for (const event of events) {
          yield { ...event, attemptId: opts.attemptId };
        }
      })();
    },
  };
  return {
    provider,
    advertisedToolNames: () => advertised,
    streamCalls: () => calls,
    sentMessages: () => messageLists,
  };
}

/** The event script for "the model calls `graph_affected`, then answers". */
function toolCallScript(toolName: string, input: Record<string, unknown>): NormalizedEvent[] {
  return [
    { kind: "model_start", sequence: 0, attemptId: "" },
    { kind: "tool_call_start", sequence: 1, attemptId: "", toolCallId: "call-1", toolName },
    {
      kind: "tool_call_end",
      sequence: 2,
      attemptId: "",
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify(input),
    },
    { kind: "text_delta", sequence: 3, attemptId: "", text: "answered" },
    { kind: "model_end", sequence: 4, attemptId: "" },
  ];
}

/** A `MetaprojectPort` whose `graphAffected` returns two synthetic dependents. */
function fakeMetaprojectPort(): MetaprojectPort {
  return {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => ({
      target,
      depth: 1,
      affected: [
        { id: "src/a.ts", path: "src/a.ts", hop: 1 },
        { id: "src/b.ts", path: "src/b.ts", hop: 1 },
      ],
    }),
    graphQuery: async ({ query }) =>
      query === "orphans" ? { query, orphans: [] } : { query, cycles: [] },
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path }) => ({ path, content: "", isError: false }),
    describeContext: async () => ({
      root: "/repo",
      graphNodes: 0,
      graphEdges: 0,
      hasWikiIndex: false,
    }),
  };
}

// --- AC1 ----------------------------------------------------------------------

describe("AC1 — `--tools` registers the read-only metaproject tools and executes one", () => {
  test("the model's graph_affected call runs and its result is in the printed output", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { provider, advertisedToolNames } = scriptedProvider(
      toolCallScript("graph_affected", { file: "src/config.ts" }),
    );
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "what breaks if I change config"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider,
          metaprojectPort: fakeMetaprojectPort(),
        }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);

    // Registered: the run loop told the provider which tools exist. Before this
    // flow the registry was empty AND `runOffline` never set
    // `NormalizedRequest.tools`, so a model could not have named a tool even if
    // one had been registered.
    expect(advertisedToolNames()).toContain("graph_affected");
    expect(advertisedToolNames()).toContain("search_code");
    expect(advertisedToolNames()).toContain("memory_search");

    // Executed end to end: the tool result — not just a hash — is in the blob.
    const result = lastJson(logs);
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolName).toBe("graph_affected");
    expect(tools[0]?.status).toBe("succeeded");
    expect(String(tools[0]?.output)).toContain("src/a.ts");
    expect(String(tools[0]?.output)).toContain("src/b.ts");

    // And the run recorded it as evidence, so the completion gate saw it too.
    expect((result.evidence as string[]).length).toBeGreaterThan(1);
  });

  test("an input the tool's schema rejects produces no result and no receipt", async () => {
    // The registration gate is not decorative: a call whose input does not match
    // the registered schema must never reach the operation.
    const { fetch: fetchMock } = makeThrowingFetch();
    const { provider } = scriptedProvider(
      toolCallScript("graph_affected", { wrong_field: "src/config.ts" }),
    );
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "bad input"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider,
          metaprojectPort: fakeMetaprojectPort(),
        }),
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result.tools).toEqual([]);
  });

  test("a tool output the scanner flags is masked, not printed", async () => {
    // The redaction branch on the tool-output path, which is security-relevant
    // and new. `search_code` can return file contents, and a piped structured
    // result is as durable as a session record — so the output goes through the
    // same scan the run loop applies before persistence.
    const secret = "sk-live-000111222333444555666777888999";
    const { fetch: fetchMock } = makeThrowingFetch();
    const { provider } = scriptedProvider(toolCallScript("graph_affected", { file: "src/x.ts" }));
    const { logs, restore } = captureConsoleLog();
    const leakyPort: MetaprojectPort = {
      ...fakeMetaprojectPort(),
      graphAffected: async ({ target }) => ({
        target,
        depth: 1,
        affected: [{ id: secret, path: secret, hop: 1 }],
      }),
    };

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "leak it"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider,
          metaprojectPort: leakyPort,
          scan: (content) =>
            content.includes(secret) ? { hasSecret: true, category: "api-key" } : { hasSecret: false },
        }),
      );
    } finally {
      restore();
    }

    const combined = logs.join("\n");
    expect(combined).not.toContain(secret);
    const tools = lastJson(logs).tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(String(tools[0]?.output)).toContain("[redacted:api-key]");
  });

  test("a scan that cannot complete blocks the output entirely", async () => {
    const { fetch: fetchMock } = makeThrowingFetch();
    const { provider } = scriptedProvider(toolCallScript("graph_affected", { file: "src/x.ts" }));
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "scan fails"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider,
          metaprojectPort: fakeMetaprojectPort(),
          scan: () => ({ hasSecret: false, scanFailed: true }),
        }),
      );
    } finally {
      restore();
    }

    const combined = logs.join("\n");
    // Nothing from the tool's own output survives an incomplete scan.
    expect(combined).not.toContain("src/a.ts");
    const tools = lastJson(logs).tools as Array<Record<string, unknown>>;
    expect(tools[0]?.status).toBe("failed");
    expect(String(tools[0]?.output)).toContain("scan failed");
  });
});

describe("item 5 — tool registration is opt-in, and OFF is the previous behaviour", () => {
  test("without --tools nothing is registered and nothing is advertised", async () => {
    // The loop is single-turn: a model told about twelve tools it will never
    // hear back from stops on a tool call and answers less well than one told
    // about none. Until the loop takes a second turn, the default must be the
    // run that existed before this flow.
    const { fetch: fetchMock } = makeThrowingFetch();
    const { provider, advertisedToolNames } = scriptedProvider([
      { kind: "model_start", sequence: 0, attemptId: "" },
      { kind: "text_delta", sequence: 1, attemptId: "", text: "answered without tools" },
      { kind: "model_end", sequence: 2, attemptId: "" },
    ]);
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "no tools please"],
        fixedDeps({ fetch: fetchMock, env: {}, provider }),
      );
    } finally {
      restore();
    }

    expect(advertisedToolNames()).toEqual([]);
    const result = lastJson(logs);
    expect(result.tools).toEqual([]);
    expect(result.text).toBe("answered without tools");
  });

  test("without --tools a tool call the model makes anyway executes nothing", async () => {
    const { fetch: fetchMock } = makeThrowingFetch();
    const { provider } = scriptedProvider(toolCallScript("graph_affected", { file: "src/x.ts" }));
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "sneaky"],
        fixedDeps({ fetch: fetchMock, env: {}, provider, metaprojectPort: fakeMetaprojectPort() }),
      );
    } finally {
      restore();
    }

    const result = lastJson(logs);
    expect(result.tools).toEqual([]);
    expect(logs.join("\n")).not.toContain("src/a.ts");
  });

  test("the usage line advertises the flag", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["run"], fixedDeps({ env: {} }));
    } finally {
      restore();
    }
    expect(logs.join("\n")).toContain("--tools");
  });
});

describe("destination guard — --base-url cannot redirect a run or its credential", () => {
  test("ollama with a public --base-url is refused before any network call", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "ollama", "--model", "llama3.2", "--base-url", "https://any-public-host/", "hi"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("not loopback");
    expect(combined).toContain("no network was contacted");
    expect(/"events"\s*:/.test(combined)).toBe(false);
  });

  for (const url of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
    test(`ollama with the loopback base URL ${url} is accepted`, async () => {
      const { fetch: fetchMock } = makeThrowingFetch();
      const { provider } = scriptedProvider([
        { kind: "model_start", sequence: 0, attemptId: "" },
        { kind: "text_delta", sequence: 1, attemptId: "", text: "local" },
        { kind: "model_end", sequence: 2, attemptId: "" },
      ]);
      const { logs, restore } = captureConsoleLog();

      try {
        await harnessCommand(
          ["run", "--provider", "ollama", "--model", "llama3.2", "--base-url", url, "hi"],
          fixedDeps({ fetch: fetchMock, env: {}, provider }),
        );
      } finally {
        restore();
      }

      // Reached the run loop rather than a refusal line.
      expect(lastJson(logs).text).toBe("local");
    });
  }

  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    test(`${provider.name} refuses --base-url rather than sending ${provider.envKey} elsewhere`, async () => {
      const { fetch: fetchMock, callCount } = makeThrowingFetch();
      const { logs, restore } = captureConsoleLog();

      try {
        await harnessCommand(
          [
            "run",
            "--provider",
            provider.name,
            "--model",
            provider.models[0] ?? "m",
            "--base-url",
            "https://attacker.tld",
            "hi",
          ],
          // The key IS present: this must be refused on the destination, not
          // incidentally saved by a missing credential.
          fixedDeps({ fetch: fetchMock, env: { [provider.envKey]: "sk-real-key" } }),
        );
      } finally {
        restore();
      }

      expect(callCount()).toBe(0);
      const combined = logs.join("\n");
      expect(combined).toContain("--base-url is not accepted");
      expect(combined).toContain(provider.envKey);
      expect(combined).not.toContain("sk-real-key");
      expect(/"events"\s*:/.test(combined)).toBe(false);
    });
  }

  test("anthropic refuses --base-url too", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "anthropic", "--model", "m", "--base-url", "https://attacker.tld", "hi"],
        fixedDeps({ fetch: fetchMock, env: { ANTHROPIC_API_KEY: "sk-real-key" } }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    expect(logs.join("\n")).toContain("--base-url is not accepted");
    expect(logs.join("\n")).not.toContain("sk-real-key");
  });

  test("a --base-url that is not a URL is refused rather than passed through", () => {
    expect(refuseBaseUrl("ollama", "not a url")).toContain("is not a URL");
    expect(refuseBaseUrl("ollama", "http://127.0.0.1:11434")).toBeUndefined();
    expect(refuseBaseUrl("ollama", "http://169.254.169.254/")).toContain("not loopback");
    expect(refuseBaseUrl("ollama", "http://10.0.0.5/")).toContain("not loopback");
  });

  test("only http and https are accepted, not every scheme with a loopback host", () => {
    // A loopback HOST is not an HTTP destination. `file:`, `ftp:` and friends
    // all parse, and `ftp://127.0.0.1/` passed the host check before this.
    expect(refuseBaseUrl("ollama", "https://127.0.0.1:11434")).toBeUndefined();
    for (const url of [
      "ftp://127.0.0.1/",
      "file://localhost/etc/passwd",
      "gopher://127.0.0.1/",
      "ws://127.0.0.1/",
    ]) {
      const refusal = refuseBaseUrl("ollama", url);
      expect(refusal).toBeDefined();
      expect(refusal).toContain("only http and https are accepted");
    }
  });
});

// --- AC2 ----------------------------------------------------------------------

describe("AC2 — every provider the registry declares is accepted", () => {
  // Enumerated FROM the registry. A literal list here would be a fourth copy of
  // the set, and copies disagreeing is the defect (D4).
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    test(`--provider ${provider.name} is not refused with the usage message`, async () => {
      const { fetch: fetchMock, callCount } = makeThrowingFetch();
      const { logs, restore } = captureConsoleLog();

      try {
        await harnessCommand(
          ["run", "--provider", provider.name, "--model", provider.models[0] ?? "m", "hello"],
          // No credential in `env`: the run stops at the fail-closed abort, which
          // is downstream of provider validation. Reaching it IS acceptance.
          fixedDeps({ fetch: fetchMock, env: {} }),
        );
      } finally {
        restore();
      }

      const combined = logs.join("\n");
      expect(combined).not.toContain("Usage: keryx harness run");
      expect(combined).toContain(provider.envKey);
      expect(callCount()).toBe(0);
    });
  }

  test("the usage line lists every accepted provider, so the help matches the check", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["run"], fixedDeps({ env: {} }));
    } finally {
      restore();
    }
    const combined = logs.join("\n");
    for (const name of knownProviderNames()) {
      expect(combined).toContain(name);
    }
  });
});

// --- AC3 ----------------------------------------------------------------------

describe("AC3 — an unknown provider is still refused", () => {
  test("--provider nope prints the usage message and never runs the loop", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "nope", "--model", "whatever", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });
});

// --- AC6 ----------------------------------------------------------------------

describe("AC6 — the fail-closed credential behaviour is unchanged, and now covers every accepted provider", () => {
  test("anthropic without ANTHROPIC_API_KEY aborts before any network call", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "anthropic", "--model", "claude-haiku-4-5-20251001", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("ANTHROPIC_API_KEY");
    expect(combined).toContain("no network was contacted");
    // Never a structured run result: the abort is BEFORE the loop, not inside it.
    expect(/"events"\s*:/.test(combined)).toBe(false);
  });

  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    test(`${provider.name} without ${provider.envKey} aborts before any network call`, async () => {
      const { fetch: fetchMock, callCount } = makeThrowingFetch();
      const { logs, restore } = captureConsoleLog();

      try {
        await harnessCommand(
          ["run", "--provider", provider.name, "--model", provider.models[0] ?? "m", "hello"],
          fixedDeps({ fetch: fetchMock, env: {} }),
        );
      } finally {
        restore();
      }

      expect(callCount()).toBe(0);
      const combined = logs.join("\n");
      expect(combined).toContain(provider.envKey);
      expect(combined).toContain("no network was contacted");
      expect(/"events"\s*:/.test(combined)).toBe(false);
    });
  }

  test("widening the accepted set did not widen the credential-free set", () => {
    // The only providers allowed to run without a credential are the offline
    // fixture provider and the local loopback one. If a hosted gateway ever
    // appears here, a `harness run` naming it would reach the network with no key.
    const credentialFree = knownProviderNames().filter(
      (name) => credentialEnvKeyFor(name) === undefined,
    );
    expect(credentialFree).toEqual(["fake", "ollama"]);
  });

  test("a present credential gets past the abort and into the run loop", () => {
    // The complement of the criterion: the abort must be about the credential
    // being ABSENT, not about the provider being a gateway. Asserted on the
    // lookup rather than by running, because running it with a key set is a
    // network call by construction.
    expect(credentialEnvKeyFor("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(credentialEnvKeyFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(credentialEnvKeyFor("fake")).toBeUndefined();
  });
});

// --- AC4 keeps holding: the reference cannot silently drift from the code -----

describe("AC4 — the CLI reference is checked against the code it describes", () => {
  const reference = readFileSync(
    path.join(import.meta.dir, "..", "..", "docs", "docs", "cli-reference.md"),
    "utf8",
  );

  test("every operation the registry projects is named in the documented tool list", () => {
    // The list was hand-written once and a hand-written list of twelve names is
    // a list that goes stale on the thirteenth. Adding an operation now fails
    // here until the reference names it.
    for (const operation of METAPROJECT_OPERATIONS) {
      expect(reference).toContain(`\`${operation.name}\``);
    }
  });

  test("the documented tool list is exactly the projected operation set", () => {
    // Extracted from the one sentence that enumerates them, so the assertion is
    // set equality rather than "contains" in both directions: a tool removed
    // from the registry but left in the reference fails here too.
    const start = reference.indexOf("registers the read-only metaproject tools — ");
    expect(start).toBeGreaterThan(-1);
    const listText = reference.slice(start, reference.indexOf(" — and advertises them", start));
    const documented = [...listText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
    expect([...documented].sort()).toEqual(METAPROJECT_OPERATIONS.map((o) => o.name).sort());
  });

  test("every provider the registry declares is named in the reference", () => {
    for (const provider of OPENAI_COMPAT_PROVIDERS) {
      expect(reference).toContain(`\`${provider.name}\``);
    }
  });

  test("the reference states the single-turn limit somewhere", () => {
    // A weak assertion, and labelled as one: it pins that the sentence exists,
    // not that it is true. The test below is the one that pins the behaviour.
    expect(reference).toContain("**Tool results are not returned to the model.**");
    expect(reference).not.toContain("reaches the same project knowledge the TUI does");
  });
});

describe("the single-turn limit is pinned to the loop, not to the prose", () => {
  // Why this exists: the doc assertions above grep for a sentence, and a
  // reviewer mutated the sentence NEXT to it to say the opposite and got a
  // fully green suite. A prose grep pins prose. These pin the loop, so the
  // documented claim cannot quietly stop being true — whatever the page says.

  test("a tool-calling run opens exactly ONE provider stream", async () => {
    const { fetch: fetchMock } = makeThrowingFetch();
    const script = scriptedProvider(toolCallScript("graph_affected", { file: "src/config.ts" }));
    const { restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "one turn only"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider: script.provider,
          metaprojectPort: fakeMetaprojectPort(),
        }),
      );
    } finally {
      restore();
    }

    // The model called a tool and the tool ran. An agent loop would now send a
    // second request carrying the result. This loop does not, and the reference
    // says so; if that ever changes, this fails and the docs get revisited.
    expect(script.streamCalls()).toBe(1);
  });

  test("no tool result is ever appended to the messages the provider receives", async () => {
    const { fetch: fetchMock } = makeThrowingFetch();
    const script = scriptedProvider(toolCallScript("graph_affected", { file: "src/config.ts" }));
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "--tools", "one turn only"],
        fixedDeps({
          fetch: fetchMock,
          env: {},
          provider: script.provider,
          metaprojectPort: fakeMetaprojectPort(),
        }),
      );
    } finally {
      restore();
    }

    // The tool really did run — otherwise this test would pass vacuously.
    const tools = lastJson(logs).tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(String(tools[0]?.output)).toContain("src/a.ts");

    // And none of what it produced reached the conversation.
    const sent = script.sentMessages();
    expect(sent).toHaveLength(1);
    for (const messages of sent) {
      expect(messages.some((message) => message.role === "tool")).toBe(false);
      expect(messages.some((message) => message.content.includes("src/a.ts"))).toBe(false);
    }
  });
});
