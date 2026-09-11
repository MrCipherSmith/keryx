// The OAuth provider — AC4, AC11, AC12, and the no-printing rule.
//
// The headless case is the one this file exists for. AC20 says
// `keryx mcp auth` in a non-TTY process must exit non-zero WITHOUT
// opening a browser and without hanging, and three different failures
// hide behind that sentence: opening a browser nobody sees, waiting
// for a click nobody will make, and reporting success with no token.
// Each is asserted separately, because a test that only checks the
// exit code passes for all three.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCredential, writeCredential } from "./credentials";
import { createOAuthProvider, OAuthInteractionRequiredError } from "./oauth-provider";

function store(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-oauth-"));
}

const NOW = 1_700_000_000_000;
const URL_ = "https://mcp.linear.app/mcp";

function provider(over: Partial<Parameters<typeof createOAuthProvider>[0]> = {}) {
  return createOAuthProvider({
    serverName: "linear",
    serverUrl: URL_,
    configDir: store(),
    interactive: true,
    now: () => NOW,
    ...over,
  });
}

describe("AC4 — headless refuses, and refuses in all three ways at once", () => {
  test("it throws rather than returning, so no caller can read it as success", async () => {
    const p = provider({ interactive: false });
    await expect(p.redirectToAuthorization(new URL("https://auth.test/authorize"))).rejects.toBeInstanceOf(
      OAuthInteractionRequiredError,
    );
  });

  test("the browser opener is NEVER called", async () => {
    // The assertion the exit code cannot make. A refusal that still
    // launched `xdg-open` on a headless box can block, or spawn
    // something that never exits.
    let opened = 0;
    const p = provider({ interactive: false, openBrowser: () => { opened++; } });
    await p.redirectToAuthorization(new URL("https://auth.test/authorize")).catch(() => undefined);
    expect(opened).toBe(0);
  });

  test("and it returns immediately rather than waiting", async () => {
    // A CI job that waits five minutes for a consent screen nobody
    // will click has turned a clear failure into a timeout, which is
    // the least diagnosable outcome available.
    const started = Date.now();
    await provider({ interactive: false })
      .redirectToAuthorization(new URL("https://auth.test/authorize"))
      .catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the error names the command that WOULD work", async () => {
    const error = await provider({ interactive: false })
      .redirectToAuthorization(new URL("https://auth.test/authorize"))
      .catch((e: unknown) => e);
    expect(String(error)).toContain("keryx mcp auth linear");
  });

  test("BOUNDARY — interactive with an opener DOES open the browser", async () => {
    // Without this, `redirectToAuthorization = () => { throw }` passes
    // every test above and OAuth never works for anybody.
    const opened: URL[] = [];
    const p = provider({ interactive: true, openBrowser: (url) => { opened.push(url); } });
    await p.redirectToAuthorization(new URL("https://auth.test/authorize?x=1"));
    expect(opened.map(String)).toEqual(["https://auth.test/authorize?x=1"]);
  });

  test("BOUNDARY — interactive WITHOUT an opener still refuses, rather than silently doing nothing", () => {
    // "Interactive" and "able to open a browser" are two facts. A
    // session with a TTY and no opener must not report success.
    const p = provider({ interactive: true });
    expect(p.redirectToAuthorization(new URL("https://auth.test/a"))).rejects.toBeInstanceOf(
      OAuthInteractionRequiredError,
    );
  });
});

describe("AC11 — dynamic registration only when there is no configured client", () => {
  test("a configured clientId is used and nothing is registered", () => {
    const p = provider({ clientId: "configured-id" });
    expect(p.clientInformation()).toEqual({ client_id: "configured-id" });
  });

  test("a configured id WINS over a previously registered one", () => {
    // An operator who registered the client themselves does not want
    // keryx quietly preferring a second one it created earlier.
    const dir = store();
    writeCredential("linear", URL_, { client: { client_id: "auto-registered" } }, dir);
    const p = provider({ configDir: dir, clientId: "configured-id" });
    expect(p.clientInformation()?.client_id).toBe("configured-id");
  });

  test("BOUNDARY — with no configured id, the stored registration is used", () => {
    const dir = store();
    writeCredential("linear", URL_, { client: { client_id: "auto-registered" } }, dir);
    expect(provider({ configDir: dir }).clientInformation()?.client_id).toBe("auto-registered");
  });

  test("and with neither, there is nothing — which is what triggers registration", () => {
    expect(provider().clientInformation()).toBeUndefined();
  });

  test("an empty clientId is treated as absent, not as a client named ''", () => {
    expect(provider({ clientId: "" }).clientInformation()).toBeUndefined();
  });
});

