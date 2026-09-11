// How a SESSION uses a stored credential — the path nothing tested.
//
// Three decisions inside `connectRemote` survived mutation because
// `connectRemote` is not exported and nothing could reach them. Two of
// the three fail silently, which is the worst way for a credential
// path to fail: a dropped `configDir` reads the wrong store, a dropped
// `clientId` registers a client the operator already has, and a
// dropped `authProvider` disables OAuth for every session without a
// word — `keryx mcp auth` would report success and the shell would
// still connect as nobody.
//
// So this asserts two different things at two different levels: what
// the decision RETURNS (cheap, exhaustive), and that a stored token
// actually arrives on the wire (one test, end to end, against a real
// socket — because that is the claim that matters).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCredential } from "./credentials";
import { defaultConnect, sessionAuthProviderOptions } from "./runtime";
import type { ResolvedMcpServer } from "./config";

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-session-oauth-"));
}

function server(raw: Record<string, unknown>, name = "linear"): ResolvedMcpServer {
  return {
    name,
    source: "user",
    file: "/config/mcp-servers.json",
    enabled: true,
    url: typeof raw.url === "string" ? raw.url : undefined,
    oauth: raw.oauth,
    raw,
  } as unknown as ResolvedMcpServer;
}

const URL_ = "https://mcp.linear.app/mcp";

describe("what a session decides about OAuth", () => {
  test("a server with no other credential gets a provider", () => {
    expect(sessionAuthProviderOptions(server({ url: URL_ }))).toBeDefined();
  });

  test("and it is NEVER interactive", () => {
    // A session opening must not launch a browser. This is the single
    // most important field on the object.
    expect(sessionAuthProviderOptions(server({ url: URL_ }))?.interactive).toBe(false);
  });

  test("the configDir is PASSED THROUGH, not defaulted", () => {
    // Dropping it silently reads the real credential store instead of
    // the configured one — which in a test means the developer's own
    // tokens, and in production means the wrong profile.
    const dir = store();
    expect(sessionAuthProviderOptions(server({ url: URL_ }), dir)?.configDir).toBe(dir);
  });

  test("and omitted entirely when there is none, rather than set to undefined", () => {
    expect("configDir" in (sessionAuthProviderOptions(server({ url: URL_ })) ?? {})).toBe(false);
  });

  test("a configured clientId reaches the provider", () => {
    // Dropping it makes keryx register a second client against the
    // operator's authorisation server, silently.
    const options = sessionAuthProviderOptions(server({ url: URL_, oauth: { clientId: "mine" } }));
    expect(options?.clientId).toBe("mine");
  });

  test("BOUNDARY — with no clientId configured, the key is absent", () => {
    expect("clientId" in (sessionAuthProviderOptions(server({ url: URL_, oauth: {} })) ?? {})).toBe(false);
  });

  test("BOUNDARY — `oauth: false` yields no provider at all", () => {
    expect(sessionAuthProviderOptions(server({ url: URL_, oauth: false }))).toBeUndefined();
  });

  test("BOUNDARY — nor does a server with a bearer variable", () => {
    expect(
      sessionAuthProviderOptions(server({ url: URL_, bearer_token_env_var: "T" })),
    ).toBeUndefined();
  });

  test("BOUNDARY — nor one with a declared Authorization header", () => {
    expect(
      sessionAuthProviderOptions(server({ url: URL_, headers: { Authorization: "Bearer x" } })),
    ).toBeUndefined();
  });

  test("the server name and url are the ones the credential is keyed by", () => {
    const options = sessionAuthProviderOptions(server({ url: URL_ }, "linear"));
    expect([options?.serverName, options?.serverUrl]).toEqual(["linear", URL_]);
  });
});

// ---------------------------------------------------------------------
// End to end: does the token actually arrive?

const servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

/** A server that records what it was sent and then refuses politely. */
function recordingServer(): { url: string; authorization: string[]; stop: () => void } {
  const authorization: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      authorization.push(request.headers.get("authorization") ?? "(none)");
      // Not a valid MCP handshake — the connection will fail, and that
      // is fine. The claim under test is what was on the request.
      return new Response(JSON.stringify({ error: "no" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const handle = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authorization,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        // Already stopped.
      }
    },
  };
  servers.push(handle);
  return handle;
}

describe("a stored token reaches the wire", () => {
  test("the session sends it as a Bearer credential", async () => {
    // The one test that proves the whole chain: credential store ->
    // provider -> transport -> socket. Every link in it had a mutation
    // survive, and each of those mutations breaks this silently.
    const dir = store();
    const target = recordingServer();
    writeCredential(
      "linear",
      target.url,
      { tokens: { access_token: "the-session-token", token_type: "Bearer" } },
      dir,
    );

    await defaultConnect(server({ url: target.url }), {}, undefined, undefined, dir).catch(
      () => undefined,
    );

    expect(target.authorization.join("|")).toContain("the-session-token");
  });

  test("BOUNDARY — with no stored credential, nothing is sent", async () => {
    // Without this, a transport that attached a hard-coded header
    // would pass the test above.
    const target = recordingServer();
    await defaultConnect(server({ url: target.url }), {}, undefined, undefined, store()).catch(
      () => undefined,
    );
    expect(target.authorization.join("|")).not.toContain("Bearer ");
  });

  test("BOUNDARY — a credential stored under a DIFFERENT url is not sent", async () => {
    // The keying rule, observed at the only place it protects anything.
    const dir = store();
    const target = recordingServer();
    writeCredential("linear", "https://somewhere.else/mcp", { tokens: { access_token: "other" } }, dir);
    await defaultConnect(server({ url: target.url }), {}, undefined, undefined, dir).catch(
      () => undefined,
    );
    expect(target.authorization.join("|")).not.toContain("other");
  });
});
