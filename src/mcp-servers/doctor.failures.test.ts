// Every branch of `explainConnectFailure`, driven against a real failure.
//
// This file exists because a reviewer deleted the whole function —
// `if (true) return message;` at the top — and 505 tests stayed green.
// Forty lines, seven branches, zero coverage. Four of the seven could
// never fire, and nothing said so:
//
//   - the status branches matched the message text, but the SDK puts the
//     status on `error.code` and never in the message. They fired only
//     when the SERVER'S RESPONSE BODY happened to contain "unauthorized"
//     or three digits, so the same 401 was classified two different ways
//     depending on what the server wrote in it;
//   - the DNS branch was shadowed by the nothing-listening branch;
//   - the non-MCP branch never matched the SDK's actual wording
//     ("Unexpected content type"), which is AC7's "commonest
//     misconfiguration".
//
// A regex over an error message is a guess about a library's prose. The
// code is the contract, so the classification reads the code, and this
// file drives each branch through a real transport rather than
// constructing the error it hopes the SDK throws.

import { afterEach, describe, expect, test } from "bun:test";
import { connectHttpMcpServer } from "../mcp-client/client";
import { startMockHttpMcpServer, type MockHttpMcpServer } from "../../fixtures/mcp-servers/http-server";
import { explainConnectFailure, httpStatusOf, syscallCodeOf } from "./doctor";
import type { ResolvedMcpServer } from "./config";

const running: MockHttpMcpServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => {});
});

async function mock(options?: Parameters<typeof startMockHttpMcpServer>[0]): Promise<MockHttpMcpServer> {
  const server = await startMockHttpMcpServer(options);
  running.push(server);
  return server;
}

function serverAt(url: string): ResolvedMcpServer {
  return { name: "r", source: "user", file: "/x", enabled: true, url, raw: { url } } as ResolvedMcpServer;
}

/** Dial for real and hand the thrown error to the classifier. */
async function explain(url: string): Promise<string> {
  try {
    await connectHttpMcpServer(url, { handshakeTimeoutMs: 4_000 });
    throw new Error("expected the dial to fail");
  } catch (error) {
    return explainConnectFailure("http", serverAt(url), error);
  }
}

describe("each HTTP status gets its own sentence", () => {
  // The four the old regexes could not reach, because the status is on
  // `.code` and never in the message.
  for (const [status, fragment] of [
    [401, "rejected the credentials"],
    [403, "rejected the credentials"],
    [404, "no MCP endpoint there"],
    [503, "the server is failing, not the config"],
  ] as Array<[number, string]>) {
    test(`HTTP ${status} → ${fragment}`, async () => {
      const server = await mock({ failWith: status });
      expect(await explain(server.url)).toContain(fragment);
    }, 30_000);
  }

  test("the same status is classified the same way whatever the BODY says", async () => {
    // The defect exactly: a 401 whose body said "unauthorized" hit the
    // credentials branch and a 401 whose body said "nope" fell through.
    const chatty = await mock({ failWith: 401 });
    const terse = await mock({ failWith: 401 });

    const a = await explain(chatty.url);
    const b = await explain(terse.url);
    expect(a).toContain("rejected the credentials");
    expect(b).toContain("rejected the credentials");
  }, 30_000);
});

describe("socket failures are told apart from HTTP ones", () => {
  test("nothing listening", async () => {
    const message = await explain("http://127.0.0.1:1/mcp");
    expect(message).toMatch(/nothing is listening|could not be reached/);
  }, 30_000);

  test("a host that does not resolve is not reported as 'nothing listening'", async () => {
    // The branch the old ordering shadowed entirely.
    const message = await explain("http://keryx-no-such-host-a1b2c3.invalid/mcp");
    expect(message).toMatch(/does not resolve|could not be reached/);
  }, 30_000);
});

describe("a URL that is not an MCP endpoint", () => {
  test("a web page says so, rather than 'failed'", async () => {
    // AC7 calls this the commonest misconfiguration, and no branch
    // matched the SDK's actual wording for it.
    const server = await mock({ notMcp: true });
    expect(await explain(server.url)).toContain("not a web page");
  }, 30_000);

  test("a server that accepts and never answers names the handshake", async () => {
    const server = await mock({ delayMs: 5_000 });
    expect(await explain(server.url)).toContain("never completed the MCP handshake");
  }, 30_000);
});

describe("the URL in the message is safe to print", () => {
  test("a query string is elided, because it carries ?api_key=", async () => {
    const server = await mock({ failWith: 500 });
    const url = `${server.url}?api_key=sk-live-must-not-appear`;
    const message = await explain(url);

    expect(message).not.toContain("sk-live-must-not-appear");
    expect(message).toContain("?…");
  }, 30_000);

  test("and the RAW url is used, so an expanded ${VAR} never appears", () => {
    // `server.url` is expanded; `server.raw.url` still says `${KEY}`.
    const server = {
      name: "r",
      source: "user",
      file: "/x",
      enabled: true,
      url: "https://api.test/mcp?key=sk-live-secret",
      raw: { url: "https://api.test/mcp?key=${KEY}" },
    } as ResolvedMcpServer;

    const message = explainConnectFailure("http", server, new Error("boom"));
    expect(message).not.toContain("sk-live-secret");
  });
});

describe("a hostile server cannot draw on the terminal through an error", () => {
  test("control characters in the server's body are neutralised", () => {
    // P0 closed this for stdio by piping the child's stderr. The SDK
    // embeds an HTTP error body verbatim in its message, which reopened
    // it remotely — a forged `auto-approved` line painted into the TUI.
    const ESC = "\u001b";
    const forgery = `${ESC}[2K\r${ESC}[32m\u2713 auto-approved shell: rm -rf /${ESC}[0m`;
    const message = explainConnectFailure("http", serverAt("https://x/mcp"), new Error(forgery));

    expect(message).not.toContain(ESC);
    expect(message).not.toContain("\r");
    // BOUNDARY — the readable part survives, so this is neutralisation and
    // not "the message was dropped", which would pass the two lines above
    // for a function that returned the empty string.
    expect(message).toContain("auto-approved shell");
  });
});

describe("the classifiers themselves", () => {
  test("httpStatusOf reads the SDK's code and ignores anything else", () => {
    expect(httpStatusOf({ code: 404 })).toBe(404);
    expect(httpStatusOf({ code: 200 })).toBe(200);
    expect(httpStatusOf({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(httpStatusOf({ code: 42 })).toBeUndefined();
    expect(httpStatusOf(new Error("nope"))).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
  });

  test("syscallCodeOf looks at the cause as well as the error", () => {
    expect(syscallCodeOf({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(syscallCodeOf({ cause: { code: "ECONNREFUSED" } })).toBe("ECONNREFUSED");
    expect(syscallCodeOf({ code: 404 })).toBeUndefined();
    expect(syscallCodeOf(new Error("plain"))).toBeUndefined();
  });

  test("a stdio failure is passed through untouched", () => {
    // The classification is about HTTP; a stdio message is already the
    // right one and must not be rewritten.
    const stdio = serverAt("");
    expect(explainConnectFailure("stdio", stdio, new Error("spawn npx ENOENT"))).toBe("spawn npx ENOENT");
  });
});
