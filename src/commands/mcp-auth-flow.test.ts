// `keryx mcp auth`, driven all the way through against a mock
// authorisation server.
//
// Five mutations inside `runOAuthFlow` survived a sweep, all for one
// reason: no test ever ran it past the headless refusal. Each of the
// five is a lie the command would tell —
//
//   - "already authorised" when the connection FAILED;
//   - success when the operator REFUSED in the browser;
//   - success when the exchange stored NO token;
//   - the provider reading the real credential store, not this one;
//   - a configured clientId silently ignored.
//
// None of them throws. They all print something reassuring and exit
// zero, which is why an exit-code test proves nothing here.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCredential, writeCredential } from "../mcp-servers/credentials";
import { runMcpConsumerCommand } from "./mcp-servers";

type Mock = {
  readonly url: string;
  readonly seen: Array<{ path: string; body: Record<string, string> }>;
  /** Set before the run to make the browser leg refuse. */
  denyAuthorisation: boolean;
  /** Set before the run to return a 200 with no access_token. */
  emptyTokenResponse: boolean;
  /** Return a token response the SDK accepts but that stores nothing. */
  tokenWithoutAccessToken: boolean;
  /** Serve the MCP endpoint successfully instead of demanding OAuth. */
  acceptWithoutAuth: boolean;
  readonly stop: () => void;
};

const running: Mock[] = [];
afterEach(() => {
  for (const m of running.splice(0)) m.stop();
});

/**
 * An authorisation server that also completes the browser leg.
 *
 * `/authorize` is fetched by the fake "browser" the test injects, and
 * it redirects straight back to keryx's loopback listener — so the
 * whole round trip happens without a human or a real browser.
 */
function mockAuthServer(): Mock {
  const seen: Array<{ path: string; body: Record<string, string> }> = [];
  const state = {
    denyAuthorisation: false,
    emptyTokenResponse: false,
    tokenWithoutAccessToken: false,
    acceptWithoutAuth: false,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const raw = request.method === "POST" ? await request.text() : "";
      const body: Record<string, string> = Object.fromEntries(new URLSearchParams(raw));
      if (raw.startsWith("{")) {
        try {
          Object.assign(body, JSON.parse(raw) as Record<string, string>);
        } catch {
          // The path is what these assertions use.
        }
      }
      seen.push({ path: url.pathname, body });

      const base = `http://127.0.0.1:${server.port}`;
      const json = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: base, authorization_servers: [base] });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname.startsWith("/.well-known/openid-configuration")) return json({}, 404);
      if (url.pathname === "/register") {
        return json(
          {
            client_id: "registered-by-keryx",
            client_id_issued_at: 1,
            redirect_uris: (body.redirect_uris as unknown as string[] | undefined) ?? [],
          },
          201,
        );
      }
      if (url.pathname === "/token") {
        if (state.emptyTokenResponse) return json({ token_type: "Bearer", expires_in: 3600 });
        if (state.tokenWithoutAccessToken) {
          // Schema-valid to the SDK, but `access_token` is empty, so
          // nothing lands in the store — the case the guard exists for.
          return json({ access_token: "", token_type: "Bearer", expires_in: 3600 });
        }
        return json({
          access_token: "granted-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "granted-refresh",
        });
      }
      // The MCP endpoint itself: 401 with the pointer that starts the
      // whole flow. Returning 404 here (the first version of this
      // mock) means the SDK never attempts OAuth at all — no browser,
      // no callback, and every test sits waiting out the listener's
      // five-minute budget.
      if (state.acceptWithoutAuth) {
        // A server that simply does not require authentication.
        //
        // This has to complete a real MCP handshake, not merely return
        // 200: the branch under test is reached only when the SDK
        // reports a working connection, so a mock that answers
        // plausibly but never initialises leaves the test waiting on
        // the handshake budget instead of exercising anything.
        let parsed: { method?: string; id?: unknown } = {};
        try {
          parsed = JSON.parse(raw) as { method?: string; id?: unknown };
        } catch {
          // Not JSON-RPC; fall through to the 202 below.
        }
        if (parsed.method === "initialize") {
          return json({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "mock", version: "1.0.0" },
            },
          });
        }
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      });
    },
  });

  const mock: Mock = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    seen,
    get denyAuthorisation(): boolean {
      return state.denyAuthorisation;
    },
    set denyAuthorisation(value: boolean) {
      state.denyAuthorisation = value;
    },
    get emptyTokenResponse(): boolean {
      return state.emptyTokenResponse;
    },
    set emptyTokenResponse(value: boolean) {
      state.emptyTokenResponse = value;
    },
    get tokenWithoutAccessToken(): boolean {
      return state.tokenWithoutAccessToken;
    },
    set tokenWithoutAccessToken(value: boolean) {
      state.tokenWithoutAccessToken = value;
    },
    get acceptWithoutAuth(): boolean {
      return state.acceptWithoutAuth;
    },
    set acceptWithoutAuth(value: boolean) {
      state.acceptWithoutAuth = value;
    },
    stop: () => {
      try {
        server.stop(true);
      } catch {
        // Already stopped.
      }
    },
  };
  running.push(mock);
  return mock;
}

type Run = { code: number; out: string; err: string; configDir: string };

/**
 * Run `keryx mcp auth <name>` with a "browser" that completes the
 * redirect itself.
 */
