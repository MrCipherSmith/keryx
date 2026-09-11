// AC11 and AC12, against a MOCK AUTHORISATION SERVER that records
// what it received.
//
// The provider-level tests assert what `clientInformation()` returns.
// That is the mechanism, not the property: the criterion is that NO
// REGISTRATION REQUEST IS MADE, and only the server can say whether
// one arrived. Between the two sits the SDK, which decides — on rules
// this repository does not own — whether to register. So the real
// `auth()` runs against a real socket here, and the assertions are
// made on the request log.
//
// Everything is loopback and ephemeral; nothing reaches the network.
//
// Two things the mock taught us that reading the SDK had not. It
// refuses to register DURING a code exchange — "Existing OAuth client
// information is required" — so registration belongs to the redirect
// leg, and a test that calls `auth()` once with a code is testing a
// sequence the real flow never performs. And `auth()` attempts a
// refresh whenever a refresh token exists, without consulting expiry
// itself; expiry is our `tokens()`'s question, not its.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCredential, writeCredential } from "./credentials";
import { createOAuthProvider } from "./oauth-provider";
import { needsAuthorisation } from "./doctor";

type Recorded = { readonly path: string; readonly body: Record<string, string> };

type MockAs = {
  readonly url: string;
  readonly seen: Recorded[];
  readonly stop: () => void;
  /** Make the next token request fail the way a revoked grant does. */
  rejectNextTokenRequest: boolean;
};

const running: MockAs[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.stop();
});

function mockAuthorisationServer(): MockAs {
  const seen: Recorded[] = [];
  const state = { rejectNextTokenRequest: false };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const raw = request.method === "POST" ? await request.text() : "";
      const body: Record<string, string> = Object.fromEntries(new URLSearchParams(raw));
      // A registration request is JSON, not form-encoded.
      if (raw.startsWith("{")) {
        try {
          Object.assign(body, JSON.parse(raw) as Record<string, string>);
        } catch {
          // Recorded as-is; the test asserts on the path anyway.
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
      if (url.pathname.startsWith("/.well-known/openid-configuration")) {
        return json({ error: "not_found" }, 404);
      }
      if (url.pathname === "/register") {
        // `redirect_uris` is echoed back because the SDK VALIDATES the
        // registration response and rejects one without it. A real
        // authorisation server does this; the first version of this
        // mock did not, and the resulting failure looked exactly like
        // a bug in the provider.
        return json(
          {
            client_id: "dynamically-registered",
            client_id_issued_at: 1,
            redirect_uris: (body.redirect_uris as unknown as string[] | undefined) ?? [
              "http://127.0.0.1:9999/callback",
            ],
          },
          201,
        );
      }
      if (url.pathname === "/token") {
        if (state.rejectNextTokenRequest) {
          // Exactly what a revoked or rotated refresh token earns.
          return json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
        }
        return json({
          access_token: body.grant_type === "refresh_token" ? "refreshed-access" : "fresh-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "next-refresh",
        });
      }
      return json({ error: "not_found" }, 404);
    },
  });

  const mock: MockAs = {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        // Already stopped.
      }
    },
    get rejectNextTokenRequest(): boolean {
      return state.rejectNextTokenRequest;
    },
    set rejectNextTokenRequest(value: boolean) {
      state.rejectNextTokenRequest = value;
    },
  };
  running.push(mock);
  return mock;
}

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-oauth-int-"));
}

/**
 * The SDK's `auth`, loaded lazily.
 *
 * A static import here fails the repo-wide C0-2 boundary, which bans
 * top-level `@modelcontextprotocol/sdk` imports anywhere under `src/`
 * so the SDK never lands in keryx's cold start. A test file is not on
 * that path, but the rule is written repo-wide on purpose and the
 * scan has its own sentinel — exempting tests to spare one import
 * would weaken a boundary this file does not own.
 */
async function auth(provider: never, options: Record<string, unknown>): Promise<unknown> {
  const mod = await import("@modelcontextprotocol/sdk/client/auth.js");
  return await (mod as { auth: (p: never, o: unknown) => Promise<unknown> }).auth(provider, options);
}

function provider(as: MockAs, dir: string, over: Record<string, unknown> = {}) {
  return createOAuthProvider({
    serverName: "mock",
    serverUrl: as.url,
    configDir: dir,
    interactive: true,
    openBrowser: () => {},
    redirectUrl: "http://127.0.0.1:9999/callback",
    state: "the-state",
    ...over,
  });
}

const hit = (as: MockAs, pathname: string): number =>
  as.seen.filter((entry) => entry.path === pathname).length;

const VERIFIER = "verifier-abcdefghijklmnopqrstuvwxyz012345";

/**
 * The REAL two-leg flow, as `runOAuthFlow` performs it.
 *
 * Leg one discovers, registers if needed, and redirects — the SDK
 * signals that by throwing, which is its documented shape. Leg two
 * hands back the code. Collapsing them into one call fails with
 * "Existing OAuth client information is required", which is the SDK
 * telling you the sequence never happens that way.
 */
