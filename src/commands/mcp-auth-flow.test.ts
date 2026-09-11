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
import { readCredential } from "../mcp-servers/credentials";
import { runMcpConsumerCommand } from "./mcp-servers";

type Mock = {
  readonly url: string;
  readonly seen: Array<{ path: string; body: Record<string, string> }>;
  /** Set before the run to make the browser leg refuse. */
  denyAuthorisation: boolean;
  /** Set before the run to return a 200 with no access_token. */
  emptyTokenResponse: boolean;
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
  const state = { denyAuthorisation: false, emptyTokenResponse: false };

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
    const mock = mockAuthServer();
    mock.emptyTokenResponse = true;
    const result = await authenticate(mock);
    expect(result.code).toBe(1);
  });

  test("a server that is already authorised says so without a browser", async () => {
    // `if (connection !== undefined)` inverted claims "already
    // authorised" on the path where the connection FAILED — which is
    // every unauthenticated server, i.e. always.
    const mock = mockAuthServer();
    const first = await authenticate(mock);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain("already authorised");
  });
});