async function authenticate(
  mock: Mock,
  entry: Record<string, unknown> = {},
  extra: { opened?: URL[]; preStoreToken?: boolean } = {},
): Promise<Run> {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-authflow-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    path.join(configDir, "mcp-servers.json"),
    JSON.stringify({ schemaVersion: 1, servers: { mock: { url: mock.url, ...entry } } }),
  );

  if (extra.preStoreToken === true) {
    writeCredential(
      "mock",
      mock.url,
      { tokens: { access_token: "already-held", expires_at: Date.now() + 600_000 } },
      configDir,
    );
  }

  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpConsumerCommand("auth", ["mock"], {
    cwd: projectRoot,
    configDir,
    projectRoot,
    home: path.join(base, "home"),
    interactive: true,
    // The "browser": it reads where the flow wants to send the
    // operator and drives the redirect back to keryx's listener.
    openBrowser: async (url) => {
      extra.opened?.push(url);
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (redirect === null || state === null) return;
      const back = new URL(redirect);
      if (mock.denyAuthorisation) {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "you said no");
      } else {
        back.searchParams.set("code", "the-authorisation-code");
      }
      back.searchParams.set("state", state);
      await fetch(back.toString()).catch(() => undefined);
    },
    log: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), configDir };
}

describe("the happy path, so the failures below mean something", () => {
  test("it exits zero and stores a token", async () => {
    const mock = mockAuthServer();
    const result = await authenticate(mock);
    expect(result.code).toBe(0);
    expect(readCredential("mock", mock.url, result.configDir).record?.tokens?.access_token).toBe(
      "granted-access-token",
    );
  });

  test("and it stores it in THIS config dir, not the real one", async () => {
    // The `configDir` spread survived inversion. Inverted, the
    // provider reads and writes the operator's actual store while the
    // command reports success against the one it was given.
    const mock = mockAuthServer();
    const result = await authenticate(mock);
    expect(readCredential("mock", mock.url, result.configDir).record?.tokens).toBeDefined();
  });

  test("and says where, without printing the token", async () => {
    const mock = mockAuthServer();
    const result = await authenticate(mock);
    expect(result.out).toContain("mcp-credentials.json");
    expect(`${result.out}\n${result.err}`).not.toContain("granted-access-token");
  });
});

describe("a configured clientId is used instead of registering one", () => {
  test("no registration request is made", async () => {
    const mock = mockAuthServer();
    await authenticate(mock, { oauth: { clientId: "operators-own-client" } });
    expect(mock.seen.filter((s) => s.path === "/register")).toEqual([]);
  });

  test("and it is the id sent to the token endpoint", async () => {
    const mock = mockAuthServer();
    await authenticate(mock, { oauth: { clientId: "operators-own-client" } });
    expect(mock.seen.find((s) => s.path === "/token")?.body.client_id).toBe("operators-own-client");
  });

  test("BOUNDARY — with none configured, one IS registered", async () => {
    const mock = mockAuthServer();
    await authenticate(mock);
    expect(mock.seen.filter((s) => s.path === "/register").length).toBe(1);
  });
});

describe("the failures that would otherwise be reported as success", () => {
  test("the operator refusing in the browser is NOT success", async () => {
    // `if (!result.ok)` inverted: a refusal read as a completed flow.
    const mock = mockAuthServer();
    mock.denyAuthorisation = true;
    const result = await authenticate(mock);
    expect(result.code).toBe(1);
    expect(result.err).toContain("access_denied");
  });

  test("and stores nothing", async () => {
    const mock = mockAuthServer();
    mock.denyAuthorisation = true;
    const result = await authenticate(mock);
    expect(readCredential("mock", mock.url, result.configDir).record?.tokens).toBeUndefined();
  });

  test("an exchange that returns no token is NOT success", async () => {
    // `if (stored?.tokens === undefined)` inverted: the command says
    // "authorised" and the next session fails somewhere unrelated.
    //
    // The exit code alone did NOT pin this: a reviewer replaced the
    // guard with `if (false)` and the test stayed green, because the
    // 1 was coming from the SDK's own schema rejection in the outer
    // catch, not from the guard. Asserting the message is what makes
    // the difference, since only the guard produces this sentence.
    const mock = mockAuthServer();
    mock.tokenWithoutAccessToken = true;
    const result = await authenticate(mock);
    expect(result.code).toBe(1);
    expect(result.err).toContain("returned no token");
  });

  test("a server that needs no authentication is NOT called 'already authorised'", async () => {
    // Renamed, because the old title claimed to cover the
    // already-authorised branch and asserted the opposite case. A
    // reviewer deleted that whole early return and 2192 tests stayed
    // green — the branch was named in a title and pinned by nothing.
    const mock = mockAuthServer();
    mock.acceptWithoutAuth = true;
    const result = await authenticate(mock);
    expect(result.code).toBe(0);
    expect(result.out).toContain("connects without authentication");
    expect(result.out).not.toContain("already authorised");
  });

  test("and a server we DO hold a token for says exactly that, without a browser", async () => {
    // The branch itself, finally driven: a stored credential plus a
    // server that accepts it means there is nothing to do.
    const mock = mockAuthServer();
    mock.acceptWithoutAuth = true;
    const opened: URL[] = [];
    const result = await authenticate(mock, {}, { opened, preStoreToken: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain("already authorised");
    expect(opened).toEqual([]);
  });
});