describe("AC12 — expiry and refresh", () => {
  test("an expired token with NO refresh token reads as no token", () => {
    // Handing it to the transport produces a 401 the operator reads as
    // the server being broken.
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: "old", expires_at: NOW - 1 } }, dir);
    expect(provider({ configDir: dir }).tokens()).toBeUndefined();
  });

  test("an expired token WITH one is still returned, so the SDK can refresh it", () => {
    const dir = store();
    writeCredential(
      "linear",
      URL_,
      { tokens: { access_token: "old", refresh_token: "r", expires_at: NOW - 1 } },
      dir,
    );
    expect(provider({ configDir: dir }).tokens()?.refresh_token).toBe("r");
  });

  test("BOUNDARY — a valid token is returned unchanged", () => {
    const dir = store();
    writeCredential("linear", URL_, { tokens: { access_token: "good", expires_at: NOW + 600_000 } }, dir);
    expect(provider({ configDir: dir }).tokens()?.access_token).toBe("good");
  });
});

describe("expires_in is resolved to an instant at the moment of issue", () => {
  test("a relative lifetime becomes an absolute expiry", () => {
    // Storing the relative value would make a token look valid
    // forever to whoever read the file later.
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t", expires_in: 3600 });
    expect(readCredential("linear", URL_, dir).record?.tokens?.expires_at).toBe(NOW + 3_600_000);
  });

  test("BOUNDARY — a token with no stated lifetime gets no expiry", () => {
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t" });
    expect(readCredential("linear", URL_, dir).record?.tokens?.expires_at).toBeUndefined();
  });

  test("token_type survives — it is what the transport puts in the header", () => {
    // The spread that carries it survived inversion: without it the
    // stored credential has no type, and a server expecting `Bearer`
    // gets something else or nothing.
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t", token_type: "Bearer" });
    expect(readCredential("linear", URL_, dir).record?.tokens?.token_type).toBe("Bearer");
  });

  test("and so does scope, which is what the operator actually granted", () => {
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t", scope: "read write" });
    expect(readCredential("linear", URL_, dir).record?.tokens?.scope).toBe("read write");
  });

  test("BOUNDARY — fields the server did not send are absent, not undefined-valued", () => {
    // The inverted spread stores `{token_type: undefined}`, which
    // round-trips through JSON as a MISSING key anyway — so the
    // assertion has to be on a token that HAS the field, above, not on
    // one that lacks it.
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t" });
    const stored = readCredential("linear", URL_, dir).record?.tokens;
    expect(stored?.access_token).toBe("t");
    expect(stored?.token_type).toBeUndefined();
  });

  test("and the refresh token survives the round trip", () => {
    const dir = store();
    provider({ configDir: dir }).saveTokens({ access_token: "t", refresh_token: "r" });
    expect(readCredential("linear", URL_, dir).record?.tokens?.refresh_token).toBe("r");
  });
});

describe("the state is the listener's, not the SDK's", () => {
  test("it is returned when a listener is running", () => {
    expect(provider({ state: "listener-state" }).state()).toBe("listener-state");
  });

  test("and refused when none is, rather than letting the SDK mint its own", () => {
    // A state the listener does not know is a flow that fails at the
    // last step for a reason nobody can see.
    expect(() => provider({ interactive: true }).state()).toThrow(/listener/);
  });

  test("a NON-interactive provider refuses here with the named type", () => {
    // The SDK calls `state()` before `redirectToAuthorization`, so the
    // headless gate has to be on this path too. It was not, and that
    // is why a session's refusal arrived as an unclassified Error:
    // `needsAuthorisation` said false and doctor reported "failed"
    // instead of "needs_auth". A gate is only a gate if it covers
    // every path to the thing it guards.
    expect(() => provider({ interactive: false }).state()).toThrow(OAuthInteractionRequiredError);
  });

  test("and a session refuses to REGISTER a client", () => {
    // Registration only happens while starting a new authorisation,
    // which a session may not do. Left unguarded, a shell starting up
    // created a client on the operator's authorisation server.
    expect(() => provider({ interactive: false }).saveClientInformation({ client_id: "x" })).toThrow(
      OAuthInteractionRequiredError,
    );
  });
});

describe("the PKCE verifier", () => {
  test("round-trips", () => {
    const dir = store();
    const p = provider({ configDir: dir });
    p.saveCodeVerifier("verifier-value");
    expect(p.codeVerifier()).toBe("verifier-value");
  });

  test("and its absence is an error naming why, not an empty string", () => {
    expect(() => provider().codeVerifier()).toThrow(/not started by this keryx/);
  });
});

describe("redirect_uris reflects whether a listener exists", () => {
  test("the loopback callback when one is running", () => {
    const p = provider({ redirectUrl: "http://127.0.0.1:5000/callback" });
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:5000/callback"]);
  });

  test("BOUNDARY — and empty when none is, rather than a stale or invented URI", () => {
    expect(provider().clientMetadata.redirect_uris).toEqual([]);
  });
});