async function fullFlow(p: ReturnType<typeof provider>, serverUrl: string): Promise<void> {
  await auth(p as never, { serverUrl }).catch(() => undefined);
  p.saveCodeVerifier(VERIFIER);
  await auth(p as never, { serverUrl, authorizationCode: "the-code" });
}

describe("AC11 — dynamic registration happens only when there is no configured client", () => {
  test("with NO configured id, the client IS registered", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir), as.url);
    expect(hit(as, "/register")).toBe(1);
  });

  test("and the registered id is persisted for next time", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir), as.url);
    expect(readCredential("mock", as.url, dir).record?.client?.client_id).toBe("dynamically-registered");
  });

  test("with a configured id, NO registration request is made", async () => {
    // The criterion, asserted where it can actually be observed. An
    // operator who registered the client themselves does not want a
    // second one appearing in their authorisation server's list.
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir, { clientId: "configured-by-operator" }), as.url);
    expect(hit(as, "/register")).toBe(0);
  });

  test("and the configured id is the one sent to the token endpoint", async () => {
    // Not registering is half of it; using the right id is the half
    // that makes the exchange succeed.
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir, { clientId: "configured-by-operator" }), as.url);
    const exchange = as.seen.find((entry) => entry.path === "/token");
    expect(exchange?.body.client_id).toBe("configured-by-operator");
  });

  test("a stored registration is reused rather than registering again", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential("mock", as.url, { client: { client_id: "from-last-time" } }, dir);
    await fullFlow(provider(as, dir), as.url);
    expect(hit(as, "/register")).toBe(0);
  });

  test("the exchange stores a token, so the tests above are not passing on a no-op", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir), as.url);
    expect(readCredential("mock", as.url, dir).record?.tokens?.access_token).toBe("fresh-access");
  });

  test("and the PKCE verifier is sent — the exchange is not a bare code swap", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir), as.url);
    const exchange = as.seen.find((entry) => entry.path === "/token");
    expect(exchange?.body.code_verifier).toBe(VERIFIER);
  });
});

describe("the configured oauth fields actually reach the wire", () => {
  test("scopes are sent at registration", async () => {
    // Validated, typed, documented in the schema — and read by
    // nothing, so an operator provisioning a least-privilege token
    // silently received whatever the server hands out by default. A
    // token MORE powerful than the config asked for.
    const as = mockAuthorisationServer();
    const dir = store();
    await fullFlow(provider(as, dir, { scopes: ["read", "write"] }), as.url);
    const registration = as.seen.find((entry) => entry.path === "/register");
    expect(String(registration?.body.scope)).toBe("read write");
  });

  test("BOUNDARY — with no scopes configured, none is declared", async () => {
    const as = mockAuthorisationServer();
    await fullFlow(provider(as, store()), as.url);
    const registration = as.seen.find((entry) => entry.path === "/register");
    expect(registration?.body.scope).toBeUndefined();
  });
});

describe("AC12 — refresh, and what happens when it fails", () => {
  test("an expired access token with a refresh token is refreshed, with no browser", async () => {
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      {
        client: { client_id: "c" },
        tokens: { access_token: "stale", refresh_token: "r", expires_at: Date.now() - 1 },
      },
      dir,
    );
    let opened = 0;
    const p = provider(as, dir, { interactive: true, openBrowser: () => { opened++; } });
    await auth(p as never, { serverUrl: as.url });

    const refresh = as.seen.find((entry) => entry.body.grant_type === "refresh_token");
    expect(refresh).toBeDefined();
    expect(readCredential("mock", as.url, dir).record?.tokens?.access_token).toBe("refreshed-access");
    // The whole point of a refresh token: the operator is not involved.
    expect(opened).toBe(0);
  });

  test("a FAILED refresh degrades to needs_auth, not a crash", async () => {
    // The authorisation server revoked the grant. The SDK falls back to
    // starting a fresh authorisation; this process cannot ask a human,
    // so the provider refuses — and that refusal is a named type the
    // caller maps to `needs_auth`, rather than a stack trace.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      {
        client: { client_id: "c" },
        tokens: { access_token: "stale", refresh_token: "revoked", expires_at: Date.now() - 1 },
      },
      dir,
    );
    as.rejectNextTokenRequest = true;
    const p = provider(as, dir, { interactive: false, openBrowser: undefined });

    const error = await auth(p as never, { serverUrl: as.url }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // NOT OAuthInteractionRequiredError, which is what this test
    // asserted first. The SDK re-throws a client-side refresh failure
    // rather than falling back to the browser, so the provider's
    // headless gate is never reached — and the degradation to
    // `needs_auth` has to be made from the OAuth error itself.
    expect(error).toBeInstanceOf(Error);
    expect(needsAuthorisation(error)).toBe(true);
  });

  test("and a failed refresh does NOT make a silent unauthenticated call", async () => {
    // The worst degradation available: dropping the credential and
    // carrying on, so the operator's next request runs as nobody.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      {
        client: { client_id: "c" },
        tokens: { access_token: "stale", refresh_token: "revoked", expires_at: Date.now() - 1 },
      },
      dir,
    );
    as.rejectNextTokenRequest = true;
    const p = provider(as, dir, { interactive: false, openBrowser: undefined });
    await auth(p as never, { serverUrl: as.url }).catch(() => undefined);

    // It threw rather than returning a result a caller could read as
    // "carry on unauthenticated".
    const result = await auth(p as never, { serverUrl: as.url }).then(
      () => "returned",
      () => "threw",
    );
    expect(result).toBe("threw");
  });

  test("and the stored refresh token is not destroyed by the failure", async () => {
    // Deleting it would turn a recoverable state — the server may
    // un-revoke, or the failure may have been transient — into a
    // mandatory re-authorisation.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      {
        client: { client_id: "c" },
        tokens: { access_token: "stale", refresh_token: "revoked", expires_at: Date.now() - 1 },
      },
      dir,
    );
    as.rejectNextTokenRequest = true;
    const p = provider(as, dir, { interactive: false, openBrowser: undefined });
    await auth(p as never, { serverUrl: as.url }).catch(() => undefined);
    expect(readCredential("mock", as.url, dir).record?.tokens?.refresh_token).toBe("revoked");
  });

  test("BOUNDARY — a valid token with NO refresh token causes no token request", async () => {
    // Without a boundary the refresh tests pass for a provider that
    // asks for a new token unconditionally.
    //
    // The boundary is stated this way, and not as "a valid token is
    // not refreshed", because the mock showed `auth()` attempts a
    // refresh whenever a refresh token exists and never consults
    // expiry. Expiry is OUR `tokens()`'s question. Asserting the SDK
    // behaves otherwise would be a test of a belief.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      { client: { client_id: "c" }, tokens: { access_token: "good", expires_at: Date.now() + 600_000 } },
      dir,
    );
    await auth(provider(as, dir) as never, { serverUrl: as.url }).catch(() => undefined);
    expect(hit(as, "/token")).toBe(0);
  });

  test("an EXPIRED token with no refresh token is not sent anywhere either", async () => {
    // `tokens()` returns undefined for it, so there is nothing to
    // refresh and nothing to present — the flow goes to the browser.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      { client: { client_id: "c" }, tokens: { access_token: "stale", expires_at: Date.now() - 1 } },
      dir,
    );
    await auth(provider(as, dir) as never, { serverUrl: as.url }).catch(() => undefined);
    expect(as.seen.some((entry) => Object.values(entry.body).includes("stale"))).toBe(false);
  });

  test("a revoked grant is classified as needs_auth, not as a broken server", async () => {
    // The finding the mock produced. `auth()` does NOT fall back to a
    // fresh authorisation on a client-side refresh failure — it
    // re-throws — so `invalid_grant` arrived at the transport
    // unclassified and was reported as a connection failure, sending
    // the operator to debug a server that was working correctly.
    const as = mockAuthorisationServer();
    const dir = store();
    writeCredential(
      "mock",
      as.url,
      {
        client: { client_id: "c" },
        tokens: { access_token: "stale", refresh_token: "revoked", expires_at: Date.now() - 1 },
      },
      dir,
    );
    as.rejectNextTokenRequest = true;
    const error = await auth(provider(as, dir) as never, { serverUrl: as.url }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(needsAuthorisation(error)).toBe(true);
  });

  test("a non-object error does not crash the classifier", () => {
    // The guard in `oauthErrorCodeOf` survived being deleted AND
    // having its `||` flipped to `&&` (which can never be true, since
    // null IS typeof "object"). Both leave a property read on null.
    // Errors reach here from the SDK, the transport and fetch, and not
    // all of them are objects.
    expect(needsAuthorisation(null)).toBe(false);
    expect(needsAuthorisation(undefined)).toBe(false);
    expect(needsAuthorisation("invalid_grant")).toBe(false);
    expect(needsAuthorisation(401)).toBe(false);
  });

  test("and neither does an object whose errorCode is not a string", () => {
    expect(needsAuthorisation({ errorCode: 42 })).toBe(false);
    expect(needsAuthorisation({ errorCode: null })).toBe(false);
  });

  test("BOUNDARY — the authorisation server having a bad day is NOT needs_auth", async () => {
    // `server_error` is not fixed by re-authenticating: the same
    // endpoint would fail the same way, and keryx would have sent the
    // operator through a browser for nothing.
    const { ServerError } = await import("@modelcontextprotocol/sdk/server/auth/errors.js");
    expect(needsAuthorisation(new ServerError("upstream is down"))).toBe(false);
  });
});
